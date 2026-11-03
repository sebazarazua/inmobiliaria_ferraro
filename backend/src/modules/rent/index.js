const {uid}=require('../../database');
const {periodKey,shiftMonth,dueDate}=require('../../lib/calendar');
const {decimal,scaled,balance,paymentStatus}=require('../../lib/money');
const {calculateIpcAmount,validateIpcContract}=require('../ipc');
const {hash,LOCK,loadStoredSeries,refreshOfficialIndices}=require('../ipc/store');

function planInstallment(contract,row,series,paid='0') {
  const calculation=calculateIpcAmount(contract,row.period,series);
  const override=row.rent_override_amount??(row.rent_forgiven?'0.00':null);
  const expected=override==null?calculation.amountDecimal:decimal(scaled(override));
  // An unrelated new official month must not create another version of a calculation.
  const {latestOfficialPeriod,...relevant}=calculation;
  const fingerprint=hash({calculation:relevant,override,clause:contract.ipc_clause_text||null});
  const next={...row,expected_amount:expected,adjustment_pending:calculation.pendingOfficialData};
  return {id:row.id,contract_id:contract.id,contract_code:contract.code,clause_text:contract.ipc_clause_text||null,period:row.period,currency:row.currency,
    original_amount:row.original_expected_amount??row.expected_amount,previous_amount:row.expected_amount,
    contractual_amount:calculation.amountDecimal,expected_amount:expected,paid_amount:decimal(scaled(paid)),
    balance:balance(next,paid),previous_status:row.status,status:paymentStatus(next,paid),
    adjustment_pending:calculation.pendingOfficialData,override_amount:override,
    legacy:!row.ipc_managed,changed:row.calculation_hash!==fingerprint||scaled(row.expected_amount)!==scaled(expected)||row.adjustment_pending!==calculation.pendingOfficialData||row.status!==paymentStatus(next,paid),
    calculation_hash:fingerprint,calculation,
    before:{expected_amount:row.expected_amount,contractual_amount:row.contractual_amount,adjustment_pending:row.adjustment_pending,status:row.status,calculation_hash:row.calculation_hash,override_amount:row.rent_override_amount}};
}

async function persistPlan(client,plan,reason) {
  const version=(await client.query('SELECT COALESCE(MAX(version),0)+1 version FROM rent_adjustment_history WHERE installment_id=$1',[plan.id])).rows[0].version;
  await client.query(`INSERT INTO rent_adjustment_history(id,installment_id,contract_id,version,previous_amount,new_amount,effective_period,calculation_hash,reason,details_json)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[uid(),plan.id,plan.contract_id,version,plan.previous_amount,plan.expected_amount,plan.calculation.effectivePeriod||plan.period,plan.calculation_hash,reason,JSON.stringify(plan)]);
  await client.query(`UPDATE installments SET expected_amount=$1,contractual_amount=$2,adjustment_pending=$3,status=$4,
    original_expected_amount=COALESCE(original_expected_amount,expected_amount),ipc_managed=true,calculation_hash=$5,calculation_json=$6 WHERE id=$7`,
    [plan.expected_amount,plan.contractual_amount,plan.adjustment_pending,plan.status,plan.calculation_hash,JSON.stringify(plan.calculation),plan.id]);
}

async function generateInstallments(client,contract,{reason='contract_created'}={}) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[LOCK]);
  const duration=Number(contract.duration_months),start=periodKey(contract.start_date);
  if(!Number.isInteger(duration)||duration<1||duration>1200)throw new Error('Duración contractual inválida (1–1200 meses).');
  if(contract.adjustment_index==='IPC')validateIpcContract(contract);
  if(contract.adjustment_index==='IPC'&&contract.ipc_clause_review_required)throw new Error('La cláusula IPC es ambigua. Revisá y confirmá su interpretación antes de crear el contrato.');
  const series=await loadStoredSeries(client);
  for(let offset=0;offset<duration;offset++){
    const period=shiftMonth(start,offset),id=uid();
    const calculation=calculateIpcAmount(contract,period,series);
    const expected=calculation.amountDecimal;
    await client.query(`INSERT INTO installments(id,contract_id,period,due_date,expected_amount,currency,adjustment_pending,ipc_managed,contractual_amount,original_expected_amount)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$5,$5)`,[id,contract.id,period,dueDate(period,contract.payment_due_day||10),expected,contract.currency||'ARS',Boolean(calculation.pendingOfficialData||calculation.pendingManualAdjustment),contract.adjustment_index==='IPC']);
    if(contract.adjustment_index==='IPC'){
      const row={id,period,currency:contract.currency||'ARS',expected_amount:expected,status:'Pendiente',adjustment_pending:calculation.pendingOfficialData,ipc_managed:true};
      await persistPlan(client,planInstallment(contract,row,series),reason);
    }
  }
}

async function reconcileOnClient(client,{contractId=null,managedOnly=false,apply=false,token=null,reason='',interpretationConfirmed=false,previousRows=null}={}) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[LOCK]);
  const contracts=(await client.query(`SELECT * FROM contracts c WHERE c.adjustment_index='IPC' ${contractId?'AND c.id=$1':''} ORDER BY c.id FOR UPDATE`,contractId?[contractId]:[])).rows;
  const series=await loadStoredSeries(client),plans=[],blocked=[];
  for(const contract of contracts){
    const installments=(await client.query(`SELECT i.*,(COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.installment_id=i.id),0)+i.manual_partial_amount)::text paid_total
      FROM installments i WHERE contract_id=$1 AND status<>'Sustituido' ${managedOnly?'AND ipc_managed=true':''} ORDER BY period,id FOR UPDATE`,[contract.id])).rows;
    for(const row of installments){
      try{
        if(contract.ipc_clause_review_required)throw new Error('La cláusula IPC requiere revisión humana.');
        if(row.period<periodKey(contract.start_date)||row.period>periodKey(contract.end_date))throw new Error('Cuota fuera de la vigencia contractual; revisar cronograma.');
        const plan=planInstallment(contract,row,series,row.paid_total),previous=previousRows?.get(row.id);
        if(previous){plan.previous_amount=previous.expected_amount;plan.before=previous;}
        plans.push(plan);
      }catch(error){blocked.push({id:row.id,contract_id:contract.id,period:row.period,error:error.message});}
    }
  }
  const previewToken=hash({plans,blocked});
  if(apply){
    if(!managedOnly){
      if(!token||token!==previewToken)throw new Error('La simulación cambió o falta su token. Volvé a simular antes de aplicar.');
      if(!reason.trim())throw new Error('Indicá el motivo de la conciliación.');
      if(plans.some(p=>p.legacy)&&!interpretationConfirmed)throw new Error('Verificá las cláusulas y confirmá su interpretación antes de incorporar cuotas existentes.');
      if(blocked.length)throw new Error('Hay cuotas bloqueadas para revisión. No se aplicó la conciliación.');
    }
    for(const plan of plans)if(plan.changed||plan.legacy)await persistPlan(client,plan,reason||'official_indices_updated');
  }
  const totals={};
  for(const plan of plans){
    const currency=plan.currency||'ARS';
    const entry=totals[currency]||(totals[currency]={canon_difference:'0.00',balance:'0.00'});
    entry.canon_difference=decimal(scaled(entry.canon_difference)+scaled(plan.expected_amount)-scaled(plan.previous_amount));
    entry.balance=decimal(scaled(entry.balance)+scaled(plan.balance));
  }
  return {mode:apply?'applied':'simulation',token:previewToken,latestPeriod:series.latestPeriod,
    count:plans.length,changed:plans.filter(p=>p.changed||p.legacy).length,blocked,totals,rows:plans};
}

async function reconcileInstallments(db,options={}) {
  const client=await db.connect();
  try{await client.query('BEGIN');const result=await reconcileOnClient(client,options);await client.query('COMMIT');return result;}
  catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function simulateContractChanges(db,contractId,changes) {
  if(!contractId)throw new Error('Indicá el contrato a modificar.');
  const allowed=['start_date','end_date','initial_amount','adjustment_frequency_months','adjustment_index','ipc_lag_months','currency','ipc_clause_text'];
  const values=[],assignments=[];
  for(const field of allowed)if(changes[field]!==undefined){
    values.push(changes[field]===''?null:changes[field]);assignments.push(`${field}=$${values.length}`);
  }
  const client=await db.connect();
  try{
    await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[LOCK]);
    const existing=(await client.query('SELECT id FROM contracts WHERE id=$1 FOR UPDATE',[contractId])).rows[0];
    if(!existing)throw new Error('Contrato no encontrado.');
    if(assignments.length){values.push(contractId);await client.query(`UPDATE contracts SET ${assignments.join(',')} WHERE id=$${values.length}`,values);}
    if(changes.ipc_clause_confirmed===true)await client.query('UPDATE contracts SET ipc_clause_review_required=false WHERE id=$1',[contractId]);
    const result=await reconcileOnClient(client,{contractId});
    await client.query('ROLLBACK');return result;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function refreshAndUpdate(db,options={}) {
  const refresh=await refreshOfficialIndices(db,options);
  // Only previously enrolled rows can be changed automatically, including paid provisional rows.
  const reconciliation=await reconcileInstallments(db,{managedOnly:true,apply:true,reason:'official_indices_updated'});
  return {refresh,reconciliation:{count:reconciliation.count,changed:reconciliation.changed,blocked:reconciliation.blocked}};
}
module.exports={generateInstallments,planInstallment,reconcileOnClient,reconcileInstallments,simulateContractChanges,refreshAndUpdate};
