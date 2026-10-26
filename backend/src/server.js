const config=require('./config');
const {createApp}=require('./app');

async function main(){
  const app=await createApp({databaseUrl:config.databaseUrl});
  const timers=[];
  app.server.listen(config.port,config.host,async()=>{
    const scanTimer=await app.startScanner();
    if(scanTimer)timers.push(scanTimer);
    const whatsappGatewayTimer=await app.startWhatsAppGatewayWorker();
    if(whatsappGatewayTimer)timers.push(whatsappGatewayTimer);
    console.log(`Ferraro Propiedades activo en http://${config.host}:${config.port}`);
  });
  const shutdown=signal=>{console.log(`\n${signal}: cerrando servidor...`);for(const timer of timers)clearInterval(timer);app.server.close(async()=>{await app.db.end();process.exit(0);});};
  process.once('SIGINT',()=>shutdown('SIGINT'));process.once('SIGTERM',()=>shutdown('SIGTERM'));
}

main().catch(error=>{console.error('No se pudo iniciar:',error.message);process.exit(1);});
