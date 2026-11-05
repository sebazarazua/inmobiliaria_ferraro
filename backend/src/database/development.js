const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Pool}=require('pg');
const {stateRoot,privateDirectory,readPrivate,validate,registerSynthetic}=require('./environment');
const {startCluster,stopCluster,run}=require('./cluster');
async function setupDev(){
  if(process.env.DATABASE_URL||process.env.PROD_DATABASE_URL){/* Explicitly ignored: DEV has its own private cluster. */}
  const root=privateDirectory(stateRoot()),file=path.join(root,'dev.json'),directory=path.join(root,'dev-cluster');
  if(fs.existsSync(file)){
    const ctx=readPrivate(file);if(ctx.environment!=='dev'||path.resolve(ctx.cluster_directory)!==directory)throw new Error('Manifiesto DEV incompatible. No se cambia el destino.');
    if(run('pg_ctl',['-D',path.join(directory,'pgdata'),'status'],{allowFailure:true}).status!==0)await startCluster(directory,{initialize:false,port:Number(new URL(ctx.url).port)});
    const db=new Pool({connectionString:ctx.url});try{await validate(db,ctx);}finally{await db.end();}return ctx;
  }
  if(fs.existsSync(directory))throw new Error('Existe un clúster DEV sin manifiesto; conservado para revisión, no se recrea.');
  const cluster=await startCluster(directory,{user:'ferraro_dev'}),db=new Pool({connectionString:cluster.url});let ctx;
  try{await db.query('CREATE DATABASE ferraro_dev');const url=cluster.url.replace(/\/postgres$/,'/ferraro_dev'),target=new Pool({connectionString:url});try{ctx=await registerSynthetic(target,{environment:'dev',url,file,clusterDirectory:directory});}finally{await target.end();}}finally{await db.end();}
  privateDirectory(ctx.import_directory);return ctx;
}
async function migrateDev(){const ctx=await setupDev(),old=process.env.FERRARO_ENV;process.env.FERRARO_ENV='dev';try{const db=await require('./index').openDatabase(undefined,{runMigrations:true});try{return await require('./migrations').status(db);}finally{await db.end();}}finally{if(old===undefined)delete process.env.FERRARO_ENV;else process.env.FERRARO_ENV=old;}}
async function resetDev(){
  const file=path.join(stateRoot(),'dev.json'),ctx=readPrivate(file),directory=path.join(stateRoot(),'dev-cluster');
  if(ctx.environment!=='dev'||ctx.purpose!=='development'||path.resolve(ctx.cluster_directory)!==directory)throw new Error('Reset rechazado: no es el DEV administrado.');
  const db=new Pool({connectionString:ctx.url});try{await validate(db,ctx);const active=(await db.query('SELECT COUNT(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()')).rows[0].n;if(active)throw new Error('Detené pnpm dev antes de reiniciar DEV.');}finally{await db.end();}
  stopCluster({data:path.join(directory,'pgdata')});
  // Recoverable reset, never a recursive deletion: retain the previous synthetic cluster.
  const archive=directory+'.retired-'+crypto.randomUUID();fs.renameSync(directory,archive);fs.renameSync(file,file+'.retired-'+crypto.randomUUID());
  await migrateDev();return {archived:archive};
}
module.exports={setupDev,migrateDev,resetDev};
