// Diagnostic only. This module never opens the application, migrates, seeds or registers a database.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Pool}=require('pg');
const {spawnSync}=require('node:child_process');
const E=require('./environment'),M=require('./migrations');
const {snapshot,hashRows,quote}=require('./snapshot');
const {balance,scaled,decimal}=require('../lib/money');
const hash=value=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const sorted=rows=>rows.sort((a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:JSON.stringify(a)>JSON.stringify(b)?1:0);
const safeState=value=>['Activo','Revisión','Borrador','Finalizado','Rescindido','Renovado','Anulado','Archivado','Pendiente','Parcial','Pagado','Vencido','Sustituido','Confirmado'].includes(value)?value:'otro';
function pathKind(value,platform=process.platform){
  if(typeof value!=='string'||!value)return 'missing';
  if(/^[A-Za-z]:[\\/]|^\\\\/.test(value))return platform==='win32'?'native_absolute':'foreign_absolute';
  if(value.startsWith('/'))return platform==='win32'?'foreign_absolute':'native_absolute';
  return 'relative';
}
function fileLocation(value,platform=process.platform){
  const kind=pathKind(value,platform);if(['missing','foreign_absolute'].includes(kind))return{kind,exists:false};
  try{const stat=fs.statSync(value);return{kind,exists:true,directory:stat.isDirectory()};}catch{return{kind,exists:false};}
}
async function hashFile(file){const h=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))h.update(chunk);return h.digest('hex');}
function schemaSection(rows){const objects=sorted(rows.map(({definition,...r})=>({...r,...(definition===undefined?{}:{definition_sha256:definition===null?null:hash(definition)})})));return{count:objects.length,sha256:hash(objects),objects};}
async function catalog(client){
  const sections={
    columns:`SELECT c.relname table_name,a.attname column_name,a.attnum position,format_type(a.atttypid,a.atttypmod) data_type,a.attnotnull not_null,a.attidentity identity,a.attgenerated generated,pg_get_expr(d.adbin,d.adrelid) definition FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m') AND a.attnum>0 AND NOT a.attisdropped`,
    constraints:`SELECT c.relname table_name,k.conname name,k.contype type,k.convalidated validated,k.condeferrable deferrable,k.condeferred initially_deferred,pg_get_constraintdef(k.oid) definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'`,
    indexes:`SELECT c.relname table_name,i.relname name,x.indisunique is_unique,x.indisprimary is_primary,x.indisvalid valid,x.indisready ready,pg_get_indexdef(i.oid) definition FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_class c ON c.oid=x.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'`,
    triggers:`SELECT c.relname table_name,t.tgname name,t.tgenabled enabled,t.tgisinternal internal,pg_get_triggerdef(t.oid) definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'`,
    functions:`SELECT p.proname name,pg_get_function_identity_arguments(p.oid) arguments,p.provolatile volatility,pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'`,
    views:`SELECT viewname name,definition FROM pg_views WHERE schemaname='public'`,
    sequences:`SELECT c.relname name,s.seqstart::text start,s.seqincrement::text increment,s.seqmin::text minimum,s.seqmax::text maximum,s.seqcache::text cache,s.seqcycle cycle FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'`
  };
  const result={};for(const [name,sql] of Object.entries(sections))result[name]=schemaSection((await client.query(sql)).rows);
  result.sha256=hash(Object.fromEntries(Object.entries(result).map(([k,v])=>[k,v.sha256])));return result;
}
async function referenceChecks(client){
  const fks=(await client.query(`SELECT k.conname name,c.relname table_name,r.relname referenced_table,nr.nspname referenced_schema,k.confmatchtype match_type,
    ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY x(num,pos) JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=x.num ORDER BY x.pos) columns,
    ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY x(num,pos) JOIN pg_attribute a ON a.attrelid=r.oid AND a.attnum=x.num ORDER BY x.pos) referenced_columns
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_class r ON r.oid=k.confrelid JOIN pg_namespace nr ON nr.oid=r.relnamespace WHERE n.nspname='public' AND k.contype='f' ORDER BY k.conname`)).rows;
  const findings=[];
  for(const f of fks){
    const nonnull=f.columns.map(c=>`a.${quote(c)} IS NOT NULL`),hasnull=f.columns.map(c=>`a.${quote(c)} IS NULL`);
    const partial=f.match_type==='f'?` OR ((${nonnull.join(' OR ')}) AND (${hasnull.join(' OR ')}))`:'';
    const joins=f.columns.map((c,i)=>`b.${quote(f.referenced_columns[i])}=a.${quote(c)}`).join(' AND ');
    const {n}=(await client.query(`SELECT count(*)::int n FROM public.${quote(f.table_name)} a WHERE ((${nonnull.join(' AND ')}) AND NOT EXISTS(SELECT 1 FROM ${quote(f.referenced_schema)}.${quote(f.referenced_table)} b WHERE ${joins}))${partial}`)).rows[0];
    if(n)findings.push({table:f.table_name,constraint:f.name,orphan_rows:n});
  }
  return{checked:fks.length,findings};
}
async function sequenceChecks(client,state){
  const owners=(await client.query(`SELECT s.relname sequence_name,t.relname table_name,a.attname column_name,q.seqincrement::text increment,q.seqcycle cycle FROM pg_class s JOIN pg_namespace n ON n.oid=s.relnamespace JOIN pg_sequence q ON q.seqrelid=s.oid JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=s.oid AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i') JOIN pg_class t ON t.oid=d.refobjid JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid WHERE n.nspname='public'`)).rows;
  const checks=[];
  for(const owner of owners){const current=state.sequences[owner.sequence_name];if(!current)continue;
    const range=(await client.query(`SELECT min(${quote(owner.column_name)})::text minimum,max(${quote(owner.column_name)})::text maximum FROM public.${quote(owner.table_name)}`)).rows[0];
    const step=BigInt(owner.increment),next=BigInt(current.last_value)+(current.is_called?step:0n);
    const conflict=range.maximum!==null&&!owner.cycle&&(step>0n?next<=BigInt(range.maximum):next>=BigInt(range.minimum));
    checks.push({...owner,...current,...range,next_possible:next.toString(),collision_risk:conflict,assessment:owner.cycle?'manual_review_cycling_sequence':'monotonic'});
  }
  return sorted(checks);
}
async function financialChecks(client,state){
  if(!state.tables.installments||!state.tables.payments||!state.tables.contracts)return{available:false};
  const cols=state.tables.installments.columns,fields=['expected_amount','vat_amount','late_fee_amount','services_amount','discount_amount','manual_partial_amount'];
  const rows=(await client.query(`SELECT i.status,i.currency,c.currency contract_currency,${cols.includes('adjustment_pending')?'i.adjustment_pending':'false adjustment_pending'},${fields.map(f=>cols.includes(f)?'i.'+quote(f)+'::text':"'0'::text AS "+quote(f)).join(',')},COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.installment_id=i.id),0)::text received FROM installments i JOIN contracts c ON c.id=i.contract_id`)).rows;
  const checks={currency_mismatch:0,paid_with_debt:0,open_without_debt:0},totals={},states={};
  for(const r of rows){const currency=['ARS','USD'].includes(r.currency)?r.currency:'other',status=safeState(r.status);states[status]=(states[status]||0)+1;
    const t=totals[currency]||(totals[currency]=Object.fromEntries([...fields,'received','due','credit'].map(k=>[k,0n])));
    for(const f of [...fields,'received'])t[f]+=scaled(r[f]);const signed=scaled(balance(r,decimal(scaled(r.received)+scaled(r.manual_partial_amount))));t.due+=signed>0n?signed:0n;t.credit+=signed<0n?-signed:0n;
    if(r.currency!==r.contract_currency)checks.currency_mismatch++;
    if(r.status==='Pagado'&&signed>0n)checks.paid_with_debt++;
    if(['Pendiente','Parcial'].includes(r.status)&&signed<=0n&&!r.adjustment_pending)checks.open_without_debt++;
  }
  if(state.tables.installment_services){
    checks.services_projection_mismatch=(await client.query("SELECT count(*)::int n FROM installments i WHERE i.services_amount<>COALESCE((SELECT sum(s.original_amount-s.forgiven_amount) FROM installment_services s WHERE s.installment_id=i.id AND s.status='Confirmado'),0)")).rows[0].n;
    checks.duplicate_expense_links=(await client.query('SELECT count(*)::int n FROM (SELECT expense_id FROM installment_services WHERE expense_id IS NOT NULL GROUP BY expense_id HAVING count(*)>1) t')).rows[0].n;
    checks.service_currency_mismatch=(await client.query('SELECT count(*)::int n FROM installment_services s JOIN installments i ON i.id=s.installment_id LEFT JOIN ledger_entries e ON e.id=s.expense_id WHERE s.currency<>i.currency OR (e.id IS NOT NULL AND e.currency<>s.currency)')).rows[0].n;
  }
  return{available:true,states,totals:Object.fromEntries(Object.entries(totals).map(([c,t])=>[c,Object.fromEntries(Object.entries(t).map(([k,v])=>[k,decimal(v)]))])),checks};
}
async function ledgerSummary(client,state){
  const result={};
  if(state.tables.ledger_entries){const columns=state.tables.ledger_entries.columns;result.entries=(await client.query(`SELECT CASE WHEN kind IN ('Ingreso','Gasto') THEN kind ELSE 'otro' END kind,CASE WHEN currency IN ('ARS','USD') THEN currency ELSE 'other' END currency,count(*)::int count,sum(amount)::text amount,${columns.includes('voided_at')?'count(*) FILTER(WHERE voided_at IS NOT NULL)::int':'0'} voided FROM ledger_entries GROUP BY 1,2 ORDER BY 1,2`)).rows;}
  if(state.tables.installment_services)result.services=(await client.query("SELECT CASE WHEN status IN ('Borrador','Confirmado','Anulado') THEN status ELSE 'otro' END status,CASE WHEN currency IN ('ARS','USD') THEN currency ELSE 'other' END currency,count(*)::int count,sum(original_amount)::text original,sum(forgiven_amount)::text forgiven FROM installment_services GROUP BY 1,2 ORDER BY 1,2")).rows;
  if(state.tables.contracts){result.contract_states={};for(const r of (await client.query('SELECT status,count(*)::int count FROM contracts GROUP BY 1')).rows){const status=safeState(r.status);result.contract_states[status]=(result.contract_states[status]||0)+r.count;}}
  return result;
}
async function documents(client,state,settings){
  if(!state.tables.documents)return{available:false,items:[]};
  const rows=(await client.query('SELECT id,absolute_path,sha256,contract_id,property_id FROM documents')).rows,items=[];
  const root=fileLocation(settings.import_directory);
  for(const d of rows){const info=fileLocation(d.absolute_path),item={record_sha256:hash(d.id),expected_sha256:/^[a-f0-9]{64}$/i.test(d.sha256||'')?d.sha256:null,path:info,contract_linked:!!d.contract_id,property_linked:!!d.property_id};
    if(info.exists&&!info.directory){
      const relative=root.exists&&root.directory?path.relative(fs.realpathSync(settings.import_directory),fs.realpathSync(d.absolute_path)):null;
      item.within_import_directory=relative!==null&&relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);
      if(item.within_import_directory&&path.extname(d.absolute_path).toLowerCase()==='.pdf'){
        const before=fs.statSync(d.absolute_path);item.actual_sha256=await hashFile(d.absolute_path);const after=fs.statSync(d.absolute_path);item.stable_during_read=before.size===after.size&&before.mtimeMs===after.mtimeMs;item.hash_matches=item.stable_during_read&&item.actual_sha256===item.expected_sha256;
      }else item.hash_not_checked='outside_managed_folder_or_not_pdf';
    }
    items.push(item);
  }
  return{available:true,count:items.length,items:sorted(items)};
}
async function auditDatabase(url,{manifest=null}={}){
  const db=new Pool({connectionString:url,max:1,connectionTimeoutMillis:5000,application_name:'ferraro:audit-readonly'}),client=await db.connect();
  try{
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='3s'; SET LOCAL search_path=pg_catalog,public");
    const physical=await E.identity(client);if(manifest)await E.validate(client,manifest);
    const server=(await client.query("SELECT current_setting('server_version') version,current_setting('server_version_num')::int version_number,current_setting('server_encoding') encoding,current_setting('TimeZone') timezone,(SELECT datcollate FROM pg_database WHERE datname=current_database()) collation,(SELECT datctype FROM pg_database WHERE datname=current_database()) ctype,pg_is_in_recovery() in_recovery,current_setting('transaction_read_only') read_only")).rows[0];
    const state=await snapshot(client),schema=await catalog(client),versions=await M.status(client);
    const settings=state.tables.settings?Object.fromEntries((await client.query("SELECT key,value FROM settings WHERE key IN ('import_directory','scan_interval_seconds','late_fee_policy')")).rows.map(r=>[r.key,r.value])):{};
    let policy='manual';try{const p=JSON.parse(settings.late_fee_policy||'{}').mode;if(p)policy=['manual','none','fixed','bna'].includes(p)?p:'unknown';}catch{policy='invalid';}
    // Compare filesystem columns separately; changing an absolute path is not proof of a financial divergence.
    const rows={};for(const [table,value] of Object.entries(state.tables)){rows[table]={count:value.count,sha256:value.hash};if(['documents','imports'].includes(table)&&value.columns.includes('absolute_path'))rows[table].without_local_paths=await hashRows(client,`SELECT (to_jsonb(t)-'absolute_path')::text FROM public.${quote(table)} t ORDER BY (to_jsonb(t)-'absolute_path')::text COLLATE "C"`);}
    const report={report_version:1,generated_at:new Date().toISOString(),target:{label:E.sanitized(url),identity:physical,manifest_verified:!!manifest},server,
      migrations:{...versions,line_endings:M.files().map(f=>({version:f.version,format:f.sql.includes('\r\n')?'CRLF':'LF',normalized_lf_sha256:hash(f.sql.replace(/\r\n/g,'\n'))})),applied:versions.applied.map(r=>({version:r.version,applied_at:r.applied_at}))},schema,rows,
      relationships:await referenceChecks(client),sequences:await sequenceChecks(client,state),finance:{summary:state.finance,...await financialChecks(client,state)},
      ledger:await ledgerSummary(client,state),documents:await documents(client,state,settings),configuration:{import_directory:fileLocation(settings.import_directory),scan_interval_seconds:Number.isFinite(Number(settings.scan_interval_seconds))?Number(settings.scan_interval_seconds):null,late_fee_policy_mode:policy},
      application_sessions:(await client.query("SELECT application_name,count(*)::int count FROM pg_stat_activity WHERE datname=current_database() AND application_name IN ('ferraro:prod','ferraro:dev','ferraro:test') GROUP BY 1 ORDER BY 1")).rows};
    await client.query('ROLLBACK');return report;
  }finally{client.release();await db.end();}
}
function dockerInspection(url,expectedIdentity,{container='ferraro-postgres',run=spawnSync}={}){
  const invoke=args=>run('docker',args,{cwd:E.ROOT,encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024,windowsHide:true});
  const r=invoke(['inspect',container]);if(r.status!==0)return{verified:false,reason:'docker_or_container_unavailable'};
  try{
    const x=JSON.parse(r.stdout)[0],report={verified:true,container_id:x.Id,image:x.Config.Image,image_id:x.Image,status:x.State.Status,health:x.State.Health?.Status||null,restart:x.HostConfig.RestartPolicy.Name,
      mounts:x.Mounts.map(m=>({type:m.Type,volume:m.Type==='volume'?m.Name:null,target_is_pgdata:m.Destination==='/var/lib/postgresql/data',writable:m.RW})),ports:x.HostConfig.PortBindings,postgres_identity_verified:false,identity_probe_succeeded:false};
    const u=new URL(url),q=invoke(['exec',container,'psql','-X','-qAt','-U',decodeURIComponent(u.username),'-d',decodeURIComponent(u.pathname.slice(1)),'-c',"BEGIN READ ONLY; SELECT json_build_object('database',current_database(),'database_oid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),'cluster_id',(SELECT system_identifier::text FROM pg_control_system())); ROLLBACK;"]);
    if(q.status===0){const identity=JSON.parse(q.stdout.trim());report.identity_probe_succeeded=true;report.postgres_identity_verified=E.digest(identity)===E.digest(expectedIdentity);}
    return report;
  }catch{return{verified:false,reason:'docker_inspection_incomplete'};}
}
function schemaDifferences(left,right){
  const changes=[];
  for(const section of ['columns','constraints','indexes','triggers','functions','views','sequences']){
    const key=r=>JSON.stringify([r.schema_name||'public',r.table_name||'',r.column_name||r.name,r.arguments||'']);
    const a=new Map((left[section]?.objects||[]).map(r=>[key(r),r])),b=new Map((right[section]?.objects||[]).map(r=>[key(r),r]));
    for(const id of new Set([...a.keys(),...b.keys()]))if(hash(a.get(id)||null)!==hash(b.get(id)||null))changes.push({section,left:a.get(id)||null,right:b.get(id)||null});
  }
  return changes;
}
function auditRisks(report){
  const risks=[];
  if(Math.floor(report.server.version_number/10000)!==17)risks.push('postgres_major_not_17');
  if(report.relationships?.findings?.length)risks.push('orphan_rows');
  if(report.sequences?.some(s=>s.collision_risk))risks.push('sequence_collision_risk');
  if(report.schema.indexes?.objects.some(i=>!i.valid||!i.ready))risks.push('invalid_index');
  if(report.schema.triggers?.objects.some(t=>!t.internal&&['D','R'].includes(t.enabled)))risks.push('application_trigger_not_enabled');
  if(report.schema.constraints?.objects.some(c=>!c.validated))risks.push('unvalidated_constraint');
  if(Object.values(report.finance?.checks||{}).some(n=>n>0))risks.push('financial_integrity_findings');
  if(report.migrations.altered.length||report.migrations.unknown.length)risks.push('migration_integrity_findings');
  if(report.documents.items.some(d=>!d.hash_matches))risks.push('pdf_not_verified');
  if(report.docker?.ports&&Object.values(report.docker.ports).flat().some(p=>p&&!['127.0.0.1','::1'].includes(p.HostIp)))risks.push('postgres_port_exposed_beyond_loopback');
  return risks;
}
const TECHNICAL=new Set(['schema_migrations','settings','ipc_indices','ipc_index_versions','ipc_refresh_state','late_fee_rates','late_fee_rate_sources','late_fee_sync_state','late_fee_sync_days']);
function compareAudits(left,right){
  for(const r of [left,right])if(r?.report_version!==1||!r.schema?.sha256||!r.rows||!r.server?.version_number||!r.target?.identity||!Array.isArray(r.documents?.items)||!r.migrations||!r.finance)throw new Error('Informe de auditoría inválido o incompleto.');
  const differences=[],add=(area,classification,details)=>differences.push({area,classification,details});
  const same=(a,b)=>hash(a??null)===hash(b??null);
  const major=n=>Math.floor(n/10000);
  add('PostgreSQL',left.server.version_number===right.server.version_number?'Equivalentes':major(left.server.version_number)===major(right.server.version_number)?'Compatibles sin cambios':'Riesgo confirmado',{left:left.server.version,right:right.server.version});
  if(left.server.collation!==right.server.collation||left.server.ctype!==right.server.ctype)add('Collation','Diferencia de configuración corregible',{left:left.server.collation,right:right.server.collation,automatic_change:false});
  if(left.migrations.altered.length||right.migrations.altered.length)add('Checksums','Riesgo confirmado',{left:left.migrations.altered,right:right.migrations.altered});
  if(left.migrations.pending.length||right.migrations.pending.length)add('Migraciones','Migración realmente pendiente',{left:left.migrations.pending.map(r=>r.version),right:right.migrations.pending.map(r=>r.version)});
  add('Objetos SQL',left.schema.sha256===right.schema.sha256?'Equivalentes':'Diferencia de configuración corregible',{matching:left.schema.sha256===right.schema.sha256,objects:schemaDifferences(left.schema,right.schema)});
  const business=[],technical=[],paths=[];
  for(const table of [...new Set([...Object.keys(left.rows),...Object.keys(right.rows)])].sort()){
    const a=left.rows[table],b=right.rows[table];if(a?.sha256===b?.sha256)continue;
    if(a?.without_local_paths&&b?.without_local_paths&&same(a.without_local_paths,b.without_local_paths))paths.push(table);
    else (TECHNICAL.has(table)?technical:business).push({table,left_count:a?.count??null,right_count:b?.count??null});
  }
  add('Registros y relaciones',business.length?'Diferencia de datos que requiere conciliación':'Equivalentes',{different_tables:business});
  if(technical.length)add('Configuración e historial técnico','Diferencia de configuración corregible',{different_tables:technical,review_required:true});
  if(paths.length)add('Rutas locales','Diferencia de configuración corregible',{tables:paths});
  add('Importes y saldos',!left.finance.available||!right.finance.available?'NO VERIFICADO':same(left.finance.summary,right.finance.summary)?'Equivalentes':'Diferencia de datos que requiere conciliación',{matching:same(left.finance.summary,right.finance.summary),left:left.finance.totals||null,right:right.finance.totals||null});
  const files=r=>sorted(r.documents.items.map(d=>({sha256:d.expected_sha256,hash_matches:d.hash_matches===true})));
  add('PDFs',left.documents.items.some(d=>!d.hash_matches)||right.documents.items.some(d=>!d.hash_matches)?'Riesgo confirmado':same(files(left),files(right))?'Equivalentes':'Diferencia de datos que requiere conciliación',{left:files(left),right:files(right)});
  const persistent=r=>r.docker?.mounts?.some(m=>m.target_is_pgdata&&m.writable&&['volume','bind'].includes(m.type));
  const dockerKnown=left.docker?.postgres_identity_verified&&right.docker?.postgres_identity_verified;
  const mismatch=[left,right].some(r=>r.docker?.identity_probe_succeeded&&!r.docker.postgres_identity_verified);
  add('Persistencia Docker',mismatch?'Riesgo confirmado':!dockerKnown?'NO VERIFICADO':persistent(left)&&persistent(right)?'Compatibles sin cambios':'Riesgo confirmado',{same_physical_cluster:left.target.identity.cluster_id===right.target.identity.cluster_id,left_persistent:!!persistent(left),right_persistent:!!persistent(right),left_mounts:left.docker?.mounts||[],right_mounts:right.docker?.mounts||[],volume_names_need_not_match:true});
  if(left.runtime&&right.runtime)add('Código y dependencias',same(left.runtime.lockfile_sha256,right.runtime.lockfile_sha256)&&same(left.runtime.migration_files_sha256,right.runtime.migration_files_sha256)&&left.runtime.source_sha256&&left.runtime.source_sha256===right.runtime.source_sha256?'Equivalentes':'Diferencia de configuración corregible',{matching_lockfile:left.runtime.lockfile_sha256===right.runtime.lockfile_sha256,matching_commit:left.runtime.commit===right.runtime.commit,matching_source:left.runtime.source_sha256===right.runtime.source_sha256});
  const leftRisks=auditRisks(left),rightRisks=auditRisks(right);if(leftRisks.length||rightRisks.length)add('Hallazgos de integridad','Riesgo confirmado',{left:leftRisks,right:rightRisks});
  if(left.migrations.historical_unverified.length||right.migrations.historical_unverified.length)add('Procedencia histórica de checksums','NO VERIFICADO',{left:left.migrations.historical_unverified.length,right:right.migrations.historical_unverified.length});
  return{report_version:1,comparison:true,generated_at:new Date().toISOString(),source_of_truth:'NO DEFINIDA: requiere decisión del usuario después de revisar ambos informes.',automatic_transfer:false,differences};
}
module.exports={auditDatabase,dockerInspection,compareAudits,pathKind,fileLocation,hash};
