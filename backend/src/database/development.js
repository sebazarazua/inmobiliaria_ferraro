const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Pool}=require('pg');
const {stateRoot,privateDirectory,writePrivate,readPrivate,validate,registerSynthetic,manifestPath}=require('./environment');
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
async function seedDev(){
  const old=process.env.FERRARO_ENV;process.env.FERRARO_ENV='dev';try{const db=await require('./index').openDatabase();try{if((await db.query('SELECT COUNT(*)::int n FROM contracts')).rows[0].n)return;
    const client=await db.connect();try{await client.query('BEGIN');const tenant=crypto.randomUUID(),property=crypto.randomUUID(),id=crypto.randomUUID();await client.query("INSERT INTO persons(id,full_name) VALUES($1,'Inquilino Sintético DEV')",[tenant]);await client.query("INSERT INTO properties(id,code,address,normalized_address,property_type) VALUES($1,'DEV-001','Propiedad Sintética DEV 100','propiedad sintetica dev 100','Departamento')",[property]);const start=new Date().toISOString().slice(0,7)+'-01',end=require('../lib/calendar').addMonths(start,12),last=new Date(end+'T00:00:00Z');last.setUTCDate(last.getUTCDate()-1);await client.query("INSERT INTO contracts(id,code,property_id,tenant_id,rental_type,duration_months,start_date,end_date,initial_amount,currency,adjustment_type,status) VALUES($1,'DEV-SINTETICO',$2,$3,'Residencial',12,$4,$5,100000,'ARS','MANUAL','Activo')",[id,property,tenant,start,last.toISOString().slice(0,10)]);await require('../modules/rent').generateInstallments(client,(await client.query('SELECT * FROM contracts WHERE id=$1',[id])).rows[0]);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }finally{await db.end();}}finally{if(old===undefined)delete process.env.FERRARO_ENV;else process.env.FERRARO_ENV=old;}
}
async function resetDev(){
  const file=path.join(stateRoot(),'dev.json'),ctx=readPrivate(file),directory=path.join(stateRoot(),'dev-cluster');
  if(ctx.environment!=='dev'||ctx.purpose!=='development'||path.resolve(ctx.cluster_directory)!==directory)throw new Error('Reset rechazado: no es el DEV administrado.');
  const db=new Pool({connectionString:ctx.url});try{await validate(db,ctx);const active=(await db.query('SELECT COUNT(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()')).rows[0].n;if(active)throw new Error('Detené pnpm dev antes de reiniciar DEV.');}finally{await db.end();}
  stopCluster({data:path.join(directory,'pgdata')});
  // Recoverable reset, never a recursive deletion: retain the previous synthetic cluster.
  const archive=directory+'.retired-'+crypto.randomUUID();fs.renameSync(directory,archive);fs.renameSync(file,file+'.retired-'+crypto.randomUUID());
  await migrateDev();await seedDev();return {archived:archive};
}
module.exports={setupDev,migrateDev,seedDev,resetDev};
