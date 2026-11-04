const {dateKey}=require('../../lib/calendar');
const {scaled,decimal}=require('../../lib/money');

// Administrative aliases never change legal obligations. Existing notes may contain
// contractual clauses, so new administrative annotations live in the audit trail.
const ADMIN_FIELDS=['alias','administrative_note'];
const PROTECTED_FIELDS=['code','property_id','tenant_id','rental_type','duration_months','start_date','end_date','initial_amount','currency','adjustment_type','adjustment_index','adjustment_frequency_months','adjustment_value_pct','ipc_lag_months','ipc_clause_text','ipc_clause_review_required','payment_due_day','payment_period_start_day','payment_period_end_day','late_fee_json','payment_terms_json','vat_applicable','vat_percentage','deposit_amount','management_fee_pct','bank_name','cbu','notes','source_document_id','previous_contract_id','import_snapshot_json'];
const RECTIFIABLE_FIELDS=['rental_type','duration_months','start_date','end_date','initial_amount','currency','adjustment_type','adjustment_index','adjustment_frequency_months','adjustment_value_pct','ipc_lag_months','ipc_clause_text','ipc_clause_review_required','payment_due_day','payment_period_start_day','payment_period_end_day','late_fee_json','payment_terms_json','vat_applicable','vat_percentage','deposit_amount','management_fee_pct','bank_name','cbu','notes'];
const INTEGER_FIELDS=new Set(['duration_months','adjustment_frequency_months','ipc_lag_months','payment_due_day','payment_period_start_day','payment_period_end_day']);
const MONEY_FIELDS=new Set(['initial_amount','deposit_amount']);
const PERCENT_FIELDS=new Set(['adjustment_value_pct','management_fee_pct','vat_percentage']);
const BOOLEAN_FIELDS=new Set(['ipc_clause_review_required','vat_applicable']);
function sorted(value){if(Array.isArray(value))return value.map(sorted);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,sorted(value[k])]));return value;}
function normalize(field,value){
  if(value===null||value===undefined||value==='')return null;
  if(field.endsWith('_date')||['rescinded_at','deposit_returned_at'].includes(field))return dateKey(value);
  if(field.endsWith('_at')){const date=new Date(value);if(!Number.isFinite(date.getTime()))throw new Error('Fecha de auditoría inválida.');return date.toISOString();}
  if(INTEGER_FIELDS.has(field)){const n=Number(value);if(!Number.isInteger(n))throw new Error(`Valor entero inválido: ${field}.`);return n;}
  if(MONEY_FIELDS.has(field)||field.endsWith('_amount')||field==='rescission_penalty')return decimal(scaled(value));
  if(PERCENT_FIELDS.has(field))return decimal(scaled(value,3),3);
  if(BOOLEAN_FIELDS.has(field)){if(![true,false,'true','false',1,0,'1','0'].includes(value))throw new Error('Valor de confirmación inválido.');return [true,'true',1,'1'].includes(value);}
  if(field.endsWith('_json'))return sorted(typeof value==='string'?JSON.parse(value):value);
  return String(value);
}
function equivalent(field,a,b){
  if(field==='ipc_lag_months')return Math.max(1,Number(a||0))===Math.max(1,Number(b||0));
  return JSON.stringify(normalize(field,a))===JSON.stringify(normalize(field,b));
}
function assertAdministrativeChange(contract,input){
  if(input.status!==undefined&&input.status!==contract.status)throw new Error('El estado se cambia desde sus acciones, no desde la edición administrativa.');
  for(const field of Object.keys(input)){
    if(ADMIN_FIELDS.includes(field)||field==='status')continue;
    if(field==='ipc_clause_confirmed'&&[true,'true'].includes(input[field])&&contract.ipc_clause_review_required)throw new Error('La cláusula requiere una rectificación documental.');
    if((PROTECTED_FIELDS.includes(field)||Object.hasOwn(contract,field))&&!equivalent(field,contract[field],input[field]))throw new Error('Las condiciones del contrato están protegidas. Usá «Rectificar datos del contrato» con el documento original, o la renovación correspondiente.');
  }
}
function proposedChanges(contract,input={}){
  if(!input||Array.isArray(input)||typeof input!=='object')throw new Error('Indicá los datos a rectificar.');
  const changes={};
  for(const [field,value] of Object.entries(input)){
    if(!RECTIFIABLE_FIELDS.includes(field))throw new Error('Ese campo no se rectifica por esta operación.');
    if(!equivalent(field,contract[field],value))changes[field]=normalize(field,value);
  }
  if(!Object.keys(changes).length)throw new Error('No hay diferencias contractuales para rectificar.');
  return changes;
}
module.exports={ADMIN_FIELDS,PROTECTED_FIELDS,RECTIFIABLE_FIELDS,normalize,equivalent,assertAdministrativeChange,proposedChanges};
