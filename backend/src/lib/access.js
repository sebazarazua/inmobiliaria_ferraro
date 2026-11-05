// Barriers for the local, single-operator deployment. There are no user accounts: the server must only be
// reachable from this computer, and a web page from another site must not be able to drive it.
const LOOPBACK_HOSTS=['127.0.0.1','localhost','::1'];
const SAFE_METHODS=['GET','HEAD','OPTIONS'];
// Server-to-server and signature-verified: Meta does not send browser headers.
const EXEMPT_PATHS=['/api/whatsapp/webhook'];

function hostname(value){
  const text=String(value||'').trim().toLowerCase();
  if(!text)return'';
  if(text.startsWith('['))return text.slice(1,text.indexOf(']'));
  return text.replace(/:\d+$/,'');
}
function allowedHosts(env=process.env){
  const extra=String(env.FERRARO_ALLOWED_HOSTS||'').split(',').map(hostname).filter(Boolean);
  let configured='';try{configured=env.PUBLIC_BASE_URL?hostname(new URL(env.PUBLIC_BASE_URL).host):'';}catch{configured='';}
  return new Set([...LOOPBACK_HOSTS,...extra,...(configured?[configured]:[])]);
}
function isLoopback(host){return LOOPBACK_HOSTS.includes(hostname(host))||/^127\./.test(hostname(host));}

// Returns null when the request may proceed, or {status,error} to reject it.
function checkRequest(req,pathname,{hosts=allowedHosts()}={}){
  if(EXEMPT_PATHS.includes(pathname))return null;
  // DNS rebinding: a hostile domain resolving to 127.0.0.1 still sends its own Host header.
  if(!hosts.has(hostname(req.headers.host)))return{status:421,error:'Host no autorizado para este servidor local.'};
  if(!pathname.startsWith('/api/')||SAFE_METHODS.includes(req.method))return null;
  const origin=req.headers.origin,site=req.headers['sec-fetch-site'];
  if(origin!==undefined){
    let originHost=null;try{originHost=origin==='null'?null:hostname(new URL(origin).host);}catch{originHost=null;}
    if(!originHost||!hosts.has(originHost)||hostname(req.headers.host)!==originHost)return{status:403,error:'Solicitud rechazada: proviene de otro sitio.'};
  }
  if(site!==undefined&&!['same-origin','none'].includes(String(site).toLowerCase()))return{status:403,error:'Solicitud rechazada: proviene de otro sitio.'};
  // HTML forms can only send text/plain, urlencoded or multipart; JSON bodies require a script on our own page.
  const type=String(req.headers['content-type']||'').toLowerCase();
  const length=Number(req.headers['content-length']||0),hasBody=length>0||req.headers['transfer-encoding']!==undefined;
  if(hasBody&&!type.startsWith('application/json')&&!type.startsWith('multipart/form-data'))return{status:415,error:'Tipo de contenido no admitido.'};
  return null;
}
function securityHeaders(res){
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"frame-ancestors 'none'");
  res.setHeader('Referrer-Policy','no-referrer');
}
// Without authentication the API must not listen on a network interface unless explicitly acknowledged.
function assertSafeBinding(host,env=process.env){
  if(isLoopback(host))return;
  if(env.FERRARO_ALLOW_UNAUTHENTICATED_NETWORK==='true'){console.warn(`ADVERTENCIA: escuchando en ${host} sin autenticación. Cualquier equipo de la red puede operar la cartera.`);return;}
  throw new Error(`HOST=${host} expone el sistema a la red y no hay autenticación de usuarios. Usá HOST=127.0.0.1 (ver docs/SEGURIDAD_ACCESO.md).`);
}
module.exports={checkRequest,securityHeaders,assertSafeBinding,allowedHosts,hostname,isLoopback};
