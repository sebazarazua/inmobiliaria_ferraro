const crypto=require('node:crypto');
const {uid}=require('../../database');
const {scaled,decimal,balance,paymentStatus}=require('../../lib/money');
const {periodKey}=require('../../lib/calendar');
const {LOCK,hash}=require('../ipc/store');
const SECRET=crypto.randomBytes(32),UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actor={id:'local-operator',label:'Operador local; sin sesión de usuario autenticada'};
const rows=async(db,sql,args=[])=>(await db.query(sql,args)).rows;
const net=row=>row?.status==='Confirmado'?scaled(row.original_amount)-scaled(row.forgiven_amount):0n;
const clean=(value,max=2000)=>typeof value==='string'?value.trim().slice(0,max):'';
function moneyInput(value,{optional=false}={}){
  if(optional&&(value===null||value===''||value===undefined))return null;
  if(!/^\d{1,12}(?:\.\d{1,2})?$/.test(String(value)))throw new Error('Ingresá un importe válido, sin negativos y con hasta dos decimales.');
  return decimal(scaled(value));
}
function publicCharge(row){const value=net(row);return {...row,net_amount:decimal(value),origin:row.expense_id?'Gasto vinculado':row.rule_id?'Recurrente':'Manual',display_status:row.status==='Confirmado'?(scaled(row.original_amount)>0n&&value===0n?'Perdonado':scaled(row.forgiven_amount)>0n?'Condonado parcialmente':'Confirmado'):row.status};}
async function chargeBreakdown(db,installmentIds){
  const list=await rows(db,"SELECT installment_id,charge_kind,SUM(original_amount-forgiven_amount)::text amount FROM installment_services WHERE installment_id=ANY($1::uuid[]) AND status='Confirmado' GROUP BY installment_id,charge_kind",[installmentIds]);
  return Object.fromEntries(installmentIds.map(id=>[id,Object.fromEntries(['service','recoverable','other'].map(kind=>[kind,list.find(r=>r.installment_id===id&&r.charge_kind===kind)?.amount||'0.00']))]));
}
async function serviceRegistry(db){
  return (await rows(db,`SELECT s.*,i.period,i.contract_id,c.property_id,c.code contract_code,c.alias contract_alias,p.address property,pe.full_name tenant FROM installment_services s JOIN installments i ON i.id=s.installment_id JOIN contracts c ON c.id=i.contract_id JOIN properties p ON p.id=c.property_id JOIN persons pe ON pe.id=c.tenant_id ORDER BY i.period DESC,s.created_at DESC,s.id`)).map(publicCharge);
}
async function readDetails(db,contractId){
  const contract=(await rows(db,`SELECT c.id,c.code,c.alias,c.property_id,c.status,c.currency,p.address property,pe.full_name tenant FROM contracts c JOIN properties p ON p.id=c.property_id JOIN persons pe ON pe.id=c.tenant_id WHERE c.id=$1`,[contractId]))[0];
  if(!contract)throw new Error('Contrato no encontrado.');
  const installments=await rows(db,`SELECT i.*,(COALESCE((SELECT SUM(amount) FROM payments WHERE installment_id=i.id),0)+i.manual_partial_amount)::text paid_amount,
    COALESCE((SELECT SUM(original_amount) FROM installment_services WHERE installment_id=i.id AND status='Confirmado'),0)::text services_original_amount,
    COALESCE((SELECT SUM(forgiven_amount) FROM installment_services WHERE installment_id=i.id AND status='Confirmado'),0)::text services_forgiven_amount FROM installments i WHERE contract_id=$1 ORDER BY period,id`,[contractId]);
  const breakdown=await chargeBreakdown(db,installments.map(i=>i.id));
  return {contract,installments:installments.map(row=>({...row,charges_breakdown:breakdown[row.id],total_amount:balance(row,0),balance:balance(row),due_amount:decimal(scaled(balance(row))>0n?scaled(balance(row)):0n)})),
    charges:(await rows(db,'SELECT s.* FROM installment_services s JOIN installments i ON i.id=s.installment_id WHERE i.contract_id=$1 ORDER BY s.created_at,s.id',[contractId])).map(publicCharge),
    rules:await rows(db,'SELECT * FROM service_rules WHERE contract_id=$1 ORDER BY created_at,id',[contractId]),
    history:await rows(db,"SELECT * FROM audit_log WHERE entity_type='contract' AND entity_id=$1 AND action='services_changed' ORDER BY created_at DESC,id",[contractId])};
}
async function serviceDetails(db,contractId){
  const client=await db.connect();try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const result=await readDetails(client,contractId);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
function signature(value){return crypto.createHmac('sha256',SECRET).update(JSON.stringify(value)).digest('hex');}
function tokenFor(fingerprint,expires){const payload=Buffer.from(JSON.stringify({fingerprint,expires})).toString('base64url');return payload+'.'+signature(payload);}
function verify(token,fingerprint){
  const [payload,mac]=String(token||'').split('.'),expected=signature(payload||'');
  if(!mac||mac.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(mac),Buffer.from(expected)))throw new Error('Falta una vista previa válida. Revisá el impacto de nuevo.');
  let data;try{data=JSON.parse(Buffer.from(payload,'base64url').toString());}catch{throw new Error('Vista previa inválida.');}
  if(data.fingerprint!==fingerprint||data.expires<Date.now())throw new Error('Cambió la cuota, el pago o la propuesta. Revisá el impacto de nuevo.');
}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));return value;}
async function serviceOperation(db,contractId,input,{apply=false,transactionClient=null}={}){
  if(!UUID.test(String(contractId))||!UUID.test(String(input.request_id)))throw new Error('Contrato o identificador de operación inválido.');
  const {token,confirm,...proposal}=input,requestHash=hash(canonical({contractId,proposal}));
  const client=transactionClient||await db.connect();
  const transaction=async command=>{if(!transactionClient)await client.query(command);};
  try{
    await transaction('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[LOCK]);
    const previous=(await rows(client,'SELECT * FROM service_operations WHERE request_id=$1',[input.request_id]))[0];
    if(previous){if(previous.request_hash!==requestHash)throw new Error('Ese identificador ya fue utilizado para otra operación.');if(!apply)throw new Error('La operación ya fue aplicada. Actualizá los servicios.');await transaction('ROLLBACK');return {...previous.result_json,replayed:true};}
    const contract=(await rows(client,'SELECT * FROM contracts WHERE id=$1 FOR UPDATE',[contractId]))[0];if(!contract)throw new Error('Contrato no encontrado.');
    if(input.contract_id&&input.contract_id!==contract.id)throw new Error('La cuota no corresponde al contrato indicado.');
    if(input.property_id&&input.property_id!==contract.property_id)throw new Error('La propiedad no corresponde al contrato.');
    const installments=await rows(client,'SELECT * FROM installments WHERE contract_id=$1 ORDER BY period,id FOR UPDATE',[contractId]);
    const charges=await rows(client,'SELECT s.* FROM installment_services s JOIN installments i ON i.id=s.installment_id WHERE i.contract_id=$1 ORDER BY s.id FOR UPDATE OF s',[contractId]);
    const payments=await rows(client,'SELECT p.* FROM payments p JOIN installments i ON i.id=p.installment_id WHERE i.contract_id=$1 ORDER BY p.id',[contractId]);
    const rules=await rows(client,'SELECT * FROM service_rules WHERE contract_id=$1 ORDER BY id',[contractId]);
    const reason=clean(input.reason);if(reason.length<5)throw new Error('Indicá un motivo de al menos cinco caracteres.');
    const operation=input.operation,changes=[],skipped=[];let newRule=null;
    const selected=installments.find(row=>row.id===input.installment_id);
    const active=['Activo','Revisión'].includes(contract.status);
    const checkRow=row=>{if(!row)throw new Error('La cuota no pertenece al contrato.');if(row.status==='Sustituido')throw new Error('La cuota fue sustituida: conservá sus cargos históricos.');if(row.financial_closed_at)throw new Error('El período está cerrado. Requiere reapertura contable por el circuito autorizado.');};
    function fields(value,row){
      const status=value.status||'Borrador';if(!['Borrador','Confirmado'].includes(status))throw new Error('Estado de cargo inválido.');
      const category=clean(value.category,80),description=clean(value.description,200),reference=clean(value.responsibility_reference);
      if(!category||!description)throw new Error('Completá el servicio y su descripción.');
      if(!['ARS','USD'].includes(value.currency)||value.currency!==row.currency||value.currency!==contract.currency)throw new Error('La moneda debe coincidir con la cuota y el contrato (ARS o USD).');
      if(status==='Confirmado'&&(value.responsibility_confirmed!==true||reference.length<5))throw new Error('Confirmá que el cargo corresponde al inquilino e indicá la condición contractual que lo respalda.');
      const charge_kind=value.charge_kind||'service';if(!['service','recoverable','other'].includes(charge_kind))throw new Error('Clasificación de cargo inválida.');
      return {category,description,charge_kind,original_amount:moneyInput(value.original_amount,{optional:status==='Borrador'}),currency:value.currency,status,responsibility_reference:reference||null,reference:clean(value.reference)||null,notes:clean(value.notes)||null,expense_id:value.expense_id||null};
    }
    if(operation==='create'||operation==='generate'){
      if(!active)throw new Error('No se generan cargos nuevos en un contrato finalizado, renovado o inactivo.');
      checkRow(selected);
      let config=input,rule=null;
      if(operation==='generate'){rule=rules.find(r=>r.id===input.rule_id);if(!rule)throw new Error('La recurrencia no pertenece al contrato.');config={...rule,original_amount:rule.amount,status:rule.mode==='fixed'?'Confirmado':'Borrador',responsibility_confirmed:input.responsibility_confirmed};}
      const scope=input.scope||'single';if(!['single','range','future'].includes(scope))throw new Error('Alcance de períodos inválido.');
      const start=scope==='future'?selected.period:scope==='range'?input.start_period:selected.period;
      const end=scope==='future'?periodKey(contract.end_date):scope==='range'?input.end_period:selected.period;
      if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(start)||!/^\d{4}-(0[1-9]|1[0-2])$/.test(end)||start>end||start<periodKey(contract.start_date)||end>periodKey(contract.end_date))throw new Error('Elegí períodos dentro de la vigencia del contrato.');
      const target=installments.filter(row=>row.period>=start&&row.period<=end);
      if(!target.length)throw new Error('No hay cuotas en el período seleccionado.');
      if(operation==='create'&&scope!=='single'){
        if(!['fixed','variable'].includes(input.mode))throw new Error('Elegí importe fijo o variable.');
        if(input.expense_id)throw new Error('Un gasto se vincula a un único cargo; distribuí su importe por el circuito de gastos.');
        newRule={category:clean(input.category,80),description:clean(input.description,200),charge_kind:input.charge_kind||'service',mode:input.mode,amount:input.mode==='variable'?null:moneyInput(input.original_amount),currency:input.currency,start_period:start,end_period:end,responsibility_reference:clean(input.responsibility_reference),reference:clean(input.reference)||null,notes:clean(input.notes)||null};
        if(newRule.responsibility_reference.length<5||input.responsibility_confirmed!==true)throw new Error('Verificá y referenciá la obligación del inquilino antes de configurar una recurrencia.');
      }
      for(const row of target){
        if(rule&&(row.period<rule.start_period||row.period>rule.end_period))continue;
        if(rule&&charges.some(s=>s.rule_id===rule.id&&s.installment_id===row.id)){skipped.push(row.period);continue;}
        checkRow(row);
        const variable=(newRule||rule)?.mode==='variable';
        const values=fields(variable?{...config,original_amount:null,status:'Borrador'}:config,row);
        changes.push({installment_id:row.id,before:null,after:{...values,forgiven_amount:'0.00',rule_id:rule?.id||null}});
      }
    }else{
      const before=charges.find(row=>row.id===input.service_id);if(!before)throw new Error('El servicio no pertenece al contrato.');
      const row=installments.find(row=>row.id===before.installment_id);checkRow(row);
      if(input.installment_id&&input.installment_id!==row.id)throw new Error('El servicio pertenece a otra cuota.');
      if(before.status==='Anulado')throw new Error('Un cargo anulado conserva su historial y no puede reutilizarse.');
      let after={...before};
      if(operation==='edit'){after={...after,...fields({...input,charge_kind:input.charge_kind||before.charge_kind},row)};if(before.expense_id&&after.expense_id!==before.expense_id)throw new Error('El vínculo de un gasto conserva su trazabilidad y no se retira ni sustituye.');if(scaled(after.forgiven_amount)>scaled(after.original_amount))throw new Error('El importe corregido no puede ser menor a lo ya condonado. Restaurá la condonación en una operación separada.');}
      else if(operation==='forgive'){if(before.status!=='Confirmado')throw new Error('Confirmá el cargo antes de condonarlo.');after.forgiven_amount=moneyInput(input.forgiven_amount);if(scaled(after.forgiven_amount)<=0n||scaled(after.forgiven_amount)>scaled(before.original_amount))throw new Error('El importe a perdonar debe ser positivo y no superar el original.');}
      else if(operation==='restore'){if(scaled(before.forgiven_amount)<=0n)throw new Error('El servicio no tiene una condonación para restaurar.');after.forgiven_amount='0.00';}
      else if(operation==='void'){after.status='Anulado';}
      else throw new Error('Operación de servicios no admitida.');
      if(!active&&net(after)>net(before))throw new Error('No se aumenta la obligación de un contrato finalizado, renovado o inactivo.');
      changes.push({installment_id:row.id,before,after});
    }
    for(const change of changes){
      const row=installments.find(i=>i.id===change.installment_id);
      if(row.period<periodKey(contract.start_date)||row.period>periodKey(contract.end_date))throw new Error('La cuota está fuera de vigencia.');
      if(change.after.expense_id){
        const expense=(await rows(client,'SELECT * FROM ledger_entries WHERE id=$1',[change.after.expense_id]))[0];
        if(!expense||expense.kind!=='Gasto'||(expense.voided_at&&(!change.before||net(change.after)>net(change.before)))||expense.property_id!==contract.property_id||(expense.contract_id&&expense.contract_id!==contract.id)||expense.currency!==row.currency)throw new Error('El gasto vinculado no corresponde a este cargo, propiedad o moneda.');
        if(!change.before||change.before.expense_id!==expense.id){
          if(['owner','agency'].includes(expense.responsibility))throw new Error('El gasto está asignado al propietario o inmobiliaria y no se traslada al inquilino.');
          const duplicate=(await rows(client,'SELECT id FROM installment_services WHERE expense_id=$1 AND id<>$2',[expense.id,change.before?.id||'00000000-0000-4000-8000-000000000000']))[0];if(duplicate)throw new Error('Este gasto ya tiene un cargo asociado, incluso si fue anulado. Revisá el cargo original.');
        }
        if((!change.before||scaled(change.after.original_amount)>scaled(change.before.original_amount))&&scaled(change.after.original_amount)>scaled(expense.amount))throw new Error('El cargo no puede superar el gasto vinculado.');
      }
    }
    const impacts=[];
    for(const id of [...new Set(changes.map(c=>c.installment_id))]){
      const row=installments.find(i=>i.id===id),paid=decimal(payments.filter(p=>p.installment_id===id).reduce((n,p)=>n+scaled(p.amount),scaled(row.manual_partial_amount)));
      const amount=changes.filter(c=>c.installment_id===id).reduce((n,c)=>n+net(c.after)-net(c.before),scaled(row.services_amount));
      if(amount<0n||amount>99999999999999n)throw new Error('El total de servicios de la cuota supera el importe permitido. Revisá los cargos antes de aplicar.');
      const next={...row,services_amount:decimal(amount)},oldBalance=balance(row,paid),newBalance=balance(next,paid);
      impacts.push({id,period:row.period,currency:row.currency,before_services:row.services_amount,services_amount:next.services_amount,paid_amount:paid,before_balance:oldBalance,balance:newBalance,total_amount:balance(next,0),previous_status:row.status,status:paymentStatus(next,paid),reopens:(row.status==='Pagado'||scaled(oldBalance)<=0n)&&scaled(newBalance)>0n,has_payments:scaled(paid)>0n});
    }
    const snapshot={contract,installments,charges,payments,rules},fingerprint=hash({requestHash,snapshot,changes,newRule,impacts,skipped});
    const result={operation,changes:changes.map(c=>({...c,before:c.before?publicCharge(c.before):null,after:publicCharge(c.after)})),impacts,skipped,new_rule:newRule,actor};
    if(!apply){await transaction('ROLLBACK');return {...result,token:tokenFor(fingerprint,Date.now()+15*60*1000)};}
    if(confirm!==true)throw new Error('Confirmá expresamente el impacto antes de aplicar.');verify(token,fingerprint);
    let ruleId;
    if(newRule){ruleId=uid();const keys=Object.keys(newRule);await client.query(`INSERT INTO service_rules(id,contract_id,${keys.join(',')}) VALUES($1,$2,${keys.map((_,i)=>'$'+(i+3)).join(',')})`,[ruleId,contractId,...Object.values(newRule)]);}
    const persisted=[];
    for(const change of changes){
      const columns=['category','description','charge_kind','original_amount','forgiven_amount','currency','status','responsibility_reference','reference','expense_id','notes'];
      const after=change.after,id=change.before?.id||uid();
      if(change.before)await client.query(`UPDATE installment_services SET ${columns.map((key,i)=>key+'=$'+(i+1)).join(',')},updated_at=now() WHERE id=$${columns.length+1}`,[...columns.map(key=>after[key]),id]);
      else await client.query(`INSERT INTO installment_services(id,installment_id,rule_id,${columns.join(',')}) VALUES($1,$2,$3,${columns.map((_,i)=>'$'+(i+4)).join(',')})`,[id,change.installment_id,ruleId||after.rule_id,...columns.map(key=>after[key])]);
      persisted.push({...change.after,installment_id:change.installment_id,id,rule_id:ruleId||after.rule_id});
    }
    for(const impact of impacts)await client.query('UPDATE installments SET status=$1 WHERE id=$2',[impact.status,impact.id]);
    const applied={...result,charges:persisted.map(publicCharge),rule_id:ruleId||input.rule_id||null,request_id:input.request_id};
    await client.query('INSERT INTO service_operations(request_id,contract_id,request_hash,result_json,actor_json,reason) VALUES($1,$2,$3,$4,$5,$6)',[input.request_id,contractId,requestHash,JSON.stringify(applied),JSON.stringify(actor),reason]);
    await client.query("INSERT INTO audit_log(id,entity_type,entity_id,action,details_json) VALUES($1,'contract',$2,'services_changed',$3)",[uid(),contractId,JSON.stringify({...applied,reason})]);
    await transaction('COMMIT');return applied;
  }catch(error){await transaction('ROLLBACK');throw error;}finally{if(!transactionClient)client.release();}
}
module.exports={serviceDetails,serviceOperation,publicCharge,serviceRegistry,chargeBreakdown};
