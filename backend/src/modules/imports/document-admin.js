// Administrador de documentos e importaciones: une lo que hay en la carpeta de contratos con los registros
// de imports/documents y expone operaciones explícitas. Las rutas nunca llegan desde el frontend: cada operación
// recibe una referencia (id de importación, id de documento o nombre de archivo de la carpeta administrada).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { allSettings, uid } = require('../../database');
const { importPdf, withImportLock } = require('./contract-parser');

const STATE_LABELS = {
  pending: 'Pendiente',
  review: 'En revisión',
  imported: 'Importado',
  duplicate: 'Omitido por duplicado',
  discarded: 'Descartado',
  failed: 'Fallido',
  contract_deleted: 'Contrato eliminado',
  excluded: 'Excluido'
};
const IMPORT_STATUS_LABELS = { Procesado:'Importado', 'Revisión':'En revisión', Error:'Fallido', Omitido:'Omitido', Descartado:'Descartado', Revertido:'Contrato eliminado' };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const hashFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const completion = row => row.result_json?.completion_result || row.result_json?.completionResult || {};
// audit_log.entity_id es uuid: un archivo sin registros se identifica por los primeros 128 bits de su hash.
const shaUuid = sha => `${sha.slice(0,8)}-${sha.slice(8,12)}-${sha.slice(12,16)}-${sha.slice(16,20)}-${sha.slice(20,32)}`;
const audit = (db, entityId, action, details) => db.query('INSERT INTO audit_log(id,entity_type,entity_id,action,details_json) VALUES ($1,$2,$3,$4,$5)',[uid(),'document_file',entityId,action,details]);

function managedRoot(directory) {
  try { return fs.realpathSync.native(directory); } catch { return null; }
}

// Un archivo es administrable solo si es un PDF regular (no un enlace simbólico) cuya ruta canónica
// está directamente dentro de la carpeta de contratos configurada.
function inspectManagedFile(root, candidate) {
  let stat;
  try { stat = fs.lstatSync(candidate); } catch { return { exists:false, managed:false, problem:'El PDF ya no está en la carpeta de contratos.' }; }
  if (stat.isSymbolicLink()) return { exists:true, managed:false, problem:'Es un acceso directo (enlace simbólico): por seguridad el sistema no lo abre ni lo borra.' };
  if (!stat.isFile()) return { exists:false, managed:false, problem:'La ruta registrada no corresponde a un archivo.' };
  let real;
  try { real = fs.realpathSync.native(candidate); } catch { return { exists:false, managed:false, problem:'El PDF ya no está en la carpeta de contratos.' }; }
  if (!root || path.dirname(real) !== root) return { exists:true, managed:false, problem:'El archivo está fuera de la carpeta de contratos que administra el sistema.' };
  if (path.extname(real).toLowerCase() !== '.pdf') return { exists:true, managed:false, problem:'Solo se administran archivos PDF.' };
  return { exists:true, managed:true, path:real };
}

async function collectEntries(db) {
  const directory = path.resolve((await allSettings(db)).import_directory), root = managedRoot(directory);
  const imports = (await db.query(`SELECT id,filename,absolute_path,sha256,status,confidence::float,error_message,result_json,previous_import_id,created_at FROM imports ORDER BY created_at`)).rows;
  const documents = (await db.query(`SELECT d.id,d.filename,d.absolute_path,d.sha256,c.id contract_id,d.imported_at,c.code contract_code,c.alias contract_alias,c.status contract_status,p.address property
    FROM documents d LEFT JOIN contracts c ON c.id=d.contract_id OR c.source_document_id=d.id LEFT JOIN properties p ON p.id=d.property_id ORDER BY d.imported_at`)).rows;
  const exclusions = new Map((await db.query('SELECT sha256,reason,created_at FROM import_exclusions')).rows.map(row => [row.sha256, row]));
  const contractIds = [...new Set(imports.map(row => completion(row).contractId).filter(id => UUID_PATTERN.test(String(id || ''))))];
  const contracts = new Map((await db.query('SELECT id,code,alias,status FROM contracts WHERE id=ANY($1::uuid[])',[contractIds])).rows.map(row => [row.id, row]));

  const entries = new Map();
  const entry = key => { if (!entries.has(key)) entries.set(key, { key, imports:[], document:null, diskName:null, diskSha:null }); return entries.get(key); };
  for (const row of imports) if (row.absolute_path) entry(path.resolve(row.absolute_path)).imports.push(row);
  for (const document of documents) entry(path.resolve(document.absolute_path)).document = document;
  if (root) for (const dirent of fs.readdirSync(directory, { withFileTypes:true })) {
    if (!dirent.isFile() || path.extname(dirent.name).toLowerCase() !== '.pdf') continue;
    const item = entry(path.join(directory, dirent.name));
    item.diskName = dirent.name;
    try { item.diskSha = hashFile(item.key); } catch { item.diskSha = null; }
  }

  const latestOf = item => [...item.imports].reverse().find(row => row.status !== 'Omitido') || null;
  const shaOf = item => item.document?.sha256 || latestOf(item)?.sha256 || item.diskSha;
  const directContractOf = item => {
    if (item.document?.contract_id) return { id:item.document.contract_id, code:item.document.contract_code, alias:item.document.contract_alias, status:item.document.contract_status };
    return [...item.imports].reverse().map(row=>contracts.get(completion(row).contractId)).find(Boolean)||null;
  };
  const contractsBySha=new Map(),filesBySha=new Map();
  for(const item of entries.values()){
    const linked=directContractOf(item),sha=shaOf(item);
    if(linked&&sha)contractsBySha.set(sha,linked);
    if(item.diskSha)filesBySha.set(item.diskSha,item.key);
  }
  const contractOf=item=>directContractOf(item)||((item.document||item.imports.length)?contractsBySha.get(shaOf(item))||null:null);
  // El "original" de cada contenido es la entrada con registros (preferentemente con contrato); el resto son copias.
  const originals = new Map();
  for (const item of [...entries.values()].filter(item => item.document || latestOf(item)).sort((a, b) => Number(Boolean(contractOf(b))) - Number(Boolean(contractOf(a))))) {
    const sha = shaOf(item);
    if (sha && !originals.has(sha)) originals.set(sha, item);
  }

  const list = [...entries.values()].map(item => describe(item, { root, exclusions, originals, latestOf, shaOf, contractOf, filesBySha }));
  list.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const counts = Object.fromEntries(Object.keys(STATE_LABELS).map(state => [state, list.filter(item => item.state === state).length]));
  return { directory, managed: Boolean(root), entries:list, counts, labels:STATE_LABELS };
}

function describe(item, ctx) {
  const latest = ctx.latestOf(item), sha = ctx.shaOf(item), contract = ctx.contractOf(item), excluded = ctx.exclusions.get(sha);
  const original = ctx.originals.get(sha), hasRecords = Boolean(item.document || item.imports.length);
  let state, reason;
  if (contract) { state = 'imported'; reason = `Ya existe un contrato asociado a este documento (${contract.alias || contract.code}).`; }
  else if (excluded) { state = 'excluded'; reason = `Excluido de las importaciones automáticas${excluded.reason ? `: ${excluded.reason}` : ''}.`; }
  else if (!hasRecords && original && original !== item) {
    state = 'duplicate';
    const originalContract = ctx.contractOf(original), originalName = original.document?.filename || ctx.latestOf(original)?.filename || path.basename(original.key);
    reason = originalContract
      ? `Ya existe un contrato asociado a este documento (${originalContract.alias || originalContract.code}). Este archivo es una copia de «${originalName}» y no se vuelve a importar.`
      : `Este archivo es una copia de «${originalName}», que ya está registrado. Gestioná el original o borrá esta copia.`;
  }
  else if (latest?.status === 'Revisión') { state = 'review'; reason = 'Espera que completes o confirmes los datos en Importaciones.'; }
  else if (['Revertido','Procesado'].includes(latest?.status) || item.document) { state = 'contract_deleted'; reason = 'El contrato creado con este documento fue eliminado. El documento se conserva y podés volver a importarlo.'; }
  else if (latest?.status === 'Error') { state = 'failed'; reason = `La lectura falló: ${latest.error_message || 'error desconocido'}.`; }
  else if (latest?.status === 'Descartado') { state = 'discarded'; reason = `Se descartó la importación${latest.result_json?.discard_reason ? ` (${latest.result_json.discard_reason})` : ''}. Podés volver a importarlo.`; }
  else if (latest || item.document) { state = 'contract_deleted'; reason = 'El contrato creado con este documento fue eliminado. El documento se conserva y podés volver a importarlo.'; }
  else { state = 'pending'; reason = 'Está en la carpeta y todavía no se importó.'; }

  const file = inspectManagedFile(ctx.root, item.key), actions = [], blocked = {};
  if (file.exists && file.managed) actions.push('view');
  if (contract) actions.push('open_contract');
  if (state === 'review') actions.push('review');
  if (['pending','failed','discarded','contract_deleted'].includes(state)) {
    const retryFile=inspectManagedFile(ctx.root,ctx.filesBySha.get(sha)||item.key);
    if ((file.exists && file.managed)||(retryFile.exists&&retryFile.managed)) actions.push('reprocess');
    else blocked.reprocess = file.problem;
  }
  if (sha && ['pending','failed','discarded','contract_deleted','duplicate'].includes(state)) actions.push('exclude');
  if (state === 'excluded') actions.push('unexclude');
  if (hasRecords && ['failed','discarded','contract_deleted','excluded'].includes(state) && latest?.status !== 'Revisión') actions.push('delete_record');
  if (file.exists) {
    if (!file.managed) blocked.delete_file = file.problem;
    else if (contract) blocked.delete_file = `Es el respaldo del contrato ${contract.alias || contract.code}: no se puede borrar del equipo mientras el contrato exista.`;
    else if (state === 'review') blocked.delete_file = 'Está en revisión: descartá la importación antes de borrar el archivo.';
    else actions.push('delete_file');
  }

  const ref = latest ? { import_id:latest.id } : item.document ? { document_id:item.document.id } : item.imports.length ? { import_id:item.imports.at(-1).id } : { file:item.diskName };
  return {
    id: ref.import_id || ref.document_id || `file:${item.diskName}`,
    ref,
    filename: item.document?.filename || latest?.filename || item.imports.at(-1)?.filename || item.diskName || path.basename(item.key),
    absolute_path: item.key,
    sha256: sha || null,
    state,
    state_label: STATE_LABELS[state],
    reason,
    contract: contract || null,
    property: item.document?.property || null,
    document_id: item.document?.id || null,
    import_ids: item.imports.map(row => row.id),
    date: latest?.created_at || item.document?.imported_at || item.imports.at(-1)?.created_at || null,
    file_exists: file.exists,
    file_managed: file.managed,
    file_problem: file.managed ? null : file.problem,
    excluded: Boolean(excluded),
    actions,
    blocked,
    history: [...item.imports].reverse().map(row => ({
      id: row.id, status: row.status, label: IMPORT_STATUS_LABELS[row.status] || row.status, created_at: row.created_at, previous_import_id: row.previous_import_id,
      detail: row.error_message || row.result_json?.delete_reason || row.result_json?.revert_reason || row.result_json?.discard_reason || (row.result_json?.file_deleted_at ? 'PDF eliminado del equipo' : null)
    })),
    disk_name: item.diskName
  };
}

async function findEntry(db, ref = {}) {
  const listing = await collectEntries(db);
  const file = ref.file == null ? null : String(ref.file);
  if (file !== null && (file !== path.basename(file) || file.includes('..') || file.includes('\0'))) throw new Error('Referencia de archivo inválida.');
  const match = listing.entries.find(entry =>
    (ref.import_id && entry.import_ids.includes(ref.import_id)) ||
    (ref.document_id && entry.document_id === ref.document_id) ||
    (file && entry.disk_name === file));
  if (!match) throw new Error('No encontramos ese documento. Actualizá la lista e intentá de nuevo.');
  return { entry:match, listing };
}

function requireAction(entry, action) {
  if (!entry.actions.includes(action)) throw new Error(entry.blocked[action] || `Esta acción no está disponible para un documento en estado «${entry.state_label}».`);
}
const entityId = entry => entry.import_ids.at(-1) || entry.document_id || (entry.sha256 ? shaUuid(entry.sha256) : uid());
const requireConfirm = input => { if (input.confirm !== true && input.confirm !== 'true') throw new Error('Confirmá la operación: no se puede deshacer.'); };
// Operaciones destructivas: se vuelve a calcular la entrada con el lock del contenido tomado.
async function underLock(db, ref, work) {
  const { entry } = await findEntry(db, ref);
  return withImportLock(db, entry.sha256 || entry.absolute_path, async scoped => work((await findEntry(scoped, ref)).entry,scoped));
}

async function reprocess(db, input) {
  const { entry,listing } = await findEntry(db, input.ref);
  requireAction(entry, 'reprocess');
  if(entry.state==='contract_deleted' && input.confirm!==true)throw new Error('Confirmá que querés volver a analizar el documento del contrato eliminado.');
  const available=entry.file_exists&&entry.file_managed?entry:listing.entries.find(item=>item.sha256===entry.sha256&&item.file_exists&&item.file_managed);
  if(!available)throw new Error('Volvé a subir el PDF antes de reintentar la importación.');
  if(hashFile(available.absolute_path)!==entry.sha256)throw new Error('El contenido del archivo cambió. Actualizá y revisá el documento.');
  const result = await importPdf(db, available.absolute_path, { mode:'manual', confirmReimport:input.confirm===true, expectedPreviousImportId:entry.ref.import_id || null });
  if (['Omitido','Confirmación requerida'].includes(result.status)) throw new Error(result.reason);
  await audit(db, entityId(entry), 'reprocessed', { filename:entry.filename, previous_state:entry.state, new_import_id:result.id, result_status:result.status });
  return result;
}

async function exclude(db, input) {
  return underLock(db,input.ref,async(entry,db)=>{
    requireAction(entry, 'exclude');
    const reason = String(input.reason || '').trim() || 'Excluido manualmente';
    await db.query('INSERT INTO import_exclusions(sha256,filename,absolute_path,reason) VALUES ($1,$2,$3,$4) ON CONFLICT (sha256) DO NOTHING',[entry.sha256, entry.filename, entry.absolute_path, reason]);
    await audit(db, entityId(entry), 'excluded', { filename:entry.filename, sha256:entry.sha256, reason });
    return { excluded:true, filename:entry.filename };
  });
}

async function unexclude(db, input) {
  return underLock(db,input.ref,async(entry,db)=>{
    requireAction(entry, 'unexclude');
    await db.query('DELETE FROM import_exclusions WHERE sha256=$1',[entry.sha256]);
    await audit(db, entityId(entry), 'unexcluded', { filename:entry.filename, sha256:entry.sha256 });
    return { excluded:false, filename:entry.filename };
  });
}

// "Quitar de la lista": borra los registros de importación y el documento sin contrato. El archivo físico no se
// toca; si sigue en la carpeta queda excluido para que el scanner no lo vuelva a importar solo.
async function deleteRecord(db, input) {
  requireConfirm(input);
  return underLock(db, input.ref, async(entry,db) => {
    requireAction(entry, 'delete_record');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const removedImports = (await client.query(`DELETE FROM imports WHERE id=ANY($1::uuid[]) AND status<>'Revisión' RETURNING id,status,filename,created_at`,[entry.import_ids])).rows;
      const removedDocuments = entry.document_id ? (await client.query('DELETE FROM documents WHERE id=$1 AND contract_id IS NULL RETURNING id,filename',[entry.document_id])).rows : [];
      let excluded = false;
      if (entry.file_exists && entry.sha256) {
        excluded = (await client.query('INSERT INTO import_exclusions(sha256,filename,absolute_path,reason) VALUES ($1,$2,$3,$4) ON CONFLICT (sha256) DO NOTHING',[entry.sha256, entry.filename, entry.absolute_path, 'Quitado de la lista: no volver a importar automáticamente'])).rowCount > 0 || entry.excluded;
      }
      await audit(client, entityId(entry), 'record_deleted', { filename:entry.filename, sha256:entry.sha256, previous_state:entry.state, imports:removedImports, documents:removedDocuments, excluded });
      await client.query('COMMIT');
      return { removed:{ imports:removedImports.length, documents:removedDocuments.length }, excluded, filename:entry.filename };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  });
}

// "Eliminar PDF del equipo": solo archivos de la carpeta administrada que no respaldan un contrato existente.
async function deleteFile(db, input) {
  requireConfirm(input);
  return underLock(db, input.ref, async(entry,db) => {
    if (!entry.file_exists) return { deleted:true, alreadyDeleted:true, filename:entry.filename };
    requireAction(entry, 'delete_file');
    const root = managedRoot(path.resolve((await allSettings(db)).import_directory)), file = inspectManagedFile(root, entry.absolute_path);
    if (!file.managed) throw new Error(file.problem);
    const linked = (await db.query(`SELECT c.code,c.alias FROM documents d JOIN contracts c ON c.id=d.contract_id WHERE d.absolute_path=ANY($1::text[]) LIMIT 1`,[[entry.absolute_path, file.path]])).rows[0];
    if (linked) throw new Error(`Es el respaldo del contrato ${linked.alias || linked.code}: no se puede borrar del equipo mientras el contrato exista.`);
    if (entry.sha256 && hashFile(file.path) !== entry.sha256) throw new Error('El contenido del archivo cambió desde la última lectura. Actualizá la lista antes de borrarlo.');
    fs.unlinkSync(file.path);
    await db.query(`UPDATE imports SET result_json=COALESCE(result_json,'{}'::jsonb) || $2::jsonb WHERE id=ANY($1::uuid[])`,[entry.import_ids, JSON.stringify({ file_deleted_at:new Date().toISOString() })]);
    await audit(db, entityId(entry), 'file_deleted', { filename:entry.filename, absolute_path:file.path, sha256:entry.sha256, previous_state:entry.state, reason:String(input.reason || '').trim() || null });
    return { deleted:true, filename:entry.filename };
  });
}

async function streamFile(db, res, ref, json) {
  const { entry } = await findEntry(db, ref);
  requireAction(entry, 'view');
  const root = managedRoot(path.resolve((await allSettings(db)).import_directory)), file = inspectManagedFile(root, entry.absolute_path);
  if (!file.managed) return json(res, 400, { error:file.problem });
  res.writeHead(200, { 'Content-Type':'application/pdf', 'Content-Disposition':`inline; filename*=UTF-8''${encodeURIComponent(entry.filename)}`, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' });
  fs.createReadStream(file.path).pipe(res);
}

const OPERATIONS = { reprocess, exclude, unexclude, 'delete-record':deleteRecord, 'delete-file':deleteFile };

async function handleDocumentAdminApi(db, req, res, operation, { json, readBody }) {
  try {
    if (!operation && req.method === 'GET') return json(res, 200, await collectEntries(db));
    if (operation === 'file' && req.method === 'GET') {
      const params = new URL(req.url, 'http://localhost').searchParams;
      return await streamFile(db, res, { import_id:params.get('import_id'), document_id:params.get('document_id'), file:params.get('file') }, json);
    }
    if (OPERATIONS[operation] && req.method === 'POST') {
      const input = await readBody(req);
      if (!input.ref || typeof input.ref !== 'object') throw new Error('Falta indicar el documento.');
      return json(res, 200, await OPERATIONS[operation](db, input));
    }
    return json(res, 404, { error:'Ruta inexistente.' });
  } catch (error) { return json(res, 400, { error:error.message }); }
}

module.exports = { collectEntries, handleDocumentAdminApi, inspectManagedFile, STATE_LABELS };
