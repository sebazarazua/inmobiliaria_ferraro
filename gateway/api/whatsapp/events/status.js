const {json,authBearer}=require('../../../lib/http');
const {timingSafeEqualText}=require('../../../lib/crypto');
const {queueStats}=require('../../../lib/queue');

function authorized(req){
  return process.env.FERRARO_GATEWAY_SECRET&&timingSafeEqualText(authBearer(req),process.env.FERRARO_GATEWAY_SECRET);
}

module.exports=async function handler(req,res){
  try{
    if(req.method!=='GET')return json(res,405,{error:'Method not allowed'});
    if(!authorized(req))return json(res,401,{error:'Unauthorized'});
    return json(res,200,await queueStats());
  }catch(error){
    return json(res,error.status||500,{error:error.message||'Error inesperado'});
  }
};
