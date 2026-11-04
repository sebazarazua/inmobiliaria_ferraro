const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {allSettings}=require('../../database');
const {inspectManagedFile}=require('../imports/document-admin');
const {normalize}=require('./common');
const {PRODUCT}=require('./rates');
const {validateTerms}=require('./engine');
const {ocrPage}=require('./ocr');
function interpret(text){
  const n=normalize(text),p={},alternatives={},missing=[],percent=[...text.matchAll(/(\d+(?:[.,]\d+)?)\s*%\s*(?:diari[oa]|por d[ií]a)/gi)].map(m=>m[1].replace(',','.'));
  const unique=[...new Set(percent)],bank=/banco (?:de la )?nacion|\bbna\b/.test(n);
  if(/sin (?:intereses|punitorios)|no (?:se )?(?:aplica|cobra|devenga|genera|corresponde).{0,50}(?:interes|mora|punitori)/.test(n))alternatives.obligation=['El texto excluye intereses o punitorios; requiere cotejo específico.'];
  if(bank)p.type='BANK_ACTIVE_RATE';else if(unique.length===1){p.type='FIXED_DAILY';p.dailyPercentage=unique[0];}
  if(unique.length>1||bank&&unique.length)alternatives.rates=unique.concat(bank?['BNA']:[]);
  if(/dia siguiente.{0,40}vencimiento/.test(n))p.startsFrom='AFTER_DUE_DATE';
  if(/primer dia del mes/.test(n)){if(p.startsFrom)alternatives.startsFrom=[p.startsFrom,'FIRST_DAY_OF_MONTH'];else p.startsFrom='FIRST_DAY_OF_MONTH';}
  const grace=[...n.matchAll(/(\d+) dias de gracia/g)].map(m=>Number(m[1]));if(new Set(grace).size===1)p.graceDays=grace[0];else if(grace.length)alternatives.graceDays=grace;
  if(/sin (?:plazo de )?gracia|sin dias de gracia/.test(n))p.graceDays=0;
  const dueDays=[...n.matchAll(/(?:vencimiento|vence|hasta)(?: el)?(?: dia)? (\d{1,2}) de cada mes/g)].map(m=>Number(m[1]));
  const windows=[...n.matchAll(/(?:entre(?: los dias)?|del) (\d{1,2}) (?:y|al) (\d{1,2}) de cada mes/g)];
  for(const m of windows){if(Number(m[1])>=1&&Number(m[1])<=Number(m[2])&&Number(m[2])<=31){p.paymentPeriodStartDay=Number(m[1]);dueDays.push(Number(m[2]));}}
  const validDue=[...new Set(dueDays.filter(d=>d>=1&&d<=31))];if(validDue.length===1)p.paymentDueDay=validDue[0];else if(validDue.length>1)alternatives.paymentDueDay=validDue;
  if(/saldo.{0,35}(?:capital|alquiler)|capital.{0,30}impago/.test(n)&&/alquiler/.test(n))p.base='RENT_OUTSTANDING';
  if(/simple|sin capitaliza/.test(n))p.accumulation='SIMPLE';
  if(/capitaliz|compuest|anatocis/.test(n.replace(/sin capitalizacion/g,'')))alternatives.accumulation=['Capitalización u otra acumulación: requiere revisión'];
  if(/pagos?.{0,60}(?:primero|prioridad) (?:al|a) capital/.test(n))p.allocation='RENT_FIRST';
  if(/diari|dias corridos/.test(n))p.periodicity='DAILY';
  if(/inicio del dia/.test(n))p.paymentTiming='START_OF_DAY';
  if(/incluy.{0,25}(?:dia de corte|fecha de corte)|(?:dia de corte|fecha de corte).{0,20}incluid/.test(n))p.cutoffConvention='INCLUSIVE';
  if(bank&&/cartera general/.test(n)&&/nominal anual vencida|tna vencida/.test(n)&&/30 dias|treinta dias/.test(n)&&!/descubierto|adelantada|efectiva anual/.test(n))p.product=PRODUCT;
  const bases=[...n.matchAll(/(?:base(?: de)?|ano de) (360|365)/g)].map(m=>Number(m[1]));if(new Set(bases).size===1)p.dayBasis=bases[0];else if(bases.length)alternatives.dayBasis=bases;
  const required=['type','startsFrom','graceDays','paymentDueDay','base','accumulation','allocation','periodicity','paymentTiming','cutoffConvention',...(bank?['product','dayBasis']:['dailyPercentage'])];for(const key of required)if(p[key]===undefined)missing.push(key);
  return {parameters:p,missing,alternatives,confidence:Object.keys(alternatives).length?'conflicting':missing.length?'partial':'high',review_status:'pending_human_review'};
}
async function detect(db,contractId,{ocrImpl=process.env.LATE_FEE_OCR==='true'?ocrPage:null}={}){
  const contract=(await db.query('SELECT source_document_id FROM contracts WHERE id=$1',[contractId])).rows[0];if(!contract)throw new Error('Contrato no encontrado.');
  if(!contract.source_document_id)return{status:'missing_document',candidates:[],message:'No hay PDF original asociado. Requiere revisión documental.'};
  const d=(await db.query('SELECT * FROM documents WHERE id=$1',[contract.source_document_id])).rows[0];if(!d||d.contract_id!==contractId)throw new Error('Documento incompatible.');
  const root=fs.realpathSync(path.resolve((await allSettings(db)).import_directory)),file=inspectManagedFile(root,d.absolute_path);if(!file.managed||!file.exists)throw new Error('El PDF original no está disponible.');
  const sha=crypto.createHash('sha256').update(fs.readFileSync(file.path)).digest('hex');if(sha!==d.sha256)throw new Error('El PDF cambió; revisá la evidencia original.');
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs'),pdf=await getDocument({data:new Uint8Array(fs.readFileSync(file.path)),useSystemFonts:true}).promise;
  const pages=[],candidates=[],ocrErrors=[];
  try{if(pdf.numPages>300)throw new Error('Documento demasiado extenso para análisis automático.');for(let number=1;number<=pdf.numPages;number++){
    const page=await pdf.getPage(number),content=await page.getTextContent();let text=content.items.map(i=>i.str+(i.hasEOL?'\n':' ')).join('').trim(),method='text';
    if(text.length<40&&ocrImpl&&number<=20){try{const extracted=await ocrImpl(file.path,number);if(extracted.length>=40){text=extracted;method='ocr';}}catch{ocrErrors.push({page:number,message:'OCR local no disponible o falló. Requiere revisión del original.'});}}
    pages.push({page:number,characters:text.length,method});
    const relevant=/mora|punitori|interes|vencimiento|gracia|banco (?:de la )?nacion|\bbna\b/;
    // Keep literal PDF-page fragments; clause boundaries are suggested only when present.
    const blocks=text.split(/(?=(?:CL[ÁA]USULA\s+[\wIVX]+|(?:PRIMERA|SEGUNDA|TERCERA|CUARTA|QUINTA|SEXTA|S[ÉE]PTIMA|OCTAVA|NOVENA|D[ÉE]CIMA)\s*[:.—-]))/i);
    for(const block of blocks){if(!relevant.test(normalize(block)))continue;const quote=block.trim();if(quote.length>18000){candidates.push({page:number,quote:quote.slice(0,18000),truncated:true,reference:`Página ${number}`,parameters:{},missing:['fragmento_completo'],alternatives:{},confidence:'partial',review_status:'pending_human_review'});continue;}
      candidates.push({page:number,method,quote,reference:`Página ${number}${quote.match(/^(?:CL[ÁA]USULA\s+[^\n:.—-]+|[A-ZÁÉÍÓÚÑ]+(?=\s*[:.—-]))/i)?.[0]?' · '+quote.match(/^[^\n:.—-]+/)[0]:''}`,...interpret(quote),...(method==='ocr'?{confidence:'ocr_uncertain',review_status:'ocr_pending_human_review'}:{})});
    }
  }}finally{await pdf.destroy();}
  const uncertain=pages.some(p=>p.characters<40);
  return{document_id:d.id,sha256:sha,pages,candidates,ocr_errors:ocrErrors,status:uncertain?'ocr_required':pages.some(p=>p.method==='ocr')?'ocr_review_required':candidates.length?'review_required':'no_clause_detected',message:uncertain?'Página sin texto suficiente. Requiere OCR local (Poppler y Tesseract español con LATE_FEE_OCR=true) y cotejo humano del original; no se calcula automáticamente.':pages.some(p=>p.method==='ocr')?'Texto obtenido por OCR local: puede contener errores. Cotejá cada dato con la página original antes de confirmar.':candidates.length?'Propuestas documentales pendientes de revisión humana.':'No se detectó una cláusula en el texto extraíble. Esto no certifica su ausencia jurídica.'};
}
module.exports={detect,interpret};
