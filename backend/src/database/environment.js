const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {assertPrivatePath}=require('./private-path');
const ROOT=path.resolve(__dirname,'../../..');
const stateRoot=()=>path.resolve(process.env.FERRARO_STATE_DIR||path.join(os.homedir(),'.local/share/ferraro'));
function privateDirectory(dir){fs.mkdirSync(dir,{recursive:true,mode:0o700});const st=fs.lstatSync(dir);if(!st.isDirectory()||st.isSymbolicLink()||(process.platform!=='win32'&&st.uid!==process.getuid()))throw new Error('Directorio privado ajeno o enlace simbólico: operación bloqueada.');fs.chmodSync(dir,0o700);if(process.platform==='win32')assertPrivatePath(dir,{directory:true});return dir;}
function writePrivate(file,value){privateDirectory(path.dirname(file));const temp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600,flag:'wx'});fs.renameSync(temp,file);}
function readPrivate(file){assertPrivatePath(file);return JSON.parse(fs.readFileSync(file,'utf8'));}
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function sanitized(url){try{const u=new URL(url);return `${u.hostname}:${u.port||5432}${u.pathname}`;}catch{return 'destino inválido';}}
function selectedEnvironment(){const env=process.env.FERRARO_ENV||'prod';if(!['dev','test','prod'].includes(env))throw new Error('FERRARO_ENV debe ser dev, test o prod.');return env;}
function manifestPath(env=selectedEnvironment()){return env==='test'?process.env.FERRARO_TEST_MANIFEST:path.join(stateRoot(),env+'.json');}
function context({environment=selectedEnvironment(),connectionString}={}){
  const file=manifestPath(environment);if(!file||!fs.existsSync(file))throw new Error(environment==='dev'?'DEV no está preparado. Ejecutá pnpm db:dev:setup.':environment==='test'?'TEST requiere el runner y su manifiesto privado.':'PROD no está identificado. Ejecutá db:prod:prepare para respaldar y registrar el destino, sin migrarlo.');
  const manifest=readPrivate(file);if(manifest.environment!==environment)throw new Error('Entorno cruzado: el manifiesto no corresponde al comando.');
  if(connectionString&&connectionString!==manifest.url)throw new Error('Conexión cruzada rechazada: la URL no coincide con el manifiesto.');
  if(environment==='test'&&(process.env.FERRARO_TEST_ISOLATED!=='1'||process.env.DATABASE_URL!==manifest.url))throw new Error('TEST sólo puede abrirse mediante el runner aislado.');
  return {...manifest,file};
}
async function identity(client){const r=(await client.query('SELECT current_database() database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) database_oid,(SELECT system_identifier::text FROM pg_control_system()) cluster_id')).rows[0];return r;}
async function validate(client,ctx){
  const found=await identity(client);if(digest(found)!==digest(ctx.identity))throw new Error('Identidad PostgreSQL distinta del destino registrado. No se habilitan escrituras.');
  const exists=(await client.query("SELECT to_regclass('ferraro_system.environment') IS NOT NULL ok")).rows[0].ok;
  if(ctx.environment==='prod'){if(exists){const m=(await client.query('SELECT environment FROM ferraro_system.environment WHERE id=true')).rows[0];if(m&&m.environment!=='prod')throw new Error('Un clúster DEV/TEST no se utiliza como PROD.');}return found;}
  if(!exists)throw new Error('Falta la identificación interna DEV/TEST.');
  const marker=(await client.query('SELECT * FROM ferraro_system.environment WHERE id=true')).rows[0];
  if(!marker||marker.environment!==ctx.environment||marker.instance_id!==ctx.instance_id||marker.secret_hash!==digest(ctx.secret)||marker.cluster_id!==found.cluster_id||String(marker.database_oid)!==found.database_oid)throw new Error('La identidad interna no coincide con el manifiesto: operación bloqueada.');
  return found;
}
async function registerSynthetic(client,{environment,url,file,clusterDirectory,purpose=environment==='dev'?'development':'tests',restoreProof=null}){
  if(!['dev','test'].includes(environment))throw new Error('Sólo se aprovisionan entornos sintéticos.');
  // Caller must have created this fresh independent cluster; it cannot enroll an arbitrary URL.
  const expected=path.resolve(clusterDirectory,'pgdata');if(!fs.existsSync(path.join(expected,'PG_VERSION')))throw new Error('Clúster local propio no identificado.');
  const dataDirectory=(await client.query('SHOW data_directory')).rows[0].data_directory;if(fs.realpathSync(dataDirectory)!==fs.realpathSync(expected))throw new Error('El servidor no es el clúster recién creado.');
  const tables=(await client.query("SELECT COUNT(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n;
  if(tables!==0){
    if(!restoreProof||purpose!=='production-restore')throw new Error('No se identifica como descartable una base con datos preexistentes.');
    const {Pool}=require('pg'),control=new Pool({connectionString:restoreProof.url,max:1});try{await validate(control,restoreProof);if((await identity(client)).cluster_id!==restoreProof.identity.cluster_id)throw new Error('La restauración no pertenece al clúster temporal de control.');}finally{await control.end();}
  }
  const id=crypto.randomUUID(),secret=crypto.randomBytes(32).toString('hex'),found=await identity(client);
  await client.query("CREATE SCHEMA IF NOT EXISTS ferraro_system; DROP TABLE IF EXISTS ferraro_system.environment; CREATE TABLE ferraro_system.environment(id boolean PRIMARY KEY CHECK(id),environment text NOT NULL,instance_id uuid NOT NULL,secret_hash text NOT NULL,cluster_id text NOT NULL,database_oid oid NOT NULL)");
  await client.query('INSERT INTO ferraro_system.environment VALUES(true,$1,$2,$3,$4,$5)',[environment,id,digest(secret),found.cluster_id,found.database_oid]);
  const manifest={environment,purpose,url,instance_id:id,secret,identity:found,cluster_directory:clusterDirectory,import_directory:path.join(clusterDirectory,'contracts'),created_at:new Date().toISOString()};writePrivate(file,manifest);return {...manifest,file};
}
function assertTestProof(){const ctx=context({environment:'test',connectionString:process.env.DATABASE_URL});if(ctx.purpose!=='tests'||!ctx.cluster_directory||!fs.existsSync(path.join(ctx.cluster_directory,'pgdata','PG_VERSION')))throw new Error('No hay prueba de clúster TEST sintético propio.');return ctx;}
function assertImportDirectory(value){if(selectedEnvironment()!=='dev')return;const ctx=context();if(path.resolve(String(value))!==path.resolve(ctx.import_directory)||fs.lstatSync(ctx.import_directory).isSymbolicLink())throw new Error('DEV sólo importa documentos de su carpeta sintética privada.');}
module.exports={ROOT,stateRoot,privateDirectory,writePrivate,readPrivate,digest,sanitized,selectedEnvironment,manifestPath,context,identity,validate,registerSynthetic,assertTestProof,assertImportDirectory};
