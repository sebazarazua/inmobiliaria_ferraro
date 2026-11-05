const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Pool}=require('pg');
const E=require('./environment'),M=require('./migrations'),C=require('./cluster');
const {snapshot,assertPreserved,lockTables}=require('./snapshot');
const hashFile=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function key(){const file=path.join(E.privateDirectory(E.stateRoot()),'authority.key');if(!fs.existsSync(file))fs.writeFileSync(file,crypto.randomBytes(32),{mode:0o600,flag:'wx'});const stat=fs.lstatSync(file);if(stat.isSymbolicLink()||(stat.mode&0o077)||(process.platform!=='win32'&&stat.uid!==process.getuid()))throw new Error('La clave de preparación no es privada.');return fs.readFileSync(file);}
const sign=value=>crypto.createHmac('sha256',key()).update(JSON.stringify(value)).digest('hex');
function savePlan(file,plan){E.writePrivate(file,{plan,signature:sign(plan)});}
function loadPlan(file){const doc=E.readPrivate(file),mac=sign(doc.plan);if(typeof doc.signature!=='string'||doc.signature.length!==mac.length||!crypto.timingSafeEqual(Buffer.from(mac),Buffer.from(doc.signature)))throw new Error('Preparación alterada o no autorizada.');return doc.plan;}
function pgEnv(url){const u=new URL(url),allowed=['sslmode','sslrootcert','sslcert','sslkey'];if([...u.searchParams.keys()].some(k=>!allowed.includes(k)))throw new Error('Parámetro de conexión no soportado para backup verificable.');return {...process.env,PGHOST:u.hostname,PGPORT:u.port||'5432',PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),PGDATABASE:decodeURIComponent(u.pathname.slice(1)),...Object.fromEntries(allowed.filter(k=>u.searchParams.has(k)).map(k=>['PG'+k.toUpperCase(),u.searchParams.get(k)]))};}
async function observeProduction(url){
  if(!url)throw new Error('Falta PROD_DATABASE_URL (o DATABASE_URL legado) para identificar PROD.');
  const db=new Pool({connectionString:url,max:1,application_name:'ferraro:production-observe'});try{await db.query('BEGIN READ ONLY');const id=await E.identity(db);const marker=(await db.query("SELECT to_regclass('ferraro_system.environment') IS NOT NULL ok")).rows[0].ok;if(marker){const m=(await db.query('SELECT environment FROM ferraro_system.environment')).rows[0];if(m&&m.environment!=='prod')throw new Error('El destino es sintético: no se registra como PROD.');}await db.query('ROLLBACK');return {environment:'prod',url,identity:id,registered_at:new Date().toISOString()};}finally{await db.end();}
}
async function noWriters(client){const r=(await client.query('SELECT COUNT(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()')).rows[0];if(r.n)throw new Error('Hay otras sesiones conectadas a PROD. Detené escritores/watchers y volvé a preparar.');}
async function maintenance(client){const ok=(await client.query("SELECT pg_try_advisory_lock(hashtext('ferraro:maintenance')) ok")).rows[0].ok;if(!ok)throw new Error('La aplicación está abierta o hay otra actualización. Detené escritores.');await noWriters(client);}
async function restoreAndRehearse(backup,{before,directory=M.DIRECTORY}={}){
  const root=C.temporaryRoot('ferraro-restore-');let cluster;
  try{
    cluster=await C.startCluster(root,{user:'ferraro_restore'});const control=new Pool({connectionString:cluster.url});let proof;
    try{proof=await E.registerSynthetic(control,{environment:'test',purpose:'restore-control',url:cluster.url,file:path.join(root,'control.json'),clusterDirectory:root});await control.query('CREATE DATABASE ferraro_restore');}finally{await control.end();}
    const url=cluster.url.slice(0,cluster.url.lastIndexOf('/')+1)+'ferraro_restore';
    C.run('pg_restore',['--exit-on-error','--no-owner','--no-privileges','--dbname','ferraro_restore',backup],{env:pgEnv(url),privateErrors:true});
    const copy=new Pool({connectionString:url}),client=await copy.connect();
    try{
      const restored=await snapshot(client,{projection:before});assertPreserved(before,restored);
      const ctx=await E.registerSynthetic(client,{environment:'test',purpose:'production-restore',url,file:path.join(root,'restore.json'),clusterDirectory:root,restoreProof:proof});
      const applied=await M.migrateClient(client,ctx,{directory});const after=await snapshot(client,{projection:before});assertPreserved(before,after);
      return {verified:true,applied,finance:after.finance,preserved_tables:Object.keys(before.tables).filter(t=>t!=='schema_migrations'),schema:await M.status(client,{directory})};
    }finally{client.release();await copy.end();}
  }finally{if(cluster)C.stopCluster(cluster);C.removeTemporary(root);}
}
async function prepare(url,{directory=M.DIRECTORY,now=new Date()}={}){
  const ctx=await observeProduction(url),root=path.join(E.stateRoot(),'backups');
  if(path.resolve(root).startsWith(E.ROOT+path.sep)||path.resolve(root)===E.ROOT)throw new Error('Los backups deben quedar fuera del repositorio.');
  E.privateDirectory(root);if(fs.realpathSync(root).startsWith(fs.realpathSync(E.ROOT)+path.sep))throw new Error('El backup resuelve dentro del repositorio.');const id=crypto.randomUUID(),folder=E.privateDirectory(path.join(root,id)),backup=path.join(folder,'database.dump'),file=path.join(folder,'preparation.json'),db=new Pool({connectionString:url,max:1,application_name:'ferraro:prepare'}),client=await db.connect();
  try{
    await E.validate(client,ctx);await maintenance(client);await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await client.query("SET LOCAL lock_timeout='5s'");await lockTables(client);
    const before=await snapshot(client),versions=await M.status(client,{directory});if(versions.altered.length||versions.unknown.length)throw new Error('Hay migraciones alteradas o versiones desconocidas.');
    const exported=(await client.query('SELECT pg_export_snapshot() id')).rows[0].id;
    C.run('pg_dump',['--format=custom','--snapshot='+exported,'--file',backup],{env:pgEnv(url),privateErrors:true});fs.chmodSync(backup,0o600);
    C.run('pg_restore',['--list',backup]);
    // Keep SHARE locks while rehearsing so the signed baseline and dump refer to the same state.
    const rehearsal=await restoreAndRehearse(backup,{before,directory});
    const current=await snapshot(client);if(E.digest(before)!==E.digest(current))throw new Error('El estado cambió durante la preparación.');await noWriters(client);
    await client.query('ROLLBACK');
    const plan={id,created_at:now.toISOString(),expires_at:new Date(now.getTime()+60*60*1000).toISOString(),target:ctx.identity,target_label:E.sanitized(url),baseline:before,versions:versions.files,pending:versions.pending,backup,backup_sha256:hashFile(backup),rehearsal,status:'prepared'};
    savePlan(file,plan);E.writePrivate(path.join(E.stateRoot(),'prod.json'),ctx);E.writePrivate(path.join(E.stateRoot(),'latest-preparation.json'),{file});return {id,file,target:plan.target_label,pending:plan.pending.map(r=>r.version),expires_at:plan.expires_at,rehearsal_verified:true,backup};
  }catch(error){E.writePrivate(path.join(folder,'preparation-failure.json'),{at:new Date().toISOString(),target:ctx.identity,error:error.message,native_detail:error.nativeDetail||null});throw error;}finally{await client.query('ROLLBACK').catch(()=>{});await client.query("SELECT pg_advisory_unlock(hashtext('ferraro:maintenance'))").catch(()=>{});client.release();await db.end();}
}
function latestFile(){return E.readPrivate(path.join(E.stateRoot(),'latest-preparation.json')).file;}
async function apply({file=latestFile(),confirmation,now=new Date(),directory=M.DIRECTORY}={}){
  const plan=loadPlan(file);if(confirmation!==plan.id)throw new Error('Confirmación humana requerida: --confirm '+plan.id);
  if(new Date(plan.expires_at)<now)throw new Error('La preparación venció; generá una nueva.');
  if(!plan.rehearsal?.verified||!fs.existsSync(plan.backup)||hashFile(plan.backup)!==plan.backup_sha256)throw new Error('Backup ausente, alterado o sin restauración probada.');
  if(E.digest(M.files(directory).map(({sql,...v})=>v))!==E.digest(plan.versions))throw new Error('Cambió el código de migraciones desde la preparación.');
  const ctx=E.context({environment:'prod'});if(E.digest(ctx.identity)!==E.digest(plan.target))throw new Error('La preparación pertenece a otro destino.');
  const db=new Pool({connectionString:ctx.url,max:1,application_name:'ferraro:migrate'}),client=await db.connect();let committed=false;
  try{
    await E.validate(client,ctx);await maintenance(client);
    // A recorded successful operation makes retries safe after commit / process interruption.
    const recorded=(await client.query("SELECT to_regclass('ferraro_system.migration_runs') IS NOT NULL ok")).rows[0].ok;
    if(recorded&&(await client.query("SELECT 1 FROM ferraro_system.migration_runs WHERE operation_id=$1 AND result='success'",[plan.id])).rowCount){await M.assertCompatible(client,{directory});return {replayed:true,verified:true};}
    await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='5s'");await lockTables(client,'ACCESS EXCLUSIVE');
    const current=await snapshot(client);if(E.digest(current)!==E.digest(plan.baseline))throw new Error('Cambió el estado de producción; repetí la preparación.');
    const applied=await M.migrateClient(client,ctx,{directory,inTransaction:true,operationId:plan.id});
    const after=await snapshot(client,{projection:plan.baseline});assertPreserved(plan.baseline,after);await M.assertCompatible(client,{directory});await noWriters(client);
    await client.query('COMMIT');committed=true;savePlan(file,{...plan,status:'applied',applied_at:new Date().toISOString(),applied});return {verified:true,applied};
  }catch(e){await client.query('ROLLBACK').catch(()=>{});E.writePrivate(path.join(path.dirname(file),'failure-'+crypto.randomUUID()+'.json'),{at:new Date().toISOString(),operation_id:plan.id,committed,error:e.message});throw e;
  }finally{await client.query('ROLLBACK').catch(()=>{});await client.query("SELECT pg_advisory_unlock(hashtext('ferraro:maintenance'))").catch(()=>{});client.release();await db.end();}
}
async function verifyProduction({file=latestFile()}={}){const plan=loadPlan(file),ctx=E.context({environment:'prod'});if(E.digest(ctx.identity)!==E.digest(plan.target))throw new Error('La verificación pertenece a otro destino.');const db=new Pool({connectionString:ctx.url,max:1});try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await E.validate(db,ctx);const versions=await M.assertCompatible(db),after=await snapshot(db,{projection:plan.baseline});assertPreserved(plan.baseline,after);await db.query('ROLLBACK');return{verified:true,latest:versions.applied.at(-1)?.version,finance:after.finance};}finally{await db.end();}}
module.exports={prepare,apply,verifyProduction,restoreAndRehearse,observeProduction,pgEnv,hashFile,loadPlan};
