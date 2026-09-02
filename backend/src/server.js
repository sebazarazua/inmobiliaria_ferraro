const config=require('./config');
const {createApp}=require('./app');

async function main(){
  const app=await createApp({databaseUrl:config.databaseUrl});
  let scanTimer;
  app.server.listen(config.port,config.host,async()=>{
    scanTimer=await app.startScanner();
    console.log(`Ferraro Propiedades activo en http://${config.host}:${config.port}`);
  });
  const shutdown=signal=>{console.log(`\n${signal}: cerrando servidor...`);if(scanTimer)clearInterval(scanTimer);app.server.close(async()=>{await app.db.end();process.exit(0);});};
  process.once('SIGINT',()=>shutdown('SIGINT'));process.once('SIGTERM',()=>shutdown('SIGTERM'));
}

main().catch(error=>{console.error('No se pudo iniciar:',error.message);process.exit(1);});
