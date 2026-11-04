const crypto=require('node:crypto');
const {uid}=require('../../database');
const {actor,day}=require('./common');
const PRODUCT='BNA_CARTERA_GENERAL_TNA_VENCIDA_30D';
const productLabel='BNA · cartera general (préstamos) · TNA vencida a 30 días · pesos';
function sourceUrl(value){const url=new URL(String(value));if(url.protocol!=='https:'||!['www.boletinoficial.gov.ar','www.boletinoficial.gob.ar'].includes(url.hostname)||!/^\/detalleAviso\/primera\/\d+\/\d{8}$/.test(url.pathname)||url.search||url.hash||url.username||url.password||url.port)throw new Error('Usá el enlace HTTPS de un aviso del BNA en www.boletinoficial.gov.ar.');return url.href;}
function htmlText(value){return String(value).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&[a-z]+;/gi,' ').replace(/\s+/g,' ').trim();}
function parseOfficialBulletin(html){
  const text=htmlText(html).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
  if(!text.includes('BANCO DE LA NACION ARGENTINA')||!text.includes('TASA ACTIVA CARTERA GENERAL (PRESTAMOS)'))throw new Error('No se encontró la modalidad oficial de cartera general.');
  const table=[...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map(m=>m[1]).find(t=>htmlText(t).includes('TASA NOMINAL ANUAL VENCIDA'));
  if(!table)throw new Error('Formato oficial no reconocido: no se importó ninguna tasa.');
  let mode=null,columnsVerified=false;const entries=[];
  for(const tr of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){
    const cells=[...tr[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m=>htmlText(m[1])),joined=cells.join(' ').toUpperCase();
    if(joined.includes('FECHA')&&['30','60','90','120','150','180'].every((c,i)=>cells[i+1]===c))columnsVerified=true;
    if(joined.includes('TASA NOMINAL ANUAL ADELANTADA'))mode='advanced';
    else if(joined.includes('TASA NOMINAL ANUAL VENCIDA'))mode='expired';
    else if(mode==='expired'&&cells[0]==='Desde el'){
      if(!columnsVerified||cells.length!==12||cells[2]!=='al')throw new Error('No se pudo verificar la columna de 30 días del aviso.');
      const parseDate=s=>{if(!/^\d{2}\/\d{2}\/\d{4}$/.test(s))throw Error('Fecha oficial no reconocida.');return day(s.split('/').reverse().join('-'));};
      if(!/^\d{1,3},\d{2}$/.test(cells[4]))throw new Error('Tasa oficial no reconocida.');
      const from=parseDate(cells[1]),until=parseDate(cells[3]);if(until<=from)throw new Error('Intervalo oficial inválido.');
      entries.push({product:PRODUCT,valid_from:from,valid_until:until,annual_percentage:cells[4].replace(',','.')});
    }
  }
  if(!entries.length||entries.length>100)throw new Error('No hay intervalos históricos verificables.');
  for(let i=1;i<entries.length;i++)if(entries[i].valid_from!==entries[i-1].valid_until)throw new Error('La tabla oficial no tiene intervalos contiguos reconocibles.');
  return entries;
}
async function importRates(db,input,{fetchImpl=fetch}={}){
  const url=sourceUrl(input.url),response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(20000),headers:{Accept:'text/html'}});
  if(!response.ok)throw new Error('No se pudo consultar el aviso oficial. No se importaron tasas.');
  const html=await response.text();if(html.length>1_500_000)throw new Error('El aviso supera el tamaño admitido.');
  const entries=parseOfficialBulletin(html),digest=crypto.createHash('sha256').update(html).digest('hex'),client=await db.connect();
  try{await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtext('ferraro:ipc:write'))");
    const existing=(await client.query('SELECT id FROM late_fee_rate_sources WHERE content_hash=$1',[digest])).rows[0];if(existing){await client.query('ROLLBACK');return {id:existing.id,count:entries.length,inserted_count:0,replayed:true};}
    for(const entry of entries){const conflict=(await client.query('SELECT id FROM late_fee_rates WHERE product=$1 AND valid_from<$3 AND valid_until>$2 AND annual_percentage<>$4',[PRODUCT,entry.valid_from,entry.valid_until,entry.annual_percentage])).rowCount;if(conflict)throw new Error('La publicación contradice una tasa ya verificada. Requiere revisión; no se reemplazó el historial.');}
    const id=uid();await client.query('INSERT INTO late_fee_rate_sources(id,url,content_hash,content_html,product,actor_json) VALUES($1,$2,$3,$4,$5,$6)',[id,url,digest,html,PRODUCT,JSON.stringify(actor)]);
    let inserted=0;
    for(const e of entries){
      const known=(await client.query('SELECT id FROM late_fee_rates WHERE product=$1 AND valid_from=$2 AND valid_until=$3 AND annual_percentage=$4',[PRODUCT,e.valid_from,e.valid_until,e.annual_percentage])).rowCount;
      if(known)continue;
      await client.query('INSERT INTO late_fee_rates(id,source_id,product,valid_from,valid_until,annual_percentage) VALUES($1,$2,$3,$4,$5,$6)',[uid(),id,PRODUCT,e.valid_from,e.valid_until,e.annual_percentage]);inserted++;
    }
    await client.query('INSERT INTO audit_log(id,entity_type,entity_id,action,details_json) VALUES($1,$2,$3,$4,$5)',[uid(),'late_fee_rate_source',id,'official_rates_imported',JSON.stringify({url,content_hash:digest,product:PRODUCT,count:entries.length,inserted_count:inserted,actor})]);
    await client.query('COMMIT');return {id,count:entries.length,inserted_count:inserted,replayed:inserted===0,from:entries[0].valid_from,until:entries.at(-1).valid_until};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
module.exports={PRODUCT,productLabel,sourceUrl,parseOfficialBulletin,importRates};
