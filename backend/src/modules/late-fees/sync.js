const crypto=require('node:crypto');
const {importRates,PRODUCT}=require('./rates');
const {day,shift}=require('./common');
const ORIGIN='https://www.boletinoficial.gob.ar';
function discover(html){
  if(!/fechaSeleccionadaYMD\s*=\s*'\d{8}'/.test(html))throw new Error('No se reconoce el índice oficial; no se adivinan avisos.');
  const links=[];
  for(const m of html.matchAll(/<a\b[^>]*href="(\/detalleAviso\/primera\/\d+\/\d{8})"[^>]*>([\s\S]*?)<\/a>/gi)){
    const text=m[2].replace(/<[^>]+>/g,' ').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').toUpperCase();
    if(/BANCO DE LA NACION ARGENTINA/.test(text))links.push(ORIGIN+m[1]);
  }
  return [...new Set(links)];
}
async function status(db){
  const state=(await db.query('SELECT * FROM late_fee_sync_state WHERE id=true')).rows[0];
  const coverage=(await db.query('SELECT r.product,r.valid_from::text,r.valid_until::text,r.annual_percentage::text,s.url,s.content_hash,s.retrieved_at FROM late_fee_rates r JOIN late_fee_rate_sources s ON s.id=r.source_id ORDER BY r.valid_from,r.id')).rows;
  return {...state,product:PRODUCT,coverage,coverage_complete:false,coverage_note:'Sólo los intervalos enumerados están verificados; una sincronización exitosa no acredita cobertura completa.'};
}
async function syncRates(db,{fetchImpl=fetch,force=false,from=null,until=null,now=new Date()}={}){
  const client=await db.connect();let locked=false;
  try{
    locked=(await client.query("SELECT pg_try_advisory_lock(hashtext('ferraro:bna:sync')) locked")).rows[0].locked;if(!locked)return{status:'running'};
    const previous=(await client.query('SELECT * FROM late_fee_sync_state WHERE id=true')).rows[0],retryMs=(previous.status==='ok'?24:1)*60*60*1000;if(!force&&previous.checked_at&&now-new Date(previous.checked_at)<retryMs)return{...previous,skipped:true};
    const end=until?day(until):now.toISOString().slice(0,10),start=from?day(from):shift(end,-6);
    if(start>end||end>now.toISOString().slice(0,10)||new Date(end)-new Date(start)>30*86400000)throw new Error('Elegí hasta 31 días pasados para buscar avisos oficiales.');
    await client.query("UPDATE late_fee_sync_state SET checked_at=$1,status='running',error=NULL WHERE id=true",[now]);
    const indices=[],links=new Set(),errors=[];let imported=0,updated=false,networkFailure=false;
    const fetchIndex=async url=>{let response;try{response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(12000),headers:{Accept:'text/html'}});}catch(e){networkFailure=true;throw e;}if(!response.ok){networkFailure=true;throw new Error('No se pudo consultar el índice oficial.');}const html=await response.text();if(html.length>3_000_000)throw new Error('Índice oficial demasiado grande.');return html;};
    for(let date=start;date<=end;date=shift(date,1)){
      const url=ORIGIN+'/seccion/primera/'+date.replaceAll('-','');
      try{const html=await fetchIndex(url),found=discover(html);indices.push({url,sha256:crypto.createHash('sha256').update(html).digest('hex'),links:found});for(const link of found)links.add(link);}catch(e){errors.push(date+': '+e.message);if(indices.length===0)break;}
    }
    for(const url of [...links].slice(0,80)){
      try{const result=await importRates(db,{url},{fetchImpl});imported+=result.inserted_count??(result.replayed?0:result.count);if(!result.replayed)updated=true;}catch(e){errors.push(url+': '+e.message);}
    }
    const state=indices.length===0?(networkFailure?'offline':'error'):errors.length?'partial':'ok';
    await client.query('UPDATE late_fee_sync_state SET status=$1,error=$2,successful_at=CASE WHEN $1=\'ok\' THEN $3 ELSE successful_at END,updated_at=CASE WHEN $4 THEN $3 ELSE updated_at END,discovery_json=$5 WHERE id=true',[state,errors.join('\n').slice(0,6000)||null,now,updated,JSON.stringify({from:start,until:end,indices,links:[...links],imported})]);
    return await status(db);
  }finally{if(locked)await client.query("SELECT pg_advisory_unlock(hashtext('ferraro:bna:sync'))");client.release();}
}
function startRateSync(db){
  const tick=()=>syncRates(db).catch(e=>console.error('Tasas BNA:',e.message));
  // Do not block startup or administrative operations on network availability.
  void tick();const timer=setInterval(tick,60*60*1000);timer.unref();return timer;
}
module.exports={discover,syncRates,status,startRateSync};
