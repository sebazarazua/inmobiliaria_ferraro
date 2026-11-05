const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawnSync}=require('node:child_process');
function pgBin(){
  if(process.env.PG_BIN)return process.env.PG_BIN;
  const candidates=process.platform==='darwin'?['/opt/homebrew/opt/postgresql@17/bin','/usr/local/opt/postgresql@17/bin']:process.platform==='linux'?['/usr/lib/postgresql/17/bin','/usr/lib/postgresql/16/bin']:[];
  return candidates.find(p=>fs.existsSync(path.join(p,'pg_ctl')))||'';
}
const executable=name=>path.join(pgBin(),name+(process.platform==='win32'?'.exe':''));
function run(name,args,{env=process.env,allowFailure=false,privateErrors=false}={}){
  const result=spawnSync(executable(name),args,{env,encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:4*1024*1024});
  if(result.status!==0&&!allowFailure){const error=new Error(`${name} falló (${result.status??result.error?.code}). ${privateErrors?'El detalle se conserva sólo en el diagnóstico privado de la preparación.':result.stderr||''}`);if(privateErrors)error.nativeDetail=result.stderr||result.error?.message;throw error;}
  return result;
}
async function freePort(){const s=net.createServer();await new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',r);});const p=s.address().port;await new Promise(r=>s.close(r));return p;}
function diagnostics(directory){const file=path.join(directory,'postgres.log');return fs.existsSync(file)?fs.readFileSync(file,'utf8').slice(-16000):'No se creó postgres.log.';}
async function startCluster(directory,{user='ferraro_test',port,initialize=true,extraOptions=''}={}){
  fs.mkdirSync(directory,{recursive:true,mode:0o700});fs.chmodSync(directory,0o700);
  const data=path.join(directory,'pgdata'),socket=path.join(directory,'socket');fs.mkdirSync(socket,{recursive:true,mode:0o700});
  if(initialize)run('initdb',['-D',data,'-U',user,'-A','trust','--encoding=UTF8','--locale=C']);
  port=port||await freePort();
  // PostgreSQL packages on Ubuntu default to a system socket directory not owned by runner.
  // Use a short, private socket path on Unix (macOS has a small sockaddr_un limit).
  const socketOption=process.platform==='win32'?'':` -k "${socket}"`;
  const result=run('pg_ctl',['-D',data,'-l',path.join(directory,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port}${socketOption} ${extraOptions}`,'-w','-t','30','start'],{allowFailure:true});
  if(result.status!==0){const message=diagnostics(directory);run('pg_ctl',['-D',data,'-m','fast','-w','stop'],{allowFailure:true});throw new Error(`PostgreSQL temporal no inició. ${message}`);}
  return {directory,data,socket,port,user,url:`postgresql://${user}@127.0.0.1:${port}/postgres`};
}
function stopCluster(cluster){const result=run('pg_ctl',['-D',cluster.data,'-m','fast','-w','-t','30','stop'],{allowFailure:true});if(result.status!==0&&fs.existsSync(path.join(cluster.data,'postmaster.pid')))throw new Error('No se pudo detener el clúster; se conserva el directorio para diagnóstico.');}
function temporaryRoot(prefix='ferraro-test-'){return fs.mkdtempSync(path.join(process.platform==='darwin'?'/tmp':os.tmpdir(),prefix));}
function removeTemporary(directory){const resolved=path.resolve(directory),parent=fs.realpathSync(path.dirname(resolved)),base=path.basename(resolved);if(![os.tmpdir(),'/tmp'].filter(p=>fs.existsSync(p)).map(p=>fs.realpathSync(p)).includes(parent)||!/^ferraro-(?:test|restore|dbtest|ci-repro)-/.test(base))throw new Error('Limpieza rechazada: ruta ajena a clúster temporal.');fs.rmSync(resolved,{recursive:true,force:true});}
module.exports={pgBin,executable,run,freePort,startCluster,stopCluster,temporaryRoot,removeTemporary,diagnostics};
