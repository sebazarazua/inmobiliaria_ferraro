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
    before:{vat_amount:row.vat_amount,late_fee_amount:row.late_fee_amount,discount_amount:row.discount_amount,manual_partial_amount:row.manual_partial_amount,payment_snapshot:row.payment_snapshot,expected_amount:row.expected_amount,contractual_amount:row.contractual_amount,adjustment_pending:row.adjustment_pending,status:row.status,calculation_hash:row.calculation_hash,override_amount:row.rent_override_amount}};
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
  const series=await loadStoredSeries(client),plans=[],blocked=[],summaries=[];
  for(const contract of contracts){
    const installments=(await client.query(`SELECT i.*,(COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.installment_id=i.id),0)+i.manual_partial_amount)::text paid_total,
      COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM payments p WHERE p.installment_id=i.id),'[]'::jsonb) payment_snapshot
      FROM installments i WHERE contract_id=$1 AND status<>'Sustituido' ${managedOnly?'AND ipc_managed=true':''} ORDER BY period,id FOR UPDATE`,[contract.id])).rows;
    const contractPlans=[],contractBlocked=[];
    if(!managedOnly){
      try{
        validateIpcContract(contract);
        const periods=(await client.query('SELECT period,status FROM installments WHERE contract_id=$1 ORDER BY period',[contract.id])).rows;
        const expected=Number(contract.duration_months);
        if(periods.length!==expected || new Set(periods.map(r=>r.period)).size!==expected)throw new Error('Cronograma incompleto o duplicado. Revisá las cuotas del contrato.');
        for(let i=0;i<expected;i++)if(periods[i].period!==shiftMonth(contract.start_date,i))throw new Error('El cronograma no coincide con la vigencia contractual.');
      }catch(error){contractBlocked.push({id:contract.id,contract_id:contract.id,error:error.message});}
    }
    for(const row of installments){
      try{
        if(contract.ipc_clause_review_required)throw new Error('La cláusula IPC requiere revisión humana.');
        if(row.period<periodKey(contract.start_date)||row.period>periodKey(contract.end_date))throw new Error('Cuota fuera de la vigencia contractual; revisar cronograma.');
        const plan=planInstallment(contract,row,series,row.paid_total),previous=previousRows?.get(row.id);
        if(previous){plan.previous_amount=previous.expected_amount;plan.before=previous;}
        plans.push(plan);contractPlans.push(plan);
      }catch(error){contractBlocked.push({id:row.id,contract_id:contract.id,period:row.period,error:error.message});}
    }
    blocked.push(...contractBlocked);
    const issues=[];
    if(contractPlans.some(p=>p.legacy)&&!contract.ipc_clause_text)issues.push('Requiere revisar condiciones: consultá la cláusula original.');
    if(contractPlans.some(p=>p.legacy&&scaled(p.expected_amount)!==scaled(p.previous_amount)))issues.push('Revisar diferencias históricas.');
    if(contractPlans.some(p=>p.override_amount!==null))issues.push('Hay acuerdos o correcciones manuales que se conservan.');
    if(contractPlans.some(p=>scaled(p.paid_amount)>0n))issues.push('Hay pagos históricos: revisá saldos y créditos.');
    if(contractPlans.some(p=>p.legacy&&p.previous_status==='Pagado'&&scaled(p.paid_amount)===0n))issues.push('Cuotas marcadas pagadas sin un pago identificado: revisar antecedentes.');
    const adjustments=[...new Map(contractPlans.flatMap(p=>p.calculation.steps).map(step=>[step.effectivePeriod,step])).values()];
    const current=contractPlans.filter(p=>p.period<=periodKey(new Date())).at(-1);
    const totals={};
    for(const plan of contractPlans){
      const t=totals[plan.currency]||(totals[plan.currency]={previous_amount:'0.00',contractual_amount:'0.00',canon_difference:'0.00',paid_amount:'0.00',balance:'0.00'});
      for(const key of ['previous_amount','contractual_amount','paid_amount','balance'])t[key]=decimal(scaled(t[key])+scaled(plan[key]));
      t.canon_difference=decimal(scaled(t.canon_difference)+scaled(plan.expected_amount)-scaled(plan.previous_amount));
    }
    const snapshotContract=Object.fromEntries(['id','code','status','start_date','end_date','duration_months','payment_due_day','initial_amount','currency','adjustment_index','adjustment_frequency_months','ipc_lag_months','ipc_clause_text','ipc_clause_review_required','previous_contract_id'].map(field=>[field,field==='ipc_clause_text'?contract[field]||null:contract[field]]));
    summaries.push({id:contract.id,code:contract.code,alias:contract.alias,status:contract.status,
      classification:contractBlocked.some(row=>!row.error.includes('cláusula IPC'))?'blocked':contractBlocked.length||issues.length?'review':'ready',issues,
      legacy_count:contractPlans.filter(p=>p.legacy).length,count:contractPlans.length,changed:contractPlans.filter(p=>p.changed||p.legacy).length,
      pending_count:contractPlans.filter(p=>p.adjustment_pending).length,
      initial_amount:contract.initial_amount,current_amount:current?.contractual_amount||null,currency:contract.currency,
      start_date:contract.start_date,end_date:contract.end_date,frequency_months:contract.adjustment_frequency_months,lag_months:contract.ipc_lag_months,
      adjustments,totals,blocked:contractBlocked,
      token:hash({contract:snapshotContract,installments,plans:contractPlans,blocked:contractBlocked})});
  }
  const previewToken=hash(summaries.map(contract=>({id:contract.id,token:contract.token})));
  if(apply){
    if(!managedOnly){
      if(!token||(token!==previewToken && !(contractId&&token===summaries[0]?.token)))throw new Error('La simulación cambió o falta su token. Volvé a simular antes de aplicar.');
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
    contracts:summaries,count:plans.length,changed:plans.filter(p=>p.changed||p.legacy).length,blocked,totals,rows:plans};
}

async function reconcileInstallments(db,options={}) {
  const client=await db.connect();
  try{await client.query('BEGIN');const result=await reconcileOnClient(client,options);await client.query('COMMIT');return result;}
  catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
// Each approved contract owns a transaction and a fresh snapshot check. An unrelated
// blocked or concurrently modified contract cannot roll back another approved one.
async function applyReconciliationBatch(db,{contractIds,tokens,reason,interpretationConfirmed}={}){
  if(!Array.isArray(contractIds)||!contractIds.length||contractIds.length>500)throw new Error('Seleccioná entre 1 y 500 contratos de la simulación.');
  if(!reason?.trim()||interpretationConfirmed!==true)throw new Error('Confirmá la revisión y el motivo antes de incorporar contratos.');
  const results=[];
  for(const id of [...new Set(contractIds)]){
    try{
      if(!tokens?.[id])throw new Error('Falta la simulación vigente de este contrato.');
      const result=await reconcileInstallments(db,{contractId:id,apply:true,token:tokens[id],reason,interpretationConfirmed});
      if(!result.contracts.length)throw new Error('Contrato IPC no encontrado.');
      results.push({contract_id:id,status:'applied',changed:result.changed});
    }catch(error){results.push({contract_id:id,status:'blocked',error:error.message});}
  }
  return{mode:'applied',results,changed:results.reduce((n,r)=>n+(r.changed||0),0),applied:results.filter(r=>r.status==='applied').length};
}
async function simulateContractChanges(db,contractId,changes) {
  if(!contractId)throw new Error('Indicá el contrato a modificar.');
  const allowed=['duration_months','payment_due_day','start_date','end_date','initial_amount','adjustment_frequency_months','adjustment_index','ipc_lag_months','currency','ipc_clause_text'];
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
module.exports={generateInstallments,planInstallment,reconcileOnClient,reconcileInstallments,applyReconciliationBatch,simulateContractChanges,refreshAndUpdate};
