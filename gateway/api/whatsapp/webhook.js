const {json,text,readRawBody,requestIp}=require('../../lib/http');
const {verifyMetaSignature}=require('../../lib/crypto');
const {enqueuePayload}=require('../../lib/queue');
const {command}=require('../../lib/redis');

const RATE_LIMIT_WINDOW_SECONDS=Number(process.env.RATE_LIMIT_WINDOW_SECONDS||60);
const RATE_LIMIT_MAX=Number(process.env.RATE_LIMIT_MAX||120);
const RATE_PREFIX=process.env.RATE_LIMIT_PREFIX||'ferraro:whatsapp:rate';

async function rateLimit(req){
  const key=`${RATE_PREFIX}:${requestIp(req)}:${Math.floor(Date.now()/(RATE_LIMIT_WINDOW_SECONDS*1000))}`;
  const count=await command(['INCR',key]);
  if(Number(count)===1)await command(['EXPIRE',key,RATE_LIMIT_WINDOW_SECONDS+5]);
  return Number(count)<=RATE_LIMIT_MAX;
}

module.exports=async function handler(req,res){
  try{
    if(req.method==='GET'){
      const url=new URL(req.url,`https://${req.headers.host||'localhost'}`);
      if(url.searchParams.get('hub.mode')==='subscribe'&&url.searchParams.get('hub.verify_token')===process.env.WHATSAPP_VERIFY_TOKEN){
        return text(res,200,url.searchParams.get('hub.challenge')||'');
      }
      return text(res,403,'Forbidden');
    }
    if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
    if(!(await rateLimit(req)))return json(res,429,{error:'Rate limit'});
    const raw=await readRawBody(req);
    if(!verifyMetaSignature(raw,req.headers['x-hub-signature-256'],process.env.WHATSAPP_APP_SECRET)){
      return json(res,401,{error:'Firma de webhook invalida o WHATSAPP_APP_SECRET no configurado.'});
    }
    const payload=raw.length?JSON.parse(raw.toString('utf8')):{};
    const result=await enqueuePayload(payload,{receivedAt:new Date().toISOString()});
    return json(res,200,{queued:result.accepted.length,duplicates:result.duplicates});
  }catch(error){
    return json(res,error.status||500,{error:error.message||'Error inesperado'});
  }
};

module.exports.config={api:{bodyParser:false}};
