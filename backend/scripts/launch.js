const path=require('node:path'),{spawn}=require('node:child_process');
async function main(){
  const mode=process.argv[2];if(!['dev','prod'].includes(mode))throw new Error('Modo de arranque inválido.');
  if(require('node:fs').existsSync(path.resolve(__dirname,'../../.env')))process.loadEnvFile(path.resolve(__dirname,'../../.env'));
  process.env.FERRARO_ENV=mode;
  const {assertPortAvailable,verifyProductionStartup}=require('../src/lib/startup');
  const host=process.env.HOST||'127.0.0.1',port=Number(process.env.PORT||4173);
  require('../src/lib/access').assertSafeBinding(host);
  const verified=mode==='prod'?await verifyProductionStartup():null;
  await assertPortAvailable(host,port);
  if(mode==='dev'){
    for(const key of Object.keys(process.env))if(/^(WHATSAPP_|FERRARO_GATEWAY_|PROD_DATABASE_URL$|DATABASE_URL$)/.test(key))delete process.env[key];
    await require('../src/database/development').setupDev();process.env.AUTO_MIGRATE='true';
  }
  const {context,sanitized}=require('../src/database/environment'),ctx=verified||context();
  process.env.DATABASE_URL=ctx.url;
  console.log(`${mode.toUpperCase()}: ${sanitized(ctx.url)} (${mode==='prod'?'cartera real verificada; sin seeds ni migraciones de arranque':'desarrollo aislado; no es la cartera real'})`);
  const child=spawn(process.execPath,[...(mode==='dev'?['--watch']:[]),path.resolve(__dirname,'../src/server.js')],{stdio:'inherit',env:process.env});
  for(const s of ['SIGINT','SIGTERM'])process.once(s,()=>child.kill(s));child.on('error',error=>{console.error('No se pudo abrir el backend:',error.message);process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});
}
main().catch(e=>{console.error('Arranque bloqueado:',e.message);process.exitCode=1;});
