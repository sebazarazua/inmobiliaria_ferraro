// Creates a new cluster; never uses DATABASE_URL or an existing database.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process');
const {Pool}=require('pg');
async function main(){
  const bin=process.env.PG_BIN||(process.platform==='win32'?'C:\\Program Files\\PostgreSQL\\18\\bin':'');
  const executable=name=>bin?path.join(bin,name+(process.platform==='win32'?'.exe':'')):name;
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ferraro-ipc-test-')),data=path.join(directory,'pgdata');
  const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const run=(name,args)=>{const r=spawnSync(executable(name),args,{stdio:'inherit',windowsHide:true});if(r.status!==0)throw new Error(`${name}: exit ${r.status} ${r.error||''}`);};
  let started=false;
  try{
    run('initdb',['-D',data,'-U','ferraro_test','-A','trust','--encoding=UTF8','--locale=C']);
    run('pg_ctl',['-D',data,'-l',path.join(directory,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port}`,'-w','start']);started=true;
    const name=`ferraro_test_${crypto.randomBytes(8).toString('hex')}`,url=`postgresql://ferraro_test@127.0.0.1:${port}/${name}`;
    const admin=new Pool({connectionString:`postgresql://ferraro_test@127.0.0.1:${port}/postgres`});try{await admin.query(`CREATE DATABASE ${name}`);}finally{await admin.end();}
    const importDirectory=path.join(directory,'contracts');fs.mkdirSync(importDirectory);
    process.env.FERRARO_TEST_ISOLATED='1';process.env.FERRARO_TEST_IMPORT_DIRECTORY=importDirectory;
    const db=await require('../backend/src/database').openDatabase(url);
    try{
      const fixture=fs.readFileSync(path.join(__dirname,'fixtures','ipc-national-official.csv'),'utf8');
      await require('../backend/src/modules/ipc/store').refreshOfficialIndices(db,{fetchImpl:async()=>({ok:true,text:async()=>fixture})});
    }finally{await db.end();}
    console.log(`Base aislada: ${name} en 127.0.0.1:${port}`);
    const files=process.argv.slice(2),child=spawn(process.execPath,['--test','--test-concurrency=1',...(files.length?files:['tests/app.test.js','tests/ipc.test.js'])],{stdio:'inherit',windowsHide:true,env:{...process.env,DATABASE_URL:url,FERRARO_TEST_ISOLATED:'1',FERRARO_TEST_IMPORT_DIRECTORY:importDirectory}});
    process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code??1));});
  }finally{
    if(started)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);
    if(process.env.KEEP_TEST_DB==='1')console.log(`Cluster de pruebas detenido: ${directory}`);
    else {
      if(path.dirname(path.resolve(directory))!==path.resolve(os.tmpdir())||!path.basename(directory).startsWith('ferraro-ipc-test-'))throw new Error('Ruta de limpieza de pruebas inválida.');
      fs.rmSync(directory,{recursive:true,force:true});
    }
  }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
