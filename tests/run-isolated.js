const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process'),{Pool}=require('pg');
const {temporaryRoot,startCluster,stopCluster,removeTemporary,diagnostics}=require('../backend/src/database/cluster');
const {registerSynthetic}=require('../backend/src/database/environment');
async function main(){
  const directory=temporaryRoot(),manifest=path.join(directory,'test.json');let cluster,child,failed=false;
  const interrupt=()=>{if(child)child.kill('SIGTERM');};process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
  try{
    cluster=await startCluster(directory);
    const name='ferraro_test_'+crypto.randomBytes(8).toString('hex'),url=cluster.url.slice(0,cluster.url.lastIndexOf('/')+1)+name,admin=new Pool({connectionString:cluster.url});
    try{await admin.query('CREATE DATABASE '+name);}finally{await admin.end();}
    const bootstrap=new Pool({connectionString:url});try{await registerSynthetic(bootstrap,{environment:'test',url,file:manifest,clusterDirectory:directory});}finally{await bootstrap.end();}
    const importDirectory=path.join(directory,'contracts');fs.mkdirSync(importDirectory);
    Object.assign(process.env,{FERRARO_ENV:'test',AUTO_MIGRATE:'false',DATABASE_URL:url,FERRARO_TEST_ISOLATED:'1',FERRARO_TEST_MANIFEST:manifest,FERRARO_TEST_IMPORT_DIRECTORY:importDirectory});
    delete process.env.PROD_DATABASE_URL;
    const db=await require('../backend/src/database').openDatabase(undefined,{runMigrations:true});
    try{const fixture=fs.readFileSync(path.join(__dirname,'fixtures','ipc-national-official.csv'),'utf8');await require('../backend/src/modules/ipc/store').refreshOfficialIndices(db,{fetchImpl:async()=>({ok:true,text:async()=>fixture})});}finally{await db.end();}
    console.log('TEST: clúster nuevo identificado; socket privado; base sintética descartable.');
    const files=process.argv.slice(2),defaults=['tests/app.test.js','tests/ipc.test.js','tests/lifecycle.test.js','tests/contract-ux.test.js','tests/p1-contracts.test.js','tests/services.test.js','tests/late-fees.test.js','tests/unified-finance.test.js','tests/stabilization.test.js','tests/database-operations.test.js'];
    child=spawn(process.execPath,['--test','--test-concurrency=1',...(files.length?files:defaults)],{stdio:'inherit',windowsHide:true,env:{...process.env}});
    process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code??1));});failed=process.exitCode!==0;
  }catch(e){failed=true;throw e;}finally{
    if(failed){fs.mkdirSync(path.join(__dirname,'../tmp/database-verification'),{recursive:true});fs.writeFileSync(path.join(__dirname,'../tmp/database-verification/postgres-failure.log'),diagnostics(directory),{mode:0o600});console.error('Diagnóstico PostgreSQL:',diagnostics(directory));}
    if(cluster)stopCluster(cluster);
    if(process.env.KEEP_TEST_DB==='1')console.log('Clúster detenido y conservado para revisión local.');else removeTemporary(directory);
  }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
