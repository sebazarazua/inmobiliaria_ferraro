const {scaled,decimal,balance}=require('../../lib/money');
const {hash,issue,verify,amount,reason,uuid}=require('./common');
async function excessPlan(client,installmentId,input){
  if(!uuid.test(String(input.request_id)))throw new Error('La operación de excedente requiere un identificador de reintento.');
  const why=reason(input.excess_reason),value=amount(input.amount);if(scaled(value)<=0n)throw new Error('El pago debe ser positivo.');
  const link=(await client.query('SELECT contract_id FROM installments WHERE id=$1',[installmentId])).rows[0];if(!link)throw new Error('Cuota no encontrada.');
  const contract=(await client.query('SELECT * FROM contracts WHERE id=$1 FOR UPDATE',[link.contract_id])).rows[0];
  const row=(await client.query('SELECT * FROM installments WHERE id=$1 FOR UPDATE',[installmentId])).rows[0];
  if(row.status==='Sustituido'||row.financial_closed_at)throw new Error('La cuota está sustituida o el período está cerrado.');
  if(input.currency&&input.currency!==row.currency)throw new Error('La moneda no coincide con la cuota.');
  const payments=(await client.query('SELECT * FROM payments WHERE installment_id=$1 ORDER BY id',[row.id])).rows;
  const paid=decimal(payments.reduce((n,p)=>n+scaled(p.amount),scaled(row.manual_partial_amount))),signed=scaled(balance(row,paid)),due=signed>0n?signed:0n;
  if(scaled(value)<=due)throw new Error('El importe no excede el saldo. Usá el registro normal del pago.');
  const credit=scaled(value)-signed;
  const preview={installment_id:row.id,contract_id:contract.id,currency:row.currency,amount:value,paid_amount:paid,due_amount:decimal(due),previous_credit:decimal(signed<0n?-signed:0n),credit_amount:decimal(credit),excess_amount:decimal(scaled(value)-due),reason:why};
  const {excess_token,excess_confirm,...proposal}=input;
  return {preview,fingerprint:hash({installmentId,proposal,contract,row,payments,preview})};
}
async function simulateExcess(db,id,input){const client=await db.connect();try{await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtext('ferraro:ipc:write'))");const plan=await excessPlan(client,id,input);await client.query('ROLLBACK');return {...plan.preview,token:issue(plan.fingerprint)};}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
async function approveExcess(client,id,input){if(input.excess_confirm!==true)throw new Error('Confirmá expresamente el crédito resultante.');const plan=await excessPlan(client,id,input);verify(input.excess_token,plan.fingerprint);return plan.preview;}
module.exports={simulateExcess,approveExcess};
