const {scaled,decimal}=require('../../lib/money');
const {hash,day,shift}=require('./common');
const {PRODUCT}=require('./rates');
function validateTerms(terms){
  const allowed=new Set(['type','dailyPercentage','startsFrom','graceDays','base','accumulation','allocation','periodicity','paymentTiming','cutoffConvention','product','dayBasis']);
  if(terms&&Object.keys(terms).some(k=>!allowed.has(k)))throw new Error('La cláusula contiene parámetros adicionales no soportados. Requiere revisión.');
  if(!terms||!['FIXED_DAILY','BANK_ACTIVE_RATE'].includes(terms.type))throw new Error('La cláusula no define una modalidad de punitorios soportada.');
  if(terms.base!=='RENT_OUTSTANDING'||terms.accumulation!=='SIMPLE'||terms.allocation!=='RENT_FIRST'||terms.paymentTiming!=='START_OF_DAY'||terms.cutoffConvention!=='INCLUSIVE'||terms.periodicity!=='DAILY')throw new Error('Revisá capital, imputación de pagos, periodicidad y acumulación simple de la cláusula. No se asumen condiciones faltantes.');
  if(!['AFTER_DUE_DATE','FIRST_DAY_OF_MONTH'].includes(terms.startsFrom)||!Number.isInteger(terms.graceDays)||terms.graceDays<0||terms.graceDays>90)throw new Error('El inicio de mora o los días de gracia requieren revisión.');
  if(terms.type==='FIXED_DAILY'&&(!/^\d{1,3}(?:\.\d{1,6})?$/.test(String(terms.dailyPercentage))||scaled(terms.dailyPercentage,6)<=0n))throw new Error('Falta el porcentaje diario contractual explícito.');
  if(terms.type==='BANK_ACTIVE_RATE'&&(terms.product!==PRODUCT||![360,365].includes(terms.dayBasis)))throw new Error('La tasa activa es ambigua o no está soportada. Especificá cartera general TNA vencida a 30 días y base anual contractual.');
  return terms;
}
function calculate({contract,installment,payments,review,rates,cutoff}){
  const terms=validateTerms(review.terms_json),cut=day(cutoff),due=day(installment.due_date);
  if(cut>new Date().toISOString().slice(0,10))throw new Error('La fecha de corte no puede ser futura.');
  if(scaled(installment.discount_amount)>0n)throw new Error('El descuento general no tiene una imputación de capital identificada. Revisá su alcance antes de calcular mora.');
  if(scaled(installment.manual_partial_amount)!==0n)throw new Error('Hay un pago parcial manual sin fecha de imputación. Revisá su cronología antes de calcular intereses.');
  if(installment.adjustment_pending||(contract.adjustment_index==='IPC'&&!installment.ipc_managed))throw new Error('El alquiler es provisional o requiere conciliación. Revisá el canon antes de calcular punitorios.');
  if(terms.type==='BANK_ACTIVE_RATE'&&installment.currency!=='ARS')throw new Error('La serie oficial soportada es en pesos. No se aplica automáticamente a otra moneda.');
  const threshold=shift(due,terms.graceDays),start=terms.startsFrom==='FIRST_DAY_OF_MONTH'?due.slice(0,7)+'-01':shift(threshold,1);
  const days=[],denominator=100n*10n**6n*BigInt(terms.type==='BANK_ACTIVE_RATE'?terms.dayBasis:1);let numerator=0n;
  if(cut>threshold)for(let current=start;current<=cut;current=shift(current,1)){
    if(days.length>=3660)throw new Error('El período excede diez años. Requiere revisión específica.');
    const paid=payments.filter(p=>day(p.paid_at)<=current).reduce((n,p)=>n+scaled(p.amount),0n),principal=scaled(installment.expected_amount)>paid?scaled(installment.expected_amount)-paid:0n;
    let percentage=String(terms.dailyPercentage),source=null;
    if(terms.type==='BANK_ACTIVE_RATE'&&principal>0n){
      const found=rates.filter(r=>day(r.valid_from)<=current&&day(r.valid_until)>current);
      if(!found.length)throw new Error(`Falta una tasa oficial histórica para ${current}. No se extrapolan tasas ni se completa el período.`);
      if(new Set(found.map(r=>decimal(scaled(r.annual_percentage,6),6))).size!==1)throw new Error(`Las tasas oficiales de ${current} son contradictorias. Requieren revisión.`);
      const rate=found[0];percentage=String(rate.annual_percentage);source={id:rate.id,url:rate.url,source_id:rate.source_id,content_hash:rate.content_hash,valid_from:day(rate.valid_from),valid_until:day(rate.valid_until)};
    }
    const units=principal===0n?0n:principal*scaled(percentage,6);numerator+=units;
    days.push({date:current,principal:decimal(principal),payments_applied:decimal(paid),percentage:principal===0n?null:percentage,source,numerator:units.toString()});
  }
  const gross=(numerator+denominator/2n)/denominator;if(gross>99999999999999n)throw new Error('El punitorio supera el importe permitido.');
  const segments=[];for(const item of days){const previous=segments.at(-1);if(previous&&previous.principal===item.principal&&previous.percentage===item.percentage&&previous.source?.id===item.source?.id){previous.until=item.date;previous.days++;previous.numerator=(BigInt(previous.numerator)+BigInt(item.numerator)).toString();}else segments.push({...item,from:item.date,until:item.date,days:1});}
  const result={engine_version:1,origin:'contract_calculation',review_id:review.id,terms,evidence:review.evidence_json,cutoff:cut,due_date:due,start_date:start,days:days.filter(d=>scaled(d.principal)>0n).length,elapsed_days:days.length,gross_amount:decimal(gross),segments,formula:terms.type==='FIXED_DAILY'?'Σ(capital impago diario × porcentaje diario / 100)':'Σ(capital impago diario × TNA histórica / (100 × base anual contractual))',rounding:'Centavos, mitad hacia arriba una sola vez al final',numerator:numerator.toString(),denominator:denominator.toString()};
  return {...result,calculation_hash:hash(result)};
}
module.exports={calculate,validateTerms};
