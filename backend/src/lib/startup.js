const net=require('node:net');
const {Pool}=require('pg');
const E=require('../database/environment'),M=require('../database/migrations');

// Read-only preflight: never open the application or start background workers here.
async function verifyProductionStartup(){
  const ctx=E.context({environment:'prod'}),configured=process.env.PROD_DATABASE_URL||process.env.DATABASE_URL;
  if(configured&&configured!==ctx.url)throw new Error('La conexión PROD cambió. Revisá y prepará explícitamente el nuevo destino.');
  if(process.env.AUTO_MIGRATE==='true')throw new Error('AUTO_MIGRATE=true está prohibido en PROD. Usá AUTO_MIGRATE=false.');
  const db=new Pool({connectionString:ctx.url,max:1,connectionTimeoutMillis:5000,application_name:'ferraro:startup-readonly'});
  try{
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await E.validate(db,ctx);
    try{await M.assertCompatible(db);}catch(error){throw new Error(error.message+' PROD no se modificó. Ejecutá pnpm db:prod:prepare y solicitá autorización antes de pnpm db:prod:migrate.');}
    await db.query('ROLLBACK');return ctx;
  }finally{await db.end();}
}
async function assertPortAvailable(host,port){
  const probe=net.createServer();
  await new Promise((resolve,reject)=>{probe.once('error',error=>reject(new Error(error.code==='EADDRINUSE'?`El puerto ${port} ya está ocupado. Detené el backend anterior antes de cambiar entre pnpm app y pnpm dev. No se inició otro backend.`:`No se puede abrir ${host}:${port} (${error.code}).`)));probe.listen(port,host,resolve);});
  await new Promise((resolve,reject)=>probe.close(error=>error?reject(error):resolve()));
}
module.exports={verifyProductionStartup,assertPortAvailable};
