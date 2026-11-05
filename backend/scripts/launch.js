const path=require('node:path'),{spawn}=require('node:child_process');
async function main(){
  const mode=process.argv[2];if(!['dev','prod'].includes(mode))throw new Error('Modo de arranque inválido.');
  if(require('node:fs').existsSync(path.resolve(__dirname,'../../.env')))process.loadEnvFile(path.resolve(__dirname,'../../.env'));
  process.env.FERRARO_ENV=mode;
  if(mode==='dev'){
    for(const key of Object.keys(process.env))if(/^(WHATSAPP_|FERRARO_GATEWAY_|PROD_DATABASE_URL$|DATABASE_URL$)/.test(key))delete process.env[key];
    await require('../src/database/development').setupDev();process.env.AUTO_MIGRATE='true';
  }
  const {context,sanitized}=require('../src/database/environment'),ctx=context();
  if(mode==='prod'&&(process.env.PROD_DATABASE_URL||process.env.DATABASE_URL)&&(process.env.PROD_DATABASE_URL||process.env.DATABASE_URL)!==ctx.url)throw new Error('La conexión PROD cambió. Revisá y prepará explícitamente el nuevo destino.');
  process.env.DATABASE_URL=ctx.url;
  console.log(`${mode.toUpperCase()}: ${sanitized(ctx.url)} (identificación interna requerida)`);
  const child=spawn(process.execPath,[...(mode==='dev'?['--watch']:[]),path.resolve(__dirname,'../src/server.js')],{stdio:'inherit',env:process.env});
  for(const s of ['SIGINT','SIGTERM'])process.once(s,()=>child.kill(s));child.on('exit',code=>{process.exitCode=code??1;});
}
main().catch(e=>{console.error('Arranque bloqueado:',e.message);process.exitCode=1;});
