const crypto=require('node:crypto');
const {importRates,PRODUCT}=require('./rates');
const {day,shift}=require('./common');
const ORIGIN='https://www.boletinoficial.gob.ar';
// Recovery is bounded: only the period actually needed by BNA-rate installments, in small batches.
const RECENT_DAYS=7,AUTO_BATCH_DAYS=14,LEAD_DAYS=10,MAX_LOOKBACK_DAYS=1095,MAX_LINKS_PER_RUN=80;
const FINAL_STATUSES=['no_publication','unsupported_notice','imported'];
const RETRYABLE_STATUSES=['index_error','network_error','format_error','source_error'];
const DAY_LABELS={no_publication:'Sin publicación oficial del BNA ese día',unsupported_notice:'Aviso del BNA sin la serie soportada',imported:'Publicación verificada',index_error:'Error HTTP del Boletín Oficial',network_error:'Sin conexión',format_error:'Formato de página no reconocido',source_error:'No se pudo leer el aviso',contradiction:'Contradice una tasa ya verificada: requiere revisión'};

function discover(html){
  if(!/fechaSeleccionadaYMD\s*=\s*'\d{8}'/.test(html))throw new Error('No se reconoce el índice oficial; no se adivinan avisos.');
  const links=[];
  for(const m of html.matchAll(/<a\b[^>]*href="(\/detalleAviso\/primera\/\d+\/\d{8})"[^>]*>([\s\S]*?)<\/a>/gi)){
    const text=m[2].replace(/<[^>]+>/g,' ').normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/\s+/g,' ').toUpperCase();
    if(/BANCO DE LA NACION ARGENTINA/.test(text))links.push(ORIGIN+m[1]);
  }
  return [...new Set(links)];
}
// The index can answer with the nearest edition on weekends and holidays: that is not a publication of the requested day.
function editionDate(html){const m=html.match(/fechaSeleccionadaYMD\s*=\s*'(\d{4})(\d{2})(\d{2})'/);return m?`${m[1]}-${m[2]}-${m[3]}`:null;}

// Days whose interest needs the BNA series: overdue installments of contracts (or the internal policy) using that modality.
async function requiredCoverage(db,today){
  const policy=(await db.query("SELECT value FROM settings WHERE key='late_fee_policy'")).rows[0];
  let policyBna=false;try{policyBna=JSON.parse(policy?.value||'{}').mode==='bna';}catch{policyBna=false;}
  const row=(await db.query(`WITH bna_contracts AS (
      SELECT c.id FROM contracts c WHERE c.status NOT IN ('Anulado','Borrador') AND ($2::boolean OR c.late_fee_json->>'type'='BANK_ACTIVE_RATE'
        OR (SELECT r.terms_json->>'type' FROM late_fee_reviews r WHERE r.contract_id=c.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1)='BANK_ACTIVE_RATE'))
    SELECT MIN(i.due_date)::text required_from,COUNT(*)::int installments FROM installments i JOIN bna_contracts b ON b.id=i.contract_id
    WHERE i.currency='ARS' AND i.status<>'Sustituido' AND i.due_date<$1::date
      AND (i.status<>'Pagado' OR (i.late_fee_calculated_amount IS NULL AND EXISTS (SELECT 1 FROM payments p WHERE p.installment_id=i.id AND p.paid_at>i.due_date)))`,[today,policyBna])).rows[0];
  if(!row.required_from)return{required:false,from:null,until:today,installments:0,truncated_before:null};
  const floor=shift(today,-MAX_LOOKBACK_DAYS);
  return{required:true,from:row.required_from<floor?floor:row.required_from,until:today,installments:row.installments,truncated_before:row.required_from<floor?row.required_from:null};
}
// Uncovered inclusive day ranges inside [from, until]; rates are half-open [valid_from, valid_until).
function gaps(rates,from,until){
  const end=shift(until,1),out=[];let cursor=from;
  for(const r of [...rates].sort((a,b)=>a.valid_from<b.valid_from?-1:a.valid_from>b.valid_from?1:0)){
    if(cursor>=end)break;if(r.valid_until<=cursor)continue;
    if(r.valid_from>cursor){const stop=r.valid_from<end?r.valid_from:end;out.push({from:cursor,until:shift(stop,-1)});}
    if(r.valid_until>cursor)cursor=r.valid_until;
  }
  if(cursor<end)out.push({from:cursor,until});
  return out.filter(g=>g.from<=g.until);
}
const retryAfterMs=attempts=>Math.min(24,2**Math.max(0,attempts-1))*60*60*1000;
// Older bulletin days still needed for the gaps, excluding the recent window, finished days and contradictions.
async function backlogDays(db,gapList,today,now){
  const recentStart=shift(today,-(RECENT_DAYS-1)),wanted=new Set();
  for(const g of gapList)for(let d=shift(g.from,-LEAD_DAYS);d<=g.until&&d<recentStart;d=shift(d,1))wanted.add(d);
  if(!wanted.size)return[];
  const known=new Map((await db.query('SELECT day::text,status,attempts,last_attempt_at FROM late_fee_sync_days WHERE day=ANY($1::date[])',[[...wanted]])).rows.map(r=>[r.day,r]));
  return [...wanted].filter(d=>{const k=known.get(d);if(!k)return true;if(RETRYABLE_STATUSES.includes(k.status))return now-new Date(k.last_attempt_at)>=retryAfterMs(k.attempts);return false;}).sort().reverse();
}
async function recordDay(db,date,result){
  await db.query(`INSERT INTO late_fee_sync_days(day,status,links_json,index_sha256,error) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(day) DO UPDATE SET status=excluded.status,attempts=late_fee_sync_days.attempts+1,last_attempt_at=now(),links_json=excluded.links_json,index_sha256=excluded.index_sha256,error=excluded.error`,[date,result.status,JSON.stringify(result.links||[]),result.sha256||null,result.error||null]);
}
async function processDay(db,date,{fetchImpl,linkBudget}){
  const url=ORIGIN+'/seccion/primera/'+date.replaceAll('-','');let response,html;
  try{response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(12000),headers:{Accept:'text/html'}});}catch(e){return{status:'network_error',error:e.message,url};}
  if(!response.ok)return{status:'index_error',error:`HTTP ${response.status}`,url};
  try{html=await response.text();}catch(e){return{status:'network_error',error:e.message,url};}
  if(html.length>3_000_000)return{status:'index_error',error:'Índice oficial demasiado grande.',url};
  const sha256=crypto.createHash('sha256').update(html).digest('hex');
  let links;try{links=discover(html);}catch(e){return{status:'format_error',error:e.message,url,sha256};}
  if(editionDate(html)!==date)return{status:'no_publication',url,sha256,links:[]};
  if(!links.length)return{status:'no_publication',url,sha256,links:[]};
  const outcomes=[];let imported=0,updated=false;
  for(const link of links){
    if(linkBudget.remaining<=0){outcomes.push({link,status:'source_error',error:'Límite de avisos por ejecución; se reintenta luego.'});continue;}
    linkBudget.remaining--;
    try{const r=await importRates(db,{url:link},{fetchImpl});imported+=r.inserted_count??0;if(!r.replayed)updated=true;outcomes.push({link,status:'imported'});}
    catch(e){outcomes.push({link,status:/contradice/i.test(e.message)?'contradiction':/No se encontró la modalidad/i.test(e.message)?'unsupported_notice':'source_error',error:e.message});}
  }
  const has=s=>outcomes.some(o=>o.status===s);
  const status=has('contradiction')?'contradiction':has('source_error')?'source_error':has('imported')?'imported':'unsupported_notice';
  return{status,url,sha256,links:outcomes,imported,updated,error:outcomes.filter(o=>o.error).map(o=>o.error).join(' | ')||null};
}

async function status(db,{now=new Date()}={}){
  const state=(await db.query('SELECT * FROM late_fee_sync_state WHERE id=true')).rows[0];
  const coverage=(await db.query('SELECT r.product,r.valid_from::text,r.valid_until::text,r.annual_percentage::text,s.url,s.content_hash,s.retrieved_at FROM late_fee_rates r JOIN late_fee_rate_sources s ON s.id=r.source_id WHERE r.product=$1 ORDER BY r.valid_from,r.id',[PRODUCT])).rows;
  const today=now.toISOString().slice(0,10),required=await requiredCoverage(db,today),gapList=required.required?gaps(coverage,required.from,today):[];
  const pending=required.required?(await backlogDays(db,gapList,today,new Date(8.64e15))).length:0;
  const failures=(await db.query(`SELECT day::text,status,attempts,last_attempt_at,error FROM late_fee_sync_days WHERE status<>ALL($1::text[]) ORDER BY day DESC LIMIT 30`,[FINAL_STATUSES])).rows.map(r=>({...r,label:DAY_LABELS[r.status]}));
  const latest=(await db.query('SELECT MAX(s.retrieved_at) retrieved_at,MAX(r.valid_until)::text valid_until FROM late_fee_rates r JOIN late_fee_rate_sources s ON s.id=r.source_id WHERE r.product=$1',[PRODUCT])).rows[0];
  const {discovery_json:_discovery,...rest}=state;
  return{...rest,product:PRODUCT,coverage,required,gaps:gapList,coverage_complete:required.required&&!gapList.length,pending_recovery_days:pending,failures,
    last_verified_publication:latest.retrieved_at?{retrieved_at:latest.retrieved_at,valid_until:latest.valid_until}:null,
    coverage_note:!required.required?'Ninguna cuota vencida requiere hoy la serie BNA. Sólo los intervalos enumerados están verificados.':gapList.length?`Faltan tasas oficiales verificadas para ${gapList.length} intervalo(s); los punitorios de esos días quedan bloqueados hasta recuperarlas.`:'Las cuotas que usan la serie BNA tienen cobertura oficial verificada hasta hoy.'};
}

// Manual runs query an explicit range (≤31 days). Automatic runs re-check the last week and resume the backlog
// of older gaps in bounded batches; every day's outcome is persisted so restarts never repeat finished work.
async function syncRates(db,{fetchImpl=fetch,force=false,from=null,until=null,now=new Date(),batchDays=AUTO_BATCH_DAYS}={}){
  const client=await db.connect();let locked=false;
  try{
    locked=(await client.query("SELECT pg_try_advisory_lock(hashtext('ferraro:bna:sync')) locked")).rows[0].locked;if(!locked)return{status:'running'};
    const previous=(await client.query('SELECT * FROM late_fee_sync_state WHERE id=true')).rows[0],today=now.toISOString().slice(0,10),manual=Boolean(from||until);
    let days,plan={mode:manual?'manual':'automatic'};
    if(manual){
      const end=until?day(until):today,start=from?day(from):shift(end,-(RECENT_DAYS-1));
      if(start>end||end>today||new Date(end)-new Date(start)>30*86400000)throw new Error('Elegí hasta 31 días pasados para buscar avisos oficiales.');
      days=[];for(let d=end;d>=start;d=shift(d,-1))days.push(d);
    }else{
      const required=await requiredCoverage(db,today),rates=(await db.query('SELECT valid_from::text,valid_until::text FROM late_fee_rates WHERE product=$1',[PRODUCT])).rows;
      const gapList=required.required?gaps(rates,required.from,today):[],backlog=await backlogDays(db,gapList,today,now);
      const retryMs=(previous.status==='ok'?24:1)*60*60*1000,recentDue=force||!previous.checked_at||now-new Date(previous.checked_at)>=retryMs;
      if(!recentDue&&!backlog.length)return{...(await status(db,{now})),skipped:true};
      days=[];if(recentDue)for(let i=0;i<RECENT_DAYS;i++)days.push(shift(today,-i));
      days.push(...backlog.slice(0,batchDays));
      plan={...plan,required_from:required.from,truncated_before:required.truncated_before,gaps:gapList,backlog_before:backlog.length,batch:backlog.slice(0,batchDays)};
    }
    await client.query("UPDATE late_fee_sync_state SET checked_at=$1,status='running',error=NULL WHERE id=true",[now]);
    const results=[],linkBudget={remaining:MAX_LINKS_PER_RUN};let updated=false,reachable=false;
    for(const date of days){
      const result=await processDay(db,date,{fetchImpl,linkBudget});
      if(result.status==='network_error'&&!reachable){results.push({day:date,...result});await recordDay(db,date,result);break;} // offline: stop instead of hammering every day
      if(!['network_error','index_error'].includes(result.status))reachable=true;
      if(result.updated)updated=true;
      results.push({day:date,...result});await recordDay(db,date,result);
    }
    const errors=results.filter(r=>!FINAL_STATUSES.includes(r.status));
    const state=!reachable?(results.some(r=>r.status==='network_error')?'offline':'error'):errors.length?'partial':'ok';
    const summary=results.map(r=>({day:r.day,status:r.status,label:DAY_LABELS[r.status],error:r.error||null}));
    await client.query(`UPDATE late_fee_sync_state SET status=$1,error=$2,successful_at=CASE WHEN $1='ok' THEN $3 ELSE successful_at END,updated_at=CASE WHEN $4 THEN $3 ELSE updated_at END,discovery_json=$5,recovery_json=$6 WHERE id=true`,
      [state,errors.map(r=>`${r.day}: ${DAY_LABELS[r.status]}${r.error?` (${r.error})`:''}`).join('\n').slice(0,6000)||null,now,updated,JSON.stringify({days:summary}),JSON.stringify({...plan,completed_at:now.toISOString(),results:summary})]);
    return await status(db,{now});
  }finally{if(locked)await client.query("SELECT pg_advisory_unlock(hashtext('ferraro:bna:sync'))");client.release();}
}
function startRateSync(db){
  const tick=()=>syncRates(db).catch(e=>console.error('Tasas BNA:',e.message));
  // Do not block startup or administrative operations on network availability.
  void tick();const timer=setInterval(tick,60*60*1000);timer.unref();return timer;
}
module.exports={discover,editionDate,gaps,requiredCoverage,syncRates,status,startRateSync,DAY_LABELS};
