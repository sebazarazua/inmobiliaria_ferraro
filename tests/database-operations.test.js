require('./require-isolated');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Pool}=require('pg'),{spawn}=require('node:child_process');
const E=require('../backend/src/database/environment'),M=require('../backend/src/database/migrations'),P=require('../backend/src/database/production'),C=require('../backend/src/database/cluster');
const {openDatabase}=require('../backend/src/database'),D=require('../backend/src/database/development');
async function fixture(t,{version='017',duplicates=false}={}){
  const root=C.temporaryRoot('ferraro-dbtest-'),previous=process.env.FERRARO_STATE_DIR;process.env.FERRARO_STATE_DIR=root;
  const dbName='operations_'+crypto.randomBytes(8).toString('hex'),admin=new Pool({connectionString:process.env.DATABASE_URL}),u=new URL(process.env.DATABASE_URL);u.pathname='/'+dbName;const url=u.href;
  await admin.query('CREATE DATABASE '+dbName);const db=new Pool({connectionString:url});
  try{
    for(const f of M.files().filter(f=>f.version.slice(0,3)<=version)){await db.query(f.sql);await db.query('INSERT INTO schema_migrations(version) VALUES($1)',[f.version]);}
    const ids=Array.from({length:6},()=>crypto.randomUUID()),[person,property,contract,installment,expense,service]=ids;
    await db.query("INSERT INTO persons(id,full_name) VALUES($1,'Persona Sintética Operaciones')",[person]);await db.query("INSERT INTO properties(id,code,address,normalized_address) VALUES($1,'OPS','Propiedad Sintética OPS','propiedad sintetica ops')",[property]);await db.query("INSERT INTO contracts(id,code,property_id,tenant_id,rental_type,duration_months,start_date,end_date,initial_amount,currency) VALUES($1,'OPS',$2,$3,'Residencial',12,'2025-01-01','2025-12-31',100000,'ARS')",[contract,property,person]);
    await db.query("INSERT INTO installments(id,contract_id,period,due_date,expected_amount,late_fee_amount,currency) VALUES($1,$2,'2025-09','2025-09-10',100000,1000,'ARS')",[installment,contract]);await db.query("INSERT INTO payments(id,installment_id,amount,paid_at) VALUES($1,$2,120000,'2025-09-15')",[crypto.randomUUID(),installment]);await db.query("INSERT INTO ledger_entries(id,entry_date,kind,category,description,amount,currency,property_id,contract_id) VALUES($1,'2025-09-01','Gasto','Servicio','Factura sintética',5000,'ARS',$2,$3)",[expense,property,contract]);
    for(const id of [service,...(duplicates?[crypto.randomUUID()]:[])])await db.query("INSERT INTO installment_services(id,installment_id,category,description,original_amount,forgiven_amount,currency,status,responsibility_reference,expense_id) VALUES($1,$2,'Agua','Cargo sintético',5000,1000,'ARS','Confirmado','Cláusula sintética',$3)",[id,installment,expense]);
  }finally{await db.end();}
  t.after(async()=>{const file=path.join(root,'dev.json');if(fs.existsSync(file)){const ctx=E.readPrivate(file);C.stopCluster({data:path.join(ctx.cluster_directory,'pgdata')});}await admin.query('DROP DATABASE '+dbName+' WITH (FORCE)');await admin.end();if(previous===undefined)delete process.env.FERRARO_STATE_DIR;else process.env.FERRARO_STATE_DIR=previous;C.removeTemporary(root);});
  return{root,url,db:()=>new Pool({connectionString:url}),pin:async()=>E.writePrivate(path.join(root,'prod.json'),await P.observeProduction(url))};
}
test('DB01. PROD pendiente se observa sin seeds ni cambios; AUTO_MIGRATE=true se rechaza',async t=>{
  const s=await fixture(t);await s.pin();const old=process.env.FERRARO_ENV,auto=process.env.AUTO_MIGRATE;process.env.FERRARO_ENV='prod';
  try{await assert.rejects(()=>openDatabase(),/018_financial_integrity/);process.env.AUTO_MIGRATE='true';await assert.rejects(()=>openDatabase(),/prohibido en PROD/);}finally{process.env.FERRARO_ENV=old;process.env.AUTO_MIGRATE=auto;}
  const db=s.db();try{assert.equal((await db.query('SELECT COUNT(*)::int n FROM settings')).rows[0].n,0);assert.equal((await db.query("SELECT to_regclass('ferraro_system.migration_checksums') value")).rows[0].value,null);}finally{await db.end();}
});
test('DB02. backup real restaurado y 017→018 preservan pagos, cargos, crédito y relaciones',async t=>{
  const s=await fixture(t),r=await P.prepare(s.url);assert.equal(r.rehearsal_verified,true);assert.deepEqual(r.pending,['018_financial_integrity.sql']);const plan=P.loadPlan(r.file);assert.equal(plan.rehearsal.finance.credit.ARS,'15000.00');assert.ok(fs.existsSync(r.backup));
  const db=s.db();try{assert.equal((await M.status(db)).pending.length,1);assert.equal((await db.query("SELECT to_regclass('public.integrity_findings') value")).rows[0].value,null);}finally{await db.end();}
});
test('DB03. confirmación explícita migra copia sintética PROD, verifica y repite sin duplicar',async t=>{
  const s=await fixture(t),r=await P.prepare(s.url);await assert.rejects(()=>P.apply({file:r.file}),/Confirmación humana/);const result=await P.apply({file:r.file,confirmation:r.id});assert.deepEqual(result.applied,['018_financial_integrity.sql']);assert.equal((await P.verifyProduction({file:r.file})).verified,true);assert.equal((await P.apply({file:r.file,confirmation:r.id})).replayed,true);
  const db=s.db();try{assert.equal((await db.query("SELECT COUNT(*)::int n FROM ferraro_system.migration_checksums WHERE provenance='adopted_unverified'")).rows[0].n,17);assert.equal((await db.query("SELECT provenance FROM ferraro_system.migration_checksums WHERE version='018_financial_integrity.sql'")).rows[0].provenance,'executed_verified');assert.equal((await db.query('SELECT COUNT(*)::int n FROM ferraro_system.migration_runs')).rows[0].n,1);}finally{await db.end();}
});
test('DB04. un pago nuevo invalida preparación; no se migra el destino',async t=>{
  const s=await fixture(t),r=await P.prepare(s.url),db=s.db();try{await db.query('UPDATE payments SET amount=amount+1');}finally{await db.end();}await assert.rejects(()=>P.apply({file:r.file,confirmation:r.id}),/Cambió el estado/);
});
test('DB05. backup alterado y preparación vencida se rechazan antes de escribir',async t=>{
  const s=await fixture(t),r=await P.prepare(s.url);await assert.rejects(()=>P.apply({file:r.file,confirmation:r.id,now:new Date(Date.now()+2*3600000)}),/venció/);fs.appendFileSync(r.backup,'alterado');await assert.rejects(()=>P.apply({file:r.file,confirmation:r.id}),/Backup/);
});
test('DB06. backup ilegible no puede declararse restaurado',async t=>{
  const s=await fixture(t),file=path.join(s.root,'invalid.dump');fs.writeFileSync(file,'invalid');const db=s.db();let before;try{before=await require('../backend/src/database/snapshot').snapshot(db);}finally{await db.end();}await assert.rejects(()=>P.restoreAndRehearse(file,{before}),/pg_restore/);
});
test('DB07. no prepara con sesiones escritoras ni actualiza con un escritor conectado',async t=>{
  const s=await fixture(t),writer=s.db();await writer.query('SELECT 1');await assert.rejects(()=>P.prepare(s.url),/sesiones/);await writer.end();const r=await P.prepare(s.url),next=s.db();await next.query('SELECT 1');try{await assert.rejects(()=>P.apply({file:r.file,confirmation:r.id}),/sesiones/);}finally{await next.end();}
});
test('DB08. PROD actualizada inicia sin seeds y bloquea mantenimiento mientras la app vive',async t=>{
  const s=await fixture(t,{version:'018'});await s.pin();const old=process.env.FERRARO_ENV;process.env.FERRARO_ENV='prod';let app;try{app=await openDatabase();assert.equal((await app.query('SELECT COUNT(*)::int n FROM settings')).rows[0].n,0);await assert.rejects(()=>P.prepare(s.url),/aplicación está abierta/);}finally{if(app)await app.end();process.env.FERRARO_ENV=old;}
});
test('DB09. DEV inexistente se crea independiente, migra y reinicia conservando el anterior',async t=>{
  const s=await fixture(t);await assert.rejects(async()=>E.context({environment:'dev'}),/DEV no está preparado/);await D.migrateDev();await D.seedDev();const a=E.context({environment:'dev'});assert.notDeepEqual(a.identity,E.context({environment:'test'}).identity);assert.notEqual(a.identity.cluster_id,E.context({environment:'test'}).identity.cluster_id);const r=await D.resetDev();assert.ok(fs.existsSync(r.archived));assert.notEqual(E.context({environment:'dev'}).instance_id,a.instance_id);assert.equal((await D.migrateDev()).pending.length,0);
});
test('DB10. cambiar nombre/URL/entorno no permite usar o resetear PROD desde DEV',async t=>{
  const s=await fixture(t);await D.migrateDev();const file=path.join(s.root,'dev.json'),original=E.readPrivate(file);E.writePrivate(file,{...original,url:s.url});await assert.rejects(()=>D.resetDev(),/Identidad PostgreSQL/);E.writePrivate(file,original);const old=process.env.FERRARO_ENV;process.env.FERRARO_ENV='dev';try{await assert.rejects(()=>openDatabase(s.url),/Conexión cruzada/);}finally{process.env.FERRARO_ENV=old;}
});
test('DB11. migraciones nuevas fallidas revierten su DDL y registran resultado; checksum alterado bloquea',async t=>{
  const s=await fixture(t);await D.migrateDev();const ctx=E.context({environment:'dev'}),db=new Pool({connectionString:ctx.url}),dir=path.join(s.root,'migration-files');fs.mkdirSync(dir);for(const f of M.files())fs.writeFileSync(path.join(dir,f.version),f.sql);fs.writeFileSync(path.join(dir,'019_failure.sql'),'CREATE TABLE failure_marker(id int); SELECT 1/0;');
  try{await assert.rejects(()=>M.migrate(db,ctx,{directory:dir}),/019_failure/);assert.equal((await db.query("SELECT to_regclass('failure_marker') value")).rows[0].value,null);assert.equal((await db.query("SELECT result FROM ferraro_system.migration_runs WHERE version='019_failure.sql'")).rows[0].result,'failed');fs.appendFileSync(path.join(dir,'001_initial.sql'),'\n-- changed');await assert.rejects(()=>M.migrate(db,ctx,{directory:dir}),/alteradas/);}finally{await db.end();}
});
test('DB12. concurrencia de migración aplica una sola vez; base desactualizada migra sólo en DEV',async t=>{
  const s=await fixture(t);await D.migrateDev();const ctx=E.context({environment:'dev'}),db=new Pool({connectionString:ctx.url}),dir=path.join(s.root,'concurrent');fs.mkdirSync(dir);for(const f of M.files())fs.writeFileSync(path.join(dir,f.version),f.sql);fs.writeFileSync(path.join(dir,'019_once.sql'),'CREATE TABLE once_marker(id int);');try{const r=await Promise.all([M.migrate(db,ctx,{directory:dir}),M.migrate(db,ctx,{directory:dir})]);assert.equal(r.flat().filter(v=>v==='019_once.sql').length,1);assert.equal((await db.query("SELECT COUNT(*)::int n FROM schema_migrations WHERE version='019_once.sql'")).rows[0].n,1);}finally{await db.end();}
});
test('DB13. manifiesto interno o credenciales erróneas bloquean antes de seeds',async t=>{
  const s=await fixture(t);await D.migrateDev();const ctx=E.context({environment:'dev'}),db=new Pool({connectionString:ctx.url});try{await assert.rejects(()=>E.validate(db,{...ctx,secret:'incorrecto'}),/identidad interna/);await assert.rejects(()=>P.observeProduction(s.url.replace('ferraro_test@','rol_inexistente@')));}finally{await db.end();}
});
test('DB14. fallo de arranque conserva diagnóstico y limpia sin borrar directorios ajenos',async t=>{
  const root=C.temporaryRoot('ferraro-dbtest-');try{await assert.rejects(()=>C.startCluster(root,{extraOptions:'-c parametro_inexistente=1'}),/PostgreSQL temporal no inició/);assert.match(C.diagnostics(root),/parametro_inexistente/);assert.throws(()=>C.removeTemporary(path.dirname(root)),/Limpieza rechazada/);}finally{C.removeTemporary(root);}
});
test('DB15. 018 con vínculos históricos repetidos conserva importes y registra findings',async t=>{
  const s=await fixture(t,{duplicates:true}),r=await P.prepare(s.url);await P.apply({file:r.file,confirmation:r.id});const db=s.db();try{assert.equal((await db.query('SELECT COUNT(*)::int n FROM integrity_findings')).rows[0].n,1);assert.equal((await db.query('SELECT COUNT(*)::int n FROM installment_services')).rows[0].n,2);assert.equal((await db.query("SELECT COUNT(*)::int n FROM pg_indexes WHERE indexname='installment_services_expense_uq'")).rows[0].n,0);assert.equal((await db.query("SELECT COUNT(*)::int n FROM pg_trigger WHERE tgname='installment_services_link_guard'")).rows[0].n,1);}finally{await db.end();}
});
test('DB16. archivos cambiados y firma manipulada invalidan preparación',async t=>{
  const s=await fixture(t),dir=path.join(s.root,'files');fs.mkdirSync(dir);for(const f of M.files())fs.writeFileSync(path.join(dir,f.version),f.sql);
  const r=await P.prepare(s.url,{directory:dir});fs.appendFileSync(path.join(dir,M.files()[0].version),'\n-- changed');await assert.rejects(()=>P.apply({file:r.file,confirmation:r.id,directory:dir}),/Cambió el código/);
  const doc=E.readPrivate(r.file);doc.plan.pending=[];E.writePrivate(r.file,doc);await assert.rejects(()=>P.apply({file:r.file,confirmation:r.id}),/alterada/);
});
test('DB17. matar el proceso durante DDL revierte y permite reintento completo',async t=>{
  const s=await fixture(t),dir=path.join(s.root,'crash-files');fs.mkdirSync(dir);for(const f of M.files())fs.writeFileSync(path.join(dir,f.version),f.sql);fs.writeFileSync(path.join(dir,'019_crash.sql'),'CREATE TABLE crash_marker(id int); SELECT pg_sleep(3);');
  const r=await P.prepare(s.url,{directory:dir});
  const child=spawn(process.execPath,['-e',`require('./backend/src/database/production').apply(${JSON.stringify({file:r.file,confirmation:r.id,directory:dir})}).catch(()=>process.exit(1))`],{cwd:E.ROOT,env:process.env,stdio:'ignore'});
  const exited=new Promise(resolve=>child.once('exit',resolve)),observer=new Pool({connectionString:process.env.DATABASE_URL});let found=false;
  try{for(let i=0;i<100;i++){const row=await observer.query("SELECT 1 FROM pg_stat_activity WHERE application_name='ferraro:migrate' AND state='active' AND query LIKE '%pg_sleep(3)%'");if(row.rowCount){found=true;break;}await new Promise(resolve=>setTimeout(resolve,30));}}finally{child.kill('SIGKILL');await exited;await observer.end();}
  assert.equal(found,true,'se interrumpió mientras el DDL estaba dentro de la transacción');
  const db=s.db();try{assert.equal((await db.query("SELECT to_regclass('crash_marker') value")).rows[0].value,null);assert.equal((await M.status(db)).pending.length,1);}finally{await db.end();}
  assert.deepEqual((await P.apply({file:r.file,confirmation:r.id,directory:dir})).applied,['018_financial_integrity.sql','019_crash.sql']);
});
test('DB18. TEST falsificado y DEV con esquema pendiente no habilitan escrituras implícitas',async t=>{
  const s=await fixture(t),flag=process.env.FERRARO_TEST_ISOLATED,url=process.env.DATABASE_URL;try{process.env.FERRARO_TEST_ISOLATED='0';assert.throws(()=>E.assertTestProof(),/runner/);process.env.FERRARO_TEST_ISOLATED='1';process.env.DATABASE_URL=s.url;assert.throws(()=>E.assertTestProof(),/Conexión cruzada|runner/);}finally{process.env.DATABASE_URL=url;process.env.FERRARO_TEST_ISOLATED=flag;}
  const ctx=await D.setupDev(),db=new Pool({connectionString:ctx.url}),dir=path.join(s.root,'old-dev');fs.mkdirSync(dir);for(const f of M.files().filter(f=>f.version.slice(0,3)<='017'))fs.writeFileSync(path.join(dir,f.version),f.sql);try{await M.migrate(db,ctx,{directory:dir});}finally{await db.end();}
  const old=process.env.FERRARO_ENV;process.env.FERRARO_ENV='dev';try{await assert.rejects(()=>openDatabase(undefined,{runMigrations:false}),/018_financial_integrity/);const verified=await openDatabase(undefined,{runMigrations:true});await verified.end();}finally{process.env.FERRARO_ENV=old;}
});
test('DB19. ensayo con migración fallida no prepara ni modifica producción',async t=>{
  const s=await fixture(t),dir=path.join(s.root,'bad-rehearsal');fs.mkdirSync(dir);for(const f of M.files())fs.writeFileSync(path.join(dir,f.version),f.sql);fs.writeFileSync(path.join(dir,'019_bad.sql'),'UPDATE payments SET amount=0; SELECT 1/0;');await assert.rejects(()=>P.prepare(s.url,{directory:dir}),/019_bad/);assert.equal(fs.existsSync(path.join(s.root,'latest-preparation.json')),false);const db=s.db();try{assert.equal((await db.query('SELECT amount::text FROM payments')).rows[0].amount,'120000.00');assert.equal((await M.status(db)).pending.length,1);}finally{await db.end();}
});
test('DB20. comparación es idéntica entre zonas horarias y formatos de fechas',async t=>{
  const s=await fixture(t),db=s.db();try{await db.query("INSERT INTO audit_log(id,entity_type,entity_id,action,details_json) SELECT $1,'contract',id,'synthetic',$2 FROM contracts",[crypto.randomUUID(),JSON.stringify({synthetic:true})]);const {snapshot}=require('../backend/src/database/snapshot');await db.query("SET TIME ZONE 'America/Argentina/Buenos_Aires'; SET datestyle='SQL, DMY'");const a=await snapshot(db);await db.query("SET TIME ZONE 'UTC'; SET datestyle='ISO, YMD'");assert.deepEqual(await snapshot(db),a);}finally{await db.end();}
});
