const baseUrl=(process.env.UPSTASH_REDIS_REST_URL||process.env.KV_REST_API_URL||'').replace(/\/+$/,'');
const token=process.env.UPSTASH_REDIS_REST_TOKEN||process.env.KV_REST_API_TOKEN||'';

function isConfigured(){return Boolean(baseUrl&&token);}

async function command(args,path=''){
  if(!isConfigured()){
    const error=new Error('Upstash Redis no configurado. Faltan UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN.');
    error.status=500;
    throw error;
  }
  const response=await fetch(`${baseUrl}${path}`,{
    method:'POST',
    headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify(args)
  });
  const body=await response.json().catch(()=>({}));
  if(!response.ok||body.error){
    const error=new Error(body.error||`Upstash Redis respondio ${response.status}`);
    error.status=response.status;
    throw error;
  }
  return body.result;
}

async function pipeline(commands){
  if(!isConfigured()){
    const error=new Error('Upstash Redis no configurado. Faltan UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN.');
    error.status=500;
    throw error;
  }
  const response=await fetch(`${baseUrl}/pipeline`,{
    method:'POST',
    headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify(commands)
  });
  const body=await response.json().catch(()=>[]);
  if(!response.ok){
    const error=new Error(body.error||`Upstash Redis respondio ${response.status}`);
    error.status=response.status;
    throw error;
  }
  return body;
}

module.exports={command,pipeline,isConfigured};
