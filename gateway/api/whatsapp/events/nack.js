const {json,readRawBody,authBearer}=require('../../../lib/http');
const {timingSafeEqualText}=require('../../../lib/crypto');
const {nackEvent}=require('../../../lib/queue');

function authorized(req){
  return process.env.FERRARO_GATEWAY_SECRET&&timingSafeEqualText(authBearer(req),process.env.FERRARO_GATEWAY_SECRET);
}

module.exports=async function handler(req,res){
  try{
    if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
    if(!authorized(req))return json(res,401,{error:'Unauthorized'});
    const raw=await readRawBody(req,100_000);
    const input=raw.length?JSON.parse(raw.toString('utf8')):{};
    if(!input.id||!input.leaseToken)return json(res,400,{error:'id y leaseToken son obligatorios'});
    return json(res,200,await nackEvent(input.id,input.leaseToken,input.error));
  }catch(error){
    return json(res,error.status||500,{error:error.message||'Error inesperado'});
  }
};

module.exports.config={api:{bodyParser:false}};
