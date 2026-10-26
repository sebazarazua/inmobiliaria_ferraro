const config=require('../../config');
const {processWebhookPayload}=require('../whatsapp');

function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}

class WhatsAppGatewayClient{
  constructor(options=config.whatsapp.gateway){
    this.options=options;
    this.baseUrl=String(options.url||'').replace(/\/+$/,'');
  }
  isConfigured(){return Boolean(this.baseUrl&&this.options.secret);}
  async request(path,{method='POST',body=null}={}){
    if(!this.isConfigured()){
      const error=new Error('Gateway de WhatsApp no configurado.');
      error.code='GATEWAY_NOT_CONFIGURED';
      throw error;
    }
    const response=await fetch(`${this.baseUrl}${path}`,{
      method,
      headers:{
        'Authorization':`Bearer ${this.options.secret}`,
        'Content-Type':'application/json'
      },
      body:body?JSON.stringify(body):undefined
    });
    const payload=await response.json().catch(()=>({}));
    if(!response.ok){
      const error=new Error(payload.error||`Gateway respondio ${response.status}`);
      error.status=response.status;
      throw error;
    }
    return payload;
  }
  claim(limit=this.options.batchSize){return this.request('/api/whatsapp/events/claim',{body:{limit}});}
  ack(id,leaseToken){return this.request('/api/whatsapp/events/ack',{body:{id,leaseToken}});}
  nack(id,leaseToken,error){return this.request('/api/whatsapp/events/nack',{body:{id,leaseToken,error:String(error||'Error local')}});}
  status(){return this.request('/api/whatsapp/events/status',{method:'GET'});}
}

async function processClaimedEvent(db,client,event){
  try{
    const result=await processWebhookPayload(db,event.payload);
    await client.ack(event.id,event.leaseToken);
    return{id:event.id,ok:true,result};
  }catch(error){
    await client.nack(event.id,event.leaseToken,error.message).catch(nackError=>console.error('WhatsApp gateway nack:',nackError.message));
    return{id:event.id,ok:false,error:error.message};
  }
}

function createWhatsAppGatewayWorker(db,{client=new WhatsAppGatewayClient(),logger=console}={}){
  const options=config.whatsapp.gateway;
  let running=false;
  let stopped=false;
  let timer=null;

  const tick=async()=>{
    if(stopped||running||!client.isConfigured())return;
    running=true;
    try{
      const claimed=await client.claim(options.batchSize);
      for(const event of claimed.events||[])await processClaimedEvent(db,client,event);
    }catch(error){
      logger.error('WhatsApp gateway worker:',error.message);
      await sleep(Math.min(options.pollIntervalMs,5000));
    }finally{
      running=false;
    }
  };

  return{
    isConfigured:()=>client.isConfigured(),
    async start(){
      if(!client.isConfigured()){
        logger.log('WhatsApp gateway worker desactivado: faltan WHATSAPP_GATEWAY_URL o FERRARO_GATEWAY_SECRET.');
        return null;
      }
      await tick();
      timer=setInterval(tick,options.pollIntervalMs);
      timer.unref();
      logger.log(`WhatsApp gateway worker activo: consulta cada ${options.pollIntervalMs} ms.`);
      return timer;
    },
    stop(){
      stopped=true;
      if(timer)clearInterval(timer);
    },
    tick
  };
}

module.exports={WhatsAppGatewayClient,createWhatsAppGatewayWorker,processClaimedEvent};
