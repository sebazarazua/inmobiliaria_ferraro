const {periodKey,shiftMonth}=require('../../lib/calendar');
const {scaled,decimal}=require('../../lib/money');
const INDEC_CSV_URL='https://www.indec.gob.ar/ftp/cuadros/economia/serie_ipc_divisiones.csv';
const MACRO_CSV_URL='https://infra.datos.gob.ar/catalog/sspm/dataset/145/distribution/145.3/download/indice-precios-al-consumidor-nivel-general-base-diciembre-2016-mensual.csv';

function csvRows(text,separator) {
  // Quoted fields, escaped quotes and CRLF are supported; source columns are named.
  const rows=[];let row=[],field='',quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}
    else if(!quoted&&(c===separator||c==='\n')){row.push(field.replace(/\r$/,''));field='';if(c==='\n'){if(row.some(Boolean))rows.push(row);row=[];}}
    else field+=c;
  }
  if(quoted)throw new Error('CSV oficial incompleto.');
  if(field||row.length){row.push(field.replace(/\r$/,''));rows.push(row);}
  return rows;
}
function validateSeries(records) {
  if(!records.length)throw new Error('La serie oficial está vacía.');
  let previous=null;
  for(const row of records){
    row.period=periodKey(row.period);
    if(scaled(row.value,10)<=0n)throw new Error(`Índice inválido: ${row.period}.`);
    row.value=decimal(scaled(row.value,10),10);
    if(previous&&row.period!==shiftMonth(previous,1))throw new Error(`Serie desordenada, duplicada o discontinua: ${row.period}.`);
    if(row.variation!=null&&!Number.isFinite(Number(row.variation)))throw new Error(`Variación inválida: ${row.period}.`);
    previous=row.period;
  }
  return records;
}
function parseIndecCsv(text) {
  const [header,...rows]=csvRows(text.replace(/^\uFEFF/,''),';');
  const col=name=>{const i=header?.indexOf(name);if(i==null||i<0)throw new Error(`Falta columna oficial ${name}.`);return i;};
  const code=col('Codigo'),region=col('Region'),period=col('Periodo'),value=col('Indice_IPC');
  const records=rows.filter(r=>r[code]==='0'&&r[region]==='Nacional').map(r=>{
    if(!/^\d{6}$/.test(r[period]))throw new Error('Período oficial inválido.');
    return {period:`${r[period].slice(0,4)}-${r[period].slice(4)}`,value:r[value].replace(',','.')};
  });
  return withVariations(validateSeries(records));
}
function parseMacroCsv(text) {
  const [header,...rows]=csvRows(text.replace(/^\uFEFF/,''),','),date=header?.indexOf('indice_tiempo'),value=header?.indexOf('ipc_ng_nacional');
  if(date<0||value<0||date==null)throw new Error('La fuente alternativa no contiene niveles nacionales de IPC.');
  return withVariations(validateSeries(rows.map(r=>({period:periodKey(r[date]),value:r[value]}))));
}
function withVariations(records) {
  return records.map((r,i)=>({...r,variation:i?String(Number(r.value)/Number(records[i-1].value)-1):null}));
}
async function downloadOfficialSeries(fetchImpl=fetch) {
  const errors=[];
  for(const [url,parse,source]of [[INDEC_CSV_URL,parseIndecCsv,'INDEC · IPC nacional · diciembre 2016=100'],[MACRO_CSV_URL,parseMacroCsv,'Datos Argentina / INDEC · niveles IPC nacional']]){
    try{
      // INDEC serves the CSV as application/octet-stream and rejects text/csv-only Accept.
      const response=await fetchImpl(url,{signal:AbortSignal.timeout(20000),headers:{Accept:'*/*'}});
      if(!response.ok)throw new Error(`HTTP ${response.status}`);
      const records=parse(await response.text());
      return {records,source,sourceUrl:url,warnings:errors};
    }catch(error){errors.push(`${url}: ${error.message}`);}
  }
  throw new Error(errors.join(' | '));
}
module.exports={INDEC_CSV_URL,MACRO_CSV_URL,parseIndecCsv,parseMacroCsv,validateSeries,downloadOfficialSeries};
