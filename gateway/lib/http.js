function json(res,status,payload){
  res.statusCode=status;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  res.end(JSON.stringify(payload));
}

function text(res,status,payload){
  res.statusCode=status;
  res.setHeader('Content-Type','text/plain; charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  res.end(String(payload));
}

async function readRawBody(req,limit=2_000_000){
  const chunks=[];
  let size=0;
  for await(const chunk of req){
    size+=chunk.length;
    if(size>limit){
      const error=new Error('Payload too large');
      error.status=413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function authBearer(req){
  const header=req.headers.authorization||'';
  const match=String(header).match(/^Bearer\s+(.+)$/i);
  return match?match[1]:'';
}

function requestIp(req){
  const forwarded=String(req.headers['x-forwarded-for']||'').split(',')[0].trim();
  return forwarded||req.socket?.remoteAddress||'unknown';
}

module.exports={json,text,readRawBody,authBearer,requestIp};
