const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {uid,allSettings}=require('../../database');
const {scaled,decimal,balance,paymentStatus}=require('../../lib/money');
const {inspectManagedFile}=require('../imports/document-admin');
const {extractPdfText}=require('../imports/contract-parser');
const {actor,uuid,hash,issue,verify,amount,reason,normalize,day}=require('./common');
const {calculate,validateTerms}=require('./engine');
const {PRODUCT,productLabel}=require('./rates');
const rows=async(db,sql,args=[])=>(await db.query(sql,args)).rows;
async function proof(client,contract,input){
  if(!contract.source_document_id||input.document_id!==contract.source_document_id)throw new Error('Se necesita el PDF original asociado al contrato.');
  const document=(await rows(client,'SELECT * FROM documents WHERE id=$1',[contract.source_document_id]))[0];
  if(!document||document.contract_id!==contract.id)throw new Error('El documento no corresponde al contrato.');
  const root=fs.realpathSync(path.resolve((await allSettings(client)).import_directory)),file=inspectManagedFile(root,document.absolute_path);
  if(!file.managed||!file.exists)throw new Error('El PDF original no está disponible.');
  const sha=crypto.createHash('sha256').update(fs.readFileSync(file.path)).digest('hex');if(sha!==document.sha256)throw new Error('Cambió el PDF original; revisá la evidencia.');
  const quote=normalize(input.document_quote);if(quote.length<40||!normalize(await extractPdfText(file.path)).includes(quote))throw new Error('El fragmento de mora no se encuentra en el PDF original o es insuficiente.');
  if(typeof input.document_reference!=='string'||input.document_reference.trim().length<3)throw new Error('Indicá cláusula y página del contrato.');
  return {document_id:document.id,sha256:sha,reference:input.document_reference.trim(),quote:input.document_quote};
}
function checkEvidence(contract,terms,evidence){
  const text=normalize(evidence.quote),stored=contract.late_fee_json||{};
  if(/servici|expensa|\biva\b|impuesto|total exigible|toda obligaci|cualquier obligaci/.test(text))throw new Error('La cláusula incluye otros conceptos de capital no soportados por este cálculo.');
  if(/no (?:se )?incluy.{0,30}corte|primero a(?:l| los) interes/.test(text))throw new Error('La imputación o el corte contradicen la modalidad soportada.');
  if(/\b(?:tope|maximo|minimo|mayor|menor|alternativa|doble|triple|multiplicador|salvo)\b/.test(text))throw new Error('La cláusula contiene alternativas, topes o excepciones que requieren revisión específica.');
  if(stored.type!==terms.type)throw new Error('La modalidad no coincide con los datos protegidos del contrato. Requiere rectificación documental por su circuito.');
  if(!/simple|sin capitaliza/.test(text)||!/saldo.{0,35}(?:capital|alquiler)|capital.{0,30}impago/.test(text)||!/alquiler/.test(text)||!/pagos?.{0,60}(?:primero|prioridad) (?:al|a) capital/.test(text)||!/diari|dias corridos/.test(text))throw new Error('El fragmento no respalda claramente capital impago de alquiler, imputación de pagos y acumulación simple diaria. Requiere revisión.');
  if(/capitaliz|compuest|anatocis|interes sobre interes/.test(text.replace(/sin capitalizacion/g,'')))throw new Error('La cláusula contiene capitalización o condiciones de acumulación no soportadas.');
  const grace=text.match(/(\d+) dias de gracia/);if(grace&&Number(grace[1])!==terms.graceDays)throw new Error('La gracia indicada contradice el fragmento contractual.');
  if(!/inicio del dia/.test(text)||!/incluy.{0,25}(?:dia de corte|fecha de corte)|(?:dia de corte|fecha de corte).{0,20}incluid/.test(text))throw new Error('La cláusula no precisa la imputación diaria y el corte incluido. Requiere revisión.');
  if(terms.startsFrom==='AFTER_DUE_DATE'&&!/dia siguiente.{0,40}vencimiento/.test(text))throw new Error('No se verificó el comienzo de mora después del vencimiento.');
  if(terms.startsFrom==='FIRST_DAY_OF_MONTH'&&!/primer dia del mes/.test(text))throw new Error('No se verificó la mora desde el primer día del mes.');
  if(terms.graceDays!==0&&!new RegExp(`${terms.graceDays} dias de gracia`).test(text))throw new Error('Los días de gracia no están respaldados por el fragmento.');
  if(stored.startsFrom&&stored.startsFrom!==terms.startsFrom)throw new Error('El inicio de mora contradice la condición protegida registrada.');
  if(terms.type==='FIXED_DAILY'){
    if(/tasa activa|banco (?:de la )?nacion/.test(text))throw new Error('La cláusula combina tasa diaria y bancaria. No se elige una modalidad arbitrariamente.');
    const matches=[...String(evidence.quote).matchAll(/(\d+(?:[.,]\d+)?)\s*%\s*(?:diario|por d[ií]a)/gi)];
    if(!matches.some(m=>scaled(m[1].replace(',','.'),6)===scaled(terms.dailyPercentage,6))||stored.dailyPercentage==null||scaled(stored.dailyPercentage,6)!==scaled(terms.dailyPercentage,6))throw new Error('El porcentaje diario no coincide con la cláusula y el dato protegido.');
  }else{
    if(/descubierto|adelantada|efectiva anual|doble|triplic|multiplic/.test(text))throw new Error('La cláusula contiene otra modalidad o condiciones adicionales. Requiere revisión específica.');
    if(!/banco (?:de la )?nacion/.test(text)||!/cartera general/.test(text)||!/nominal anual vencida|tna vencida/.test(text)||!/30 dias|treinta dias/.test(text)||!new RegExp(`(?:base(?: de)?|ano de) ${terms.dayBasis}`).test(text))throw new Error('La cláusula no identifica inequívocamente la modalidad BNA y su base anual. No se elige una tasa por defecto.');
    if(stored.bankRateMultiplier!=null&&Number(stored.bankRateMultiplier)!==1)throw new Error('El multiplicador contractual requiere un cálculo específico no soportado.');
  }
}
async function reviewTerms(db,contractId,input){
  if(!uuid.test(String(input.request_id)))throw new Error('Identificador de revisión inválido.');
  if(input.confirm!==true)throw new Error('Confirmá que cotejaste la interpretación con el documento.');
  const terms=validateTerms(input.terms),why=reason(input.reason),client=await db.connect();
  try{await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtext('ferraro:ipc:write'))");
    const contract=(await rows(client,'SELECT * FROM contracts WHERE id=$1 FOR UPDATE',[contractId]))[0];if(!contract)throw new Error('Contrato no encontrado.');
    const evidence=await proof(client,contract,input);checkEvidence(contract,terms,evidence);
    const existing=(await rows(client,'SELECT * FROM late_fee_reviews WHERE id=$1',[input.request_id]))[0];
    if(existing){if(existing.contract_id!==contractId||hash(existing.terms_json)!==hash(terms)||hash(existing.evidence_json)!==hash(evidence)||existing.reason!==why)throw new Error('La clave corresponde a otra revisión.');await client.query('ROLLBACK');return {...existing,replayed:true};}
    await client.query('INSERT INTO late_fee_reviews(id,contract_id,terms_json,evidence_json,actor_json,reason) VALUES($1,$2,$3,$4,$5,$6)',[input.request_id,contractId,JSON.stringify(terms),JSON.stringify(evidence),JSON.stringify(actor),why]);
    await client.query("INSERT INTO audit_log(id,entity_type,entity_id,action,details_json) VALUES($1,'contract',$2,'late_fee_terms_reviewed',$3)",[uid(),contractId,JSON.stringify({review_id:input.request_id,terms,evidence,reason:why,actor})]);
    await client.query('COMMIT');return {id:input.request_id,terms_json:terms,evidence_json:evidence};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
async function details(db,contractId){
  const contract=(await rows(db,'SELECT id,code,alias,source_document_id,late_fee_json FROM contracts WHERE id=$1',[contractId]))[0];if(!contract)throw new Error('Contrato no encontrado.');
  const installments=await rows(db,`SELECT i.*,(COALESCE((SELECT SUM(amount) FROM payments WHERE installment_id=i.id),0)+i.manual_partial_amount)::text paid_amount FROM installments i WHERE contract_id=$1 ORDER BY period`,[contractId]);
  return {contract,installments:installments.map(i=>({...i,balance:balance(i),due_amount:decimal(scaled(balance(i))>0n?scaled(balance(i)):0n)})),review:(await rows(db,'SELECT * FROM late_fee_reviews WHERE contract_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[contractId]))[0]||null,history:await rows(db,'SELECT h.* FROM late_fee_history h JOIN installments i ON i.id=h.installment_id WHERE i.contract_id=$1 ORDER BY h.created_at DESC,h.version DESC',[contractId]),sources:await rows(db,'SELECT s.id,s.url,s.content_hash,s.retrieved_at,r.product,MIN(r.valid_from)::text valid_from,MAX(r.valid_until)::text valid_until FROM late_fee_rate_sources s JOIN late_fee_rates r ON r.source_id=s.id GROUP BY s.id,r.product ORDER BY valid_from'),product:{id:PRODUCT,label:productLabel}};
}
async function operate(db,installmentId,input,{apply=false}={}){
  if(!uuid.test(String(input.request_id)))throw new Error('Identificador de operación inválido.');
  const {token,confirm,...proposal}=input,requestHash=hash({installmentId,proposal}),why=reason(input.reason),client=await db.connect();
  try{await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtext('ferraro:ipc:write'))");
    const prior=(await rows(client,'SELECT * FROM late_fee_operations WHERE request_id=$1',[input.request_id]))[0];if(prior){if(prior.request_hash!==requestHash)throw new Error('La clave corresponde a otra operación.');if(!apply)throw new Error('La operación ya fue aplicada.');await client.query('ROLLBACK');return {...prior.result_json,replayed:true};}
    const link=(await rows(client,'SELECT contract_id FROM installments WHERE id=$1',[installmentId]))[0];if(!link)throw new Error('Cuota no encontrada.');
    const contract=(await rows(client,'SELECT * FROM contracts WHERE id=$1 FOR UPDATE',[link.contract_id]))[0],row=(await rows(client,'SELECT * FROM installments WHERE id=$1 FOR UPDATE',[installmentId]))[0];
    if(row.status==='Sustituido'||row.financial_closed_at)throw new Error('La cuota está sustituida o el período está cerrado. No se modificaron punitorios.');
    const payments=await rows(client,'SELECT * FROM payments WHERE installment_id=$1 ORDER BY id',[installmentId]);
    const paid=decimal(payments.reduce((n,p)=>n+scaled(p.amount),scaled(row.manual_partial_amount))),beforeGross=row.late_fee_calculated_amount??row.late_fee_amount;
    let calculation=row.late_fee_calculation_json||{origin:'legacy_recorded',gross_amount:beforeGross},gross=String(beforeGross),forgiven=String(row.late_fee_forgiven_amount),review=null,rates=[];
    if(input.operation==='calculate'){
      if(row.currency!==contract.currency||row.period<day(contract.start_date).slice(0,7)||row.period>day(contract.end_date).slice(0,7)||day(row.due_date)<day(contract.start_date))throw new Error('La moneda, período o vencimiento de la cuota no coincide con la vigencia contractual. Revisá el cronograma.');
      if(!['Activo','Revisión','Renovado'].includes(contract.status))throw new Error('El contrato no admite nuevas obligaciones automáticas.');
      review=(await rows(client,'SELECT * FROM late_fee_reviews WHERE contract_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[contract.id]))[0];if(!review)throw new Error('Falta revisar la cláusula original y completar sus condiciones de mora.');
      const evidence=await proof(client,contract,{document_id:review.evidence_json.document_id,document_quote:review.evidence_json.quote,document_reference:review.evidence_json.reference});checkEvidence(contract,review.terms_json,evidence);if(hash(evidence)!==hash(review.evidence_json))throw new Error('Cambió la evidencia revisada.');
      rates=await rows(client,'SELECT r.*,s.url,s.content_hash FROM late_fee_rates r JOIN late_fee_rate_sources s ON s.id=r.source_id WHERE r.product=$1 ORDER BY r.valid_from,r.id',[PRODUCT]);
      calculation=calculate({contract,installment:row,payments,review,rates,cutoff:input.cutoff});gross=calculation.gross_amount;
    }else if(input.operation==='forgive'){forgiven=amount(input.forgiven_amount);if(scaled(forgiven)<=0n)throw new Error('Indicá una condonación positiva.');}
    else if(input.operation==='restore'){if(row.late_fee_calculated_amount==null&&row.late_fee_forgiven)throw new Error('No se conoce el importe original de esta condonación histórica. Revisá la documentación; no se inventa un punitorio.');forgiven='0.00';}
    else throw new Error('Operación de punitorios inválida.');
    if(scaled(forgiven)>scaled(gross))throw new Error('La condonación supera el importe calculado o registrado. Revisala por separado antes de recalcular.');
    const net=decimal(scaled(gross)-scaled(forgiven));
    if(!['Activo','Revisión','Renovado'].includes(contract.status)&&scaled(net)>scaled(row.late_fee_amount))throw new Error('No se aumenta la deuda de un contrato inactivo o finalizado.');
    const next={...row,late_fee_amount:net},result={operation:input.operation,installment_id:row.id,contract_id:contract.id,period:row.period,currency:row.currency,previous_amount:row.late_fee_amount,gross_amount:gross,forgiven_amount:forgiven,late_fee_amount:net,difference:decimal(scaled(net)-scaled(row.late_fee_amount)),paid_amount:paid,before_balance:balance(row,paid),balance:balance(next,paid),status:paymentStatus(next,paid),calculation,reason:why,actor};
    const fingerprint=hash({requestHash,contract,row,payments,review,rates,result});
    if(!apply){await client.query('ROLLBACK');return {...result,token:issue(fingerprint)};}
    if(confirm!==true)throw new Error('Confirmá el impacto antes de aplicar los punitorios.');verify(token,fingerprint);
    const unchanged=hash(calculation)===hash(row.late_fee_calculation_json)&&scaled(net)===scaled(row.late_fee_amount)&&scaled(forgiven)===scaled(row.late_fee_forgiven_amount);
    if(!unchanged){
      const version=(await rows(client,'SELECT COALESCE(MAX(version),0)+1 n FROM late_fee_history WHERE installment_id=$1',[row.id]))[0].n;
      await client.query('UPDATE installments SET late_fee_calculated_amount=$1,late_fee_forgiven_amount=$2,late_fee_amount=$3,late_fee_calculation_json=$4,late_fee_calculation_hash=$5,late_fee_forgiven=$6,status=$7 WHERE id=$8',[gross,forgiven,net,JSON.stringify(calculation),hash(calculation),scaled(gross)>0n&&scaled(net)===0n,result.status,row.id]);
      await client.query('INSERT INTO late_fee_history(id,installment_id,version,request_id,details_json) VALUES($1,$2,$3,$4,$5)',[uid(),row.id,version,input.request_id,JSON.stringify({...result,before:row,version})]);
      await client.query("INSERT INTO audit_log(id,entity_type,entity_id,action,details_json) VALUES($1,'installment',$2,'late_fee_changed',$3)",[uid(),row.id,JSON.stringify({...result,version})]);
      result.version=version;
    }
    result.unchanged=unchanged;
    await client.query('INSERT INTO late_fee_operations(request_id,request_hash,result_json) VALUES($1,$2,$3)',[input.request_id,requestHash,JSON.stringify(result)]);
    await client.query('COMMIT');return result;
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
module.exports={reviewTerms,details,operate,checkEvidence};
