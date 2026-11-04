const {uid}=require('../../database');
const {scaled,decimal,balance}=require('../../lib/money');
const {hash,issue,verify,uuid,amount,reason,actor,day}=require('../late-fees/common');
const {serviceOperation}=require('./index');
const LOCK='ferraro:ipc:write';
async function expenseOperation(db,input,{apply=false}={}){
  if(!uuid.test(String(input.request_id)))throw new Error('Identificador de operación inválido.');
  const {token,confirm,...proposal}=input,requestHash=hash(proposal),why=reason(input.reason),client=await db.connect();
  try{
    await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[LOCK]);
    const prior=(await client.query('SELECT * FROM expense_operations WHERE request_id=$1',[input.request_id])).rows[0];
    if(prior){if(prior.request_hash!==requestHash)throw new Error('La clave ya pertenece a otra operación.');if(!apply)throw new Error('La operación ya fue aplicada.');await client.query('ROLLBACK');return {...prior.result_json,replayed:true};}
    let result,serviceInput,contractId;
    if(input.operation==='create'){
      const responsibility=input.responsibility||'undetermined';if(!['owner','agency','tenant','undetermined'].includes(responsibility))throw new Error('Responsable inválido.');
      const value=amount(input.amount);if(scaled(value)<=0n)throw new Error('El gasto debe ser positivo.');
      if(!['ARS','USD'].includes(input.currency))throw new Error('Moneda inválida.');
      const description=String(input.description||'').trim().slice(0,200);if(!description)throw new Error('Completá el concepto.');
      const date=day(input.entry_date),propertyId=input.property_id||null;
      if(propertyId&&!(await client.query('SELECT id FROM properties WHERE id=$1',[propertyId])).rowCount)throw new Error('Propiedad inexistente.');
      contractId=input.contract_id||null;
      if(contractId){const c=(await client.query('SELECT * FROM contracts WHERE id=$1 FOR UPDATE',[contractId])).rows[0];if(!c||c.property_id!==propertyId||c.currency!==input.currency)throw new Error('Contrato, propiedad o moneda incompatibles.');}
      const expense={id:input.request_id,entry_date:date,kind:'Gasto',category:input.category==='Servicio'?'Servicio':'General',description,amount:value,currency:input.currency,property_id:propertyId,contract_id:contractId,responsibility};
      await client.query('INSERT INTO ledger_entries(id,entry_date,kind,category,description,amount,currency,property_id,contract_id,responsibility) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',Object.values(expense));
      let service=null;
      if(responsibility==='tenant'){
        if(!propertyId||!contractId||!input.installment_id)throw new Error('Elegí propiedad, contrato y cuota para registrar el gasto y su cargo juntos.');
        const supported=input.responsibility_confirmed===true&&String(input.responsibility_reference||'').trim().length>=5;
        serviceInput={request_id:input.request_id,operation:'create',installment_id:input.installment_id,scope:'single',category:input.charge_category||description,description,original_amount:value,currency:input.currency,status:supported?'Confirmado':'Borrador',charge_kind:expense.category==='Servicio'?'service':'recoverable',expense_id:expense.id,responsibility_reference:input.responsibility_reference||'',responsibility_confirmed:supported,reason:why};
        service=await serviceOperation(db,contractId,serviceInput,{transactionClient:client});
      }
      result={operation:'create',expense,service,message:service?(service.changes[0].after.status==='Confirmado'?'Gasto y obligación revisados conjuntamente.':'Gasto contable y cargo borrador pendiente de respaldo; no integra el saldo.'):'Gasto contable sin deuda al inquilino.'};
    }else if(input.operation==='void'){
      const expense=(await client.query("SELECT * FROM ledger_entries WHERE id=$1 AND kind='Gasto' FOR UPDATE",[input.expense_id])).rows[0];if(!expense)throw new Error('Gasto no encontrado.');if(expense.voided_at)throw new Error('El gasto ya está anulado.');
      if(expense.category==='Depósito')throw new Error('Este movimiento corresponde al circuito de devolución de depósito. Requiere una corrección coordinada de ese circuito; no se anula como gasto independiente.');
      const linked=(await client.query(`SELECT s.*,i.period,(COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.installment_id=i.id),0)+i.manual_partial_amount)::text paid_amount,i.expected_amount,i.vat_amount,i.late_fee_amount,i.services_amount,i.discount_amount FROM installment_services s JOIN installments i ON i.id=s.installment_id WHERE s.expense_id=$1 ORDER BY s.id`,[expense.id])).rows;
      if(linked.length&&input.keep_charges!==true)throw new Error('Este gasto tiene cargos. Confirmá conservarlos: su corrección se revisa por separado desde Servicios, incluyendo pagos y posibles créditos.');
      const payments=(await client.query('SELECT p.* FROM payments p JOIN installment_services s ON s.installment_id=p.installment_id WHERE s.expense_id=$1 ORDER BY p.id',[expense.id])).rows;
      result={operation:'void',expense,linked:linked.map(s=>({...s,balance:balance(s)})),payments,message:'Se anula el gasto contable mediante marca auditable. Los cargos, pagos y saldos del inquilino se conservan; corregí cada cargo por separado en Servicios si corresponde.'};
    }else throw new Error('Operación de gasto inválida.');
    // Child tokens and generated source timestamps are not economic inputs of this outer preview.
    const stable=JSON.parse(JSON.stringify(result));if(stable.service)delete stable.service.token;
    const fingerprint=hash({requestHash,result:stable});
    if(!apply){await client.query('ROLLBACK');return {...result,token:issue(fingerprint)};}
    if(confirm!==true)throw new Error('Revisá y confirmá expresamente la operación conjunta.');verify(token,fingerprint);
    if(serviceInput){const p=await serviceOperation(db,contractId,serviceInput,{transactionClient:client});result.service=await serviceOperation(db,contractId,{...serviceInput,token:p.token,confirm:true},{apply:true,transactionClient:client});}
    if(input.operation==='void')await client.query('UPDATE ledger_entries SET voided_at=now(),void_reason=$1 WHERE id=$2',[why,input.expense_id]);
    const applied={...result,actor,reason:why};
    await client.query('INSERT INTO expense_operations(request_id,request_hash,result_json) VALUES($1,$2,$3)',[input.request_id,requestHash,JSON.stringify(applied)]);
    await client.query("INSERT INTO audit_log(id,entity_type,entity_id,action,details_json) VALUES($1,'ledger_entry',$2,$3,$4)",[uid(),result.expense.id,'expense_'+input.operation,JSON.stringify(applied)]);
    await client.query('COMMIT');return applied;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
module.exports={expenseOperation};
