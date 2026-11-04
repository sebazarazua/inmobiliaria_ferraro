const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {uid,allSettings}=require('../../database');
const {reconcileOnClient}=require('../rent');
const {hash,LOCK}=require('../ipc/store');
const {inspectManagedFile}=require('../imports/document-admin');
const {extractPdfText}=require('../imports/contract-parser');
const {PROTECTED_FIELDS,proposedChanges}=require('./protection');
const secret=crypto.randomBytes(32),ACTOR={id:'local-operator',label:'Operador local; sin sesión de usuario autenticada'};
const normalizedText=text=>String(text||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const signature=value=>crypto.createHmac('sha256',secret).update(value).digest('base64url');
function issue(fingerprint){const body=Buffer.from(JSON.stringify({fingerprint,expires:Date.now()+30*60*1000})).toString('base64url');return `${body}.${signature(body)}`;}
function verify(token,fingerprint){
  try{const [body,mac,...rest]=String(token||'').split('.');if(rest.length||!mac||Buffer.byteLength(mac)!==Buffer.byteLength(signature(body))||!crypto.timingSafeEqual(Buffer.from(mac),Buffer.from(signature(body))))throw Error();const data=JSON.parse(Buffer.from(body,'base64url'));if(data.fingerprint!==fingerprint||data.expires<Date.now())throw Error();}
  catch{throw new Error('La simulación falta, venció o cambió. Volvé a simular la rectificación.');}
}
async function protection(db,id){
  const contract=(await db.query('SELECT * FROM contracts WHERE id=$1',[id])).rows[0];if(!contract)throw new Error('Contrato no encontrado.');
  const document=contract.source_document_id?(await db.query('SELECT id,filename,sha256,absolute_path,contract_id FROM documents WHERE id=$1',[contract.source_document_id])).rows[0]:null;
  let available=false;
  if(document){try{const root=fs.realpathSync(path.resolve((await allSettings(db)).import_directory));const file=inspectManagedFile(root,document.absolute_path);available=file.managed&&file.exists;}catch{}}
  const history=(await db.query("SELECT id,action,created_at,details_json FROM audit_log WHERE entity_type='contract' AND entity_id=$1 AND action IN ('contract_rectified','administrative_updated') ORDER BY created_at DESC,id DESC",[id])).rows;
  return{contract,protectedFields:PROTECTED_FIELDS,document:document?{id:document.id,filename:document.filename,available}:null,administrative_note:history.find(r=>r.action==='administrative_updated')?.details_json.administrative_note||'',history:history.filter(r=>r.action==='contract_rectified'),actor:ACTOR,adenda_supported:false};
}
async function evidence(client,contract,input){
  if(input.operation!=='original_document_correction')throw new Error('Una adenda o condición nueva no es una rectificación. La modificación contractual por adenda no está habilitada.');
  if(['reason','document_reference','document_quote'].some(field=>typeof input[field]!=='string'))throw new Error('Motivo, referencia y fragmento deben ser texto del documento original.');
  if(String(input.reason||'').trim().length<10||String(input.document_reference||'').trim().length<3)throw new Error('Indicá motivo y referencia a la cláusula del contrato original.');
  if(!contract.source_document_id||input.document_id!==contract.source_document_id)throw new Error('Falta evidencia del documento original asociado al contrato. Un adjunto posterior no autoriza una rectificación.');
  const document=(await client.query('SELECT * FROM documents WHERE id=$1 FOR SHARE',[contract.source_document_id])).rows[0];
  if(!document||document.contract_id!==contract.id)throw new Error('El documento original no está vinculado correctamente a este contrato.');
  let root;try{root=fs.realpathSync(path.resolve((await allSettings(client)).import_directory));}catch{throw new Error('No se encuentra la carpeta del documento original.');}
  const file=inspectManagedFile(root,document.absolute_path);if(!file.managed||!file.exists)throw new Error('El PDF original no está disponible para verificar la rectificación.');
  const sha=crypto.createHash('sha256').update(fs.readFileSync(file.path)).digest('hex');if(sha!==document.sha256)throw new Error('El PDF original cambió. La evidencia debe revisarse antes de rectificar.');
  const quote=normalizedText(input.document_quote);if(quote.length<20)throw new Error('Transcribí un fragmento suficiente de la cláusula original (al menos 20 caracteres).');
  const text=await extractPdfText(file.path);if(!normalizedText(text).includes(quote))throw new Error('El fragmento indicado no se encuentra en el PDF original. Revisá la evidencia.');
  return{id:document.id,filename:document.filename,sha256:sha,reference:String(input.document_reference).trim(),quote:String(input.document_quote).trim()};
}
// Verify concrete proposed values against the cited original fragment. This is a
// conservative evidence check, not a legal interpretation or another rent engine.
function checkProposedEvidence(contract,changes,proof){
  const text=normalizedText(proof.quote),frequency=new Set();
  for(const [word,value] of [['mensual',1],['bimestral',2],['trimestral',3],['cuatrimestral',4],['semestral',6],['anual',12]])if(new RegExp(`\\b(?:ipc|actualizacion|ajuste|aumento|actualizara|ajustara|incremento|periodicidad|frecuencia)s?\\b.{0,60}\\b${word}(?:mente)?\\b`).test(text))frequency.add(value);
  const words={un:1,uno:1,dos:2,tres:3,cuatro:4,cinco:5,seis:6,siete:7,ocho:8,nueve:9,diez:10,once:11,doce:12};
  for(const match of text.matchAll(/(?:cada|frecuencia de) (\d+|un|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce) mes(?:es)?/g))frequency.add(words[match[1]]||Number(match[1]));
  if(Object.hasOwn(changes,'adjustment_frequency_months')&&!frequency.has(changes.adjustment_frequency_months))throw new Error('La frecuencia propuesta no está respaldada por el fragmento del documento original.');
  if(Object.hasOwn(changes,'initial_amount')){
    const {scaled}=require('../../lib/money');
    const numbers=(proof.quote.match(/\d+(?:[.,]\d+)*/g)||[]).map(raw=>raw.includes(',')?raw.replace(/\./g,'').replace(',','.'): /\.\d{3}(?:\.|$)/.test(raw)?raw.replace(/\./g,''):raw);
    if(!numbers.some(value=>{try{return scaled(value)===scaled(changes.initial_amount);}catch{return false;}}))throw new Error('El canon inicial propuesto no figura como importe en el fragmento original.');
  }
  const afterIndex=Object.hasOwn(changes,'adjustment_index')?changes.adjustment_index:contract.adjustment_index;
  if((Object.hasOwn(changes,'adjustment_index')||Object.hasOwn(changes,'adjustment_type'))&&afterIndex==='IPC'&&!/\bipc\b|indice de precios al consumidor/.test(text))throw new Error('El mecanismo IPC propuesto no está respaldado por el fragmento original.');
  if(Object.hasOwn(changes,'ipc_lag_months')){
    const lag=Math.max(1,Number(changes.ipc_lag_months));
    const supported=[...text.matchAll(/(\d+|un|uno|dos|tres|cuatro) mes(?:es)? (?:de )?(?:rezago|atraso)/g)].map(m=>words[m[1]]||Number(m[1]));
    for(const match of text.matchAll(/(?:rezago|atraso)(?: de)? (\d+|un|uno|dos|tres|cuatro) mes(?:es)?/g))supported.push(words[match[1]]||Number(match[1]));
    if(/\bmes anterior\b/.test(text))supported.push(1);
    if(/\bdos meses anteriores\b/.test(text))supported.push(2);
    if(!supported.includes(lag))throw new Error('El rezago propuesto requiere una referencia explícita y suficiente en el fragmento original.');
  }
  if(changes.ipc_clause_text&&!text.includes(normalizedText(changes.ipc_clause_text)))throw new Error('La cláusula propuesta debe corresponder al fragmento verificado del documento original.');
}
async function snapshot(client,id){
  const installments=(await client.query('SELECT * FROM installments WHERE contract_id=$1 ORDER BY id',[id])).rows;
  const payments=(await client.query('SELECT p.* FROM payments p JOIN installments i ON i.id=p.installment_id WHERE i.contract_id=$1 ORDER BY p.id',[id])).rows;
  const ledger=(await client.query('SELECT * FROM ledger_entries WHERE contract_id=$1 ORDER BY id',[id])).rows;
  const versions=(await client.query("SELECT id,details_json FROM audit_log WHERE entity_type='contract' AND entity_id=$1 AND action='contract_rectified' ORDER BY id",[id])).rows;
  return{installments,payments,ledger,versions};
}
const supported=new Set(['initial_amount','adjustment_type','adjustment_index','adjustment_frequency_months','ipc_lag_months','ipc_clause_text','ipc_clause_review_required','start_date','end_date','duration_months']);
async function plan(client,contract,changes){
  const blocked=[];
  if((changes.adjustment_index??contract.adjustment_index)!=='IPC'||changes.adjustment_index===null)blocked.push({error:'El motor actual solo permite simular automáticamente rectificaciones IPC. Los mecanismos manuales requieren una revisión posterior fuera de esta operación.'});
  if(Object.keys(changes).some(field=>!supported.has(field)))blocked.push({error:'La rectificación incluye moneda, vencimientos, partes u otras condiciones cuyo impacto no puede simularse íntegramente con el motor actual.'});
  const type=changes.adjustment_type??contract.adjustment_type;if(type&&type!=='IPC')blocked.push({error:'El mecanismo y el índice propuestos deben ser coherentes.'});
  if(blocked.length)return{mode:'simulation',count:0,changed:0,rows:[],blocked};
  const keys=Object.keys(changes);await client.query('SAVEPOINT rectification_preview');
  try{
    await client.query(`UPDATE contracts SET ${keys.map((k,i)=>`${k}=$${i+1}`).join(',')} WHERE id=$${keys.length+1}`,[...keys.map(k=>changes[k]),contract.id]);
    const result=await reconcileOnClient(client,{contractId:contract.id});
    // Date/duration changes cannot silently add, remove or reinterpret installments.
    if(['start_date','end_date','duration_months'].some(k=>Object.hasOwn(changes,k)))result.blocked.push({error:'Cambiar la vigencia requiere revisar el cronograma documental; esta operación no crea ni sustituye cuotas.'});
    return result;
  }finally{await client.query('ROLLBACK TO SAVEPOINT rectification_preview');await client.query('RELEASE SAVEPOINT rectification_preview');}
}
async function rectify(db,id,input,{apply=false}={}){
  const client=await db.connect();
  try{
    await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[LOCK]);
    const contract=(await client.query('SELECT * FROM contracts WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!contract)throw new Error('Contrato no encontrado.');
    const proof=await evidence(client,contract,input),changes=proposedChanges(contract,input.changes),before=await snapshot(client,id);
    checkProposedEvidence(contract,changes,proof);
    const impact=await plan(client,contract,changes);
    const fingerprint=hash({contract,changes,proof,reason:String(input.reason).trim(),before,impact,operation:input.operation});
    const comparison=Object.keys(changes).map(field=>({field,before:contract[field],proposed:changes[field]}));
    if(!apply){await client.query('ROLLBACK');return{...impact,token:issue(fingerprint),comparison,evidence:proof,actor:ACTOR};}
    if(input.confirm!==true)throw new Error('Confirmá explícitamente la rectificación revisada.');
    verify(input.token,fingerprint);if(impact.blocked.length)throw new Error('La simulación está bloqueada. No se modificaron el contrato ni las cuotas.');
    const keys=Object.keys(changes);await client.query(`UPDATE contracts SET ${keys.map((k,i)=>`${k}=$${i+1}`).join(',')},updated_at=now() WHERE id=$${keys.length+1}`,[...keys.map(k=>changes[k]),id]);
    const result=await reconcileOnClient(client,{contractId:id,apply:true,token:impact.token,reason:`Rectificación documental: ${String(input.reason).trim()}`,interpretationConfirmed:true});
    if(result.blocked.length)throw new Error('La simulación está bloqueada.');
    const version=before.versions.length+1;
    await client.query('INSERT INTO audit_log(id,entity_type,entity_id,action,details_json) VALUES($1,$2,$3,$4,$5)',[uid(),'contract',id,'contract_rectified',{version,actor:ACTOR,operation:input.operation,reason:String(input.reason).trim(),evidence:proof,before:Object.fromEntries(PROTECTED_FIELDS.map(k=>[k,contract[k]])),changes,comparison,affected_installments:impact.rows.filter(r=>r.changed||r.legacy).map(r=>r.id),reconciliation:{count:result.count,changed:result.changed}}]);
    await client.query('COMMIT');return{status:'rectified',version,changed:result.changed,id};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
module.exports={protection,rectify};
