require('./require-isolated');
const test=require('node:test'),assert=require('node:assert/strict');
const {createApp}=require('../backend/src/app'),{uid}=require('../backend/src/database');
const {balance,paymentStatus}=require('../backend/src/lib/money');
async function setup(t){
  const app=await createApp(),db=app.db;
  await db.query('TRUNCATE persons,properties,contracts,installments,payments,documents,imports,import_exclusions,audit_log,rent_adjustment_history,service_operations,payment_requests RESTART IDENTITY CASCADE');
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>app.server.close(r));await db.end();});
  const base=`http://127.0.0.1:${app.server.address().port}/api/`;
  const call=async(route,input,method=input===undefined?'GET':'POST')=>{const res=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})});return{status:res.status,body:await res.json()};};
  const tenant=uid();await db.query("INSERT INTO persons(id,full_name) VALUES($1,'Inquilina Servicios Prueba')",[tenant]);
  async function contract(code='SERV-ARS',currency='ARS'){
    const property=uid();await db.query("INSERT INTO properties(id,code,address,normalized_address,property_type) VALUES($1,$2,$2,$2,'Departamento')",[property,code]);
    const r=await call('contracts',{code,property_id:property,tenant_id:tenant,rental_type:'Residencial',duration_months:12,start_date:'2026-01-01',initial_amount:currency==='ARS'?500000:100,currency,management_fee_pct:3,adjustment_type:'IPC',adjustment_index:'IPC',adjustment_frequency_months:3,ipc_lag_months:1,payment_due_day:10});assert.equal(r.status,201,JSON.stringify(r.body));return r.body.id;
  }
  const id=await contract(),installments=(await db.query('SELECT * FROM installments WHERE contract_id=$1 ORDER BY period',[id])).rows,jan=installments[0].id;
  const data=async(cid=id)=>(await call(`contracts/${cid}/services`)).body;
  const snap=async()=>({contracts:(await db.query('SELECT * FROM contracts ORDER BY id')).rows,installments:(await db.query('SELECT * FROM installments ORDER BY id')).rows,charges:(await db.query('SELECT * FROM installment_services ORDER BY id')).rows,rules:(await db.query('SELECT * FROM service_rules ORDER BY id')).rows,payments:(await db.query('SELECT * FROM payments ORDER BY id')).rows,ledger:(await db.query('SELECT * FROM ledger_entries ORDER BY id')).rows,audit:(await db.query('SELECT * FROM audit_log ORDER BY id')).rows,history:(await db.query('SELECT * FROM rent_adjustment_history ORDER BY id')).rows,operations:(await db.query('SELECT * FROM service_operations ORDER BY request_id')).rows});
  const input=(patch={})=>({operation:'create',installment_id:jan,category:'Expensas',description:'Expensas de enero',original_amount:'25000.00',currency:'ARS',status:'Confirmado',responsibility_confirmed:true,responsibility_reference:'Cláusula 8: servicios ordinarios a cargo del inquilino',reason:'Cargo verificado contra comprobante',request_id:uid(),...patch});
  const preview=async body=>{const before=await snap(),r=await call(`contracts/${id}/services/simulate`,body);assert.equal(r.status,200,JSON.stringify(r.body));assert.deepEqual(await snap(),before,'simular no persiste cambios');return r.body;};
  const apply=async(body=input())=>{const p=await preview(body),r=await call(`contracts/${id}/services/apply`,{...body,token:p.token,confirm:true});assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  return {db,call,id,jan,installments,contract,data,snap,input,preview,apply};
}

test('S01. cartera anterior sin servicios conserva exactamente saldos, pagos e IPC',async t=>{
  const {data,snap,call}=await setup(t),before=await snap();
  for(const row of (await call('pending-collections')).body){const original=balance({...row,services_amount:undefined});assert.equal(String(row.balance),String(Number(original)));assert.equal(row.services_amount,'0.00');}
  await data();assert.deepEqual(await snap(),before);
  assert.equal(balance({expected_amount:'0.10',vat_amount:'0.20',services_amount:'0.10',manual_partial_amount:50,paid_amount:'0.05'}),'0.35');
});

test('S02. varios conceptos independientes suman el saldo real y preservan canon e índices',async t=>{
  const {apply,input,data,snap,call,jan}=await setup(t),before=await snap();
  await apply(input());await apply(input({category:'Agua',description:'Agua enero',original_amount:'10000'}));await apply(input({category:'Gas',description:'Gas enero',original_amount:'8000'}));
  const d=await data(),row=d.installments.find(r=>r.id===jan);assert.equal(row.services_amount,'43000.00');assert.equal(row.due_amount,'543000.00');assert.equal(row.expected_amount,'500000.00');assert.equal(d.charges.length,3);
  const after=await snap();assert.deepEqual(after.contracts,before.contracts);assert.deepEqual(after.history,before.history);assert.deepEqual(after.ledger,before.ledger);assert.deepEqual(after.installments.map(r=>[r.id,r.expected_amount,r.contractual_amount,r.calculation_json,r.calculation_hash]),before.installments.map(r=>[r.id,r.expected_amount,r.contractual_amount,r.calculation_json,r.calculation_hash]));
  assert.equal((await call('pending-collections')).body.find(r=>r.id===jan).due_amount,543000);
});

test('S03. condonación total y parcial afecta solo el cargo, conserva originales y descuento general',async t=>{
  const {apply,input,data,jan,db}=await setup(t);const a=(await apply(input())).charges[0],b=(await apply(input({description:'Agua',category:'Agua',original_amount:'10000'}))).charges[0];
  await apply(input({operation:'forgive',service_id:b.id,forgiven_amount:'10000',reason:'Se perdona agua por acuerdo'}));
  await apply(input({operation:'forgive',service_id:a.id,forgiven_amount:'5000',reason:'Condonación parcial verificada'}));
  const d=await data();assert.equal(d.charges.find(r=>r.id===b.id).display_status,'Perdonado');assert.equal(d.charges.find(r=>r.id===b.id).original_amount,'10000.00');assert.equal(d.charges.find(r=>r.id===a.id).net_amount,'20000.00');assert.equal(d.installments.find(r=>r.id===jan).due_amount,'520000.00');assert.equal(d.installments[0].services_original_amount,'35000.00');assert.equal(d.installments[0].services_forgiven_amount,'15000.00');assert.equal((await db.query('SELECT discount_amount FROM installments WHERE id=$1',[jan])).rows[0].discount_amount,'0.00');
  assert.ok(d.history.some(h=>h.details_json.reason==='Condonación parcial verificada'&&h.details_json.actor.id==='local-operator'));
});

test('S04. restaurar un servicio y anular por error mantiene historial, otros cargos y pagos',async t=>{
  const {apply,input,data,snap}=await setup(t);const a=(await apply(input())).charges[0],b=(await apply(input({description:'Internet',original_amount:'15000'}))).charges[0];
  await apply(input({operation:'forgive',service_id:a.id,forgiven_amount:'25000'}));await apply(input({operation:'restore',service_id:a.id,reason:'Restauración por acuerdo documentado'}));
  const before=await snap();await apply(input({operation:'void',service_id:b.id,reason:'Servicio cargado a cuota equivocada'}));const d=await data(),after=await snap();
  assert.equal(d.charges.find(r=>r.id===a.id).net_amount,'25000.00');assert.equal(d.charges.find(r=>r.id===b.id).status,'Anulado');assert.equal(d.charges.length,2);assert.deepEqual(after.payments,before.payments);assert.deepEqual(after.ledger,before.ledger);assert.equal(d.history.length,5);
});

test('S05. corregir importe exige motivo y conserva antes/después con saldo',async t=>{
  const {apply,input,call,id,data}=await setup(t);const charge=(await apply(input({original_amount:'28000'}))).charges[0];
  const body=input({...charge,operation:'edit',service_id:charge.id,original_amount:'26000',reason:'Importe correcto según factura'});await apply(body);
  const d=await data();assert.equal(d.charges[0].original_amount,'26000.00');const log=d.history[0].details_json;assert.equal(log.changes[0].before.original_amount,'28000.00');assert.equal(log.changes[0].after.original_amount,'26000.00');assert.equal(log.impacts[0].balance,'526000.00');
  assert.equal((await call(`contracts/${id}/services/simulate`,{...body,request_id:uid(),reason:''})).status,400);
});

test('S06. un borrador sin evidencia ni importe no es exigible; confirmar requiere respaldo y valor',async t=>{
  const {apply,input,data,call,id}=await setup(t);const draft=(await apply(input({status:'Borrador',original_amount:null,responsibility_reference:'',responsibility_confirmed:false}))).charges[0];assert.equal((await data()).installments[0].due_amount,'500000.00');
  assert.equal((await call(`contracts/${id}/services/simulate`,input({operation:'edit',service_id:draft.id,status:'Confirmado',responsibility_confirmed:false}))).status,400);
  await apply(input({operation:'edit',service_id:draft.id,original_amount:'123.45'}));assert.equal((await data()).installments[0].due_amount,'500123.45');
});

test('S07. negativos, condonación excesiva, moneda incorrecta e IDs manipulados se rechazan sin escrituras',async t=>{
  const {apply,input,call,id,snap,contract,data}=await setup(t);const charge=(await apply(input())).charges[0],other=await contract('OTRO','USD'),otherRow=(await data(other)).installments[0];
  const before=await snap();
  for(const patch of [{original_amount:'-1'},{original_amount:'NaN'},{original_amount:'1.001'},{original_amount:'1000000000000'},{original_amount:'999999999999.99'},{currency:'EUR'},{currency:'USD'},{responsibility_confirmed:false},{responsibility_reference:''},{installment_id:otherRow.id},{property_id:uid()},{operation:'forgive',service_id:charge.id,forgiven_amount:'25000.01'},{operation:'edit',service_id:uid()},{operation:'void',service_id:charge.id,installment_id:otherRow.id}]){
    const r=await call(`contracts/${id}/services/simulate`,input(patch));assert.equal(r.status,400,JSON.stringify(patch));assert.deepEqual(await snap(),before);
  }
});

test('S08. pagos parciales y manuales se descuentan una sola vez; pago completo salda alquiler y servicios',async t=>{
  const {apply,input,call,jan,data,db}=await setup(t);await apply(input());
  await call(`pending-collections/${jan}`,{manual_partial_amount:10000},'PATCH');
  assert.equal((await call(`payments/${jan}/register`,{amount:'100000',request_id:uid()})).status,201);
  let row=(await data()).installments[0];assert.equal(row.paid_amount,'110000.00');assert.equal(row.due_amount,'415000.00');assert.equal(row.status,'Parcial');
  await call(`payments/${jan}/register`,{amount:'415000',request_id:uid()});row=(await data()).installments[0];assert.equal(row.paid_amount,'525000.00');assert.equal(row.due_amount,'0.00');assert.equal(row.status,'Pagado');assert.equal((await db.query('SELECT COUNT(*) n FROM payments')).rows[0].n,'2');
});

test('S09. cargo posterior al pago muestra reapertura y exige confirmación, sin tocar el pago original',async t=>{
  const {apply,input,call,id,jan,preview,snap,data}=await setup(t);await call(`payments/${jan}/register`,{amount:'500000'});const before=await snap(),body=input();
  const p=await preview(body);assert.equal(p.impacts[0].reopens,true);assert.equal(p.impacts[0].balance,'25000.00');
  assert.equal((await call(`contracts/${id}/services/apply`,{...body,token:p.token,confirm:false})).status,400);assert.deepEqual(await snap(),before);
  await apply(body);assert.equal((await data()).installments[0].status,'Parcial');assert.deepEqual((await snap()).payments,before.payments);
});

test('S10. condonar un cargo cobrado refleja saldo a favor y no borra dinero recibido',async t=>{
  const {apply,input,call,jan,data,snap}=await setup(t);const charge=(await apply(input())).charges[0];await call(`payments/${jan}/register`,{amount:'525000'});const before=await snap();
  await apply(input({operation:'forgive',service_id:charge.id,forgiven_amount:'5000'}));const row=(await data()).installments[0];assert.equal(row.balance,'-5000.00');assert.equal(row.due_amount,'0.00');assert.equal(row.status,'Pagado');assert.deepEqual((await snap()).payments,before.payments);
});

test('S11. recurrencia fija crea un cargo por mes y regenerar no duplica ni crea ingresos',async t=>{
  const {apply,input,data,db}=await setup(t);const result=await apply(input({description:'Internet',category:'Internet',original_amount:'15000',scope:'range',start_period:'2026-01',end_period:'2026-03',mode:'fixed'}));assert.equal(result.charges.length,3);assert.ok(result.rule_id);
  const generated=await apply(input({operation:'generate',rule_id:result.rule_id,scope:'range',start_period:'2026-01',end_period:'2026-03'}));assert.equal(generated.changes.length,0);assert.equal(generated.skipped.length,3);
  assert.equal((await data()).charges.length,3);assert.equal((await db.query('SELECT COUNT(*) n FROM ledger_entries')).rows[0].n,'0');assert.equal((await db.query('SELECT COUNT(*) n FROM payments')).rows[0].n,'0');
});

test('S12. recurrencia variable no inventa montos; confirmar y editar un mes no modifica otros',async t=>{
  const {apply,input,data,installments}=await setup(t);const result=await apply(input({scope:'future',mode:'variable',original_amount:'999999'}));assert.equal(result.charges.length,12);assert.ok(result.charges.every(c=>c.original_amount===null&&c.net_amount==='0.00'&&c.status==='Borrador'));
  const jan=result.charges.find(c=>c.installment_id===installments[0].id),feb=result.charges.find(c=>c.installment_id===installments[1].id);await apply(input({operation:'edit',service_id:jan.id,original_amount:'28000'}));
  await apply(input({operation:'edit',installment_id:installments[1].id,service_id:feb.id,original_amount:'31000'}));
  await apply(input({operation:'edit',service_id:jan.id,original_amount:'26000'}));const d=await data();assert.equal(d.charges.find(c=>c.id===jan.id).original_amount,'26000.00');assert.equal(d.charges.find(c=>c.id===feb.id).original_amount,'31000.00');assert.equal(d.charges.filter(c=>c.status==='Borrador').length,10);
});

test('S13. vigencia e inactividad bloquean nuevos cargos; historial y condonaciones siguen disponibles',async t=>{
  const {apply,input,call,id,db,data,snap}=await setup(t);const charge=(await apply(input())).charges[0];
  for(const status of ['Finalizado','Rescindido','Renovado','Anulado','Archivado','Desactivado']){
    await db.query('UPDATE contracts SET status=$1 WHERE id=$2',[status,id]);const before=await snap();assert.equal((await call(`contracts/${id}/services/simulate`,input())).status,400);assert.deepEqual(await snap(),before);
  }
  await apply(input({operation:'forgive',service_id:charge.id,forgiven_amount:'25000'}));assert.equal((await data()).charges.length,1);assert.equal((await call(`contracts/${id}/services/simulate`,input({operation:'restore',service_id:charge.id}))).status,400);
  await db.query("UPDATE contracts SET status='Activo' WHERE id=$1",[id]);assert.equal((await call(`contracts/${id}/services/simulate`,input({scope:'range',mode:'fixed',start_period:'2025-12',end_period:'2026-02'}))).status,400);
});

test('S14. gastos y cargos se vinculan sin convertir gastos históricos ni duplicar movimientos',async t=>{
  const {apply,input,call,id,data,snap,db}=await setup(t),property=(await data()).contract.property_id;
  const expense=await call('services',{description:'Factura de luz pagada por propietario',amount:20000,property_id:property,contract_id:id,currency:'ARS'});assert.equal(expense.status,201);assert.equal((await data()).charges.length,0);assert.equal((await data()).installments[0].services_amount,'0.00');
  const before=await snap();await apply(input({expense_id:expense.body.id,original_amount:'10000',category:'Electricidad'}));assert.deepEqual((await snap()).ledger,before.ledger);assert.equal((await data()).charges[0].expense_id,expense.body.id);
  const other=uid();await db.query("INSERT INTO ledger_entries(id,entry_date,kind,category,description,amount,currency) VALUES($1,current_date,'Gasto','Servicio','Sin propiedad',10,'ARS')",[other]);assert.equal((await call(`contracts/${id}/services/simulate`,input({expense_id:other}))).status,400);
});

test('S15. cuotas sustituidas y períodos cerrados no admiten cambios ni nuevos pagos',async t=>{
  const {db,jan,call,id,input,snap}=await setup(t);
  for(const closed of [false,true]){
    await db.query("UPDATE installments SET status=$1,financial_closed_at=$2 WHERE id=$3",[closed?'Pendiente':'Sustituido',closed?new Date():null,jan]);const before=await snap();
    assert.equal((await call(`contracts/${id}/services/simulate`,input())).status,400);assert.equal((await call(`payments/${jan}/register`,{amount:10})).status,400);assert.equal((await call(`pending-collections/${jan}`,{vat_amount:10},'PATCH')).status,400);assert.deepEqual(await snap(),before);
    if(closed){const reconciliation=await call('ipc/reconciliation/simulate',{contract_id:id});assert.equal(reconciliation.status,200);assert.ok(reconciliation.body.blocked.some(b=>b.id===jan&&b.error.includes('cerrado')));assert.deepEqual(await snap(),before);}
  }
});

test('S16. idempotencia y concurrencia aplican exactamente una operación y preservan auditoría',async t=>{
  const {input,preview,call,id,data,db}=await setup(t),body=input(),p=await preview(body),payload={...body,token:p.token,confirm:true};
  const results=await Promise.all([call(`contracts/${id}/services/apply`,payload),call(`contracts/${id}/services/apply`,payload)]);assert.ok(results.every(r=>r.status===200));assert.equal(results.filter(r=>r.body.replayed).length,1);assert.equal((await data()).charges.length,1);assert.equal((await data()).history.length,1);assert.equal((await db.query('SELECT COUNT(*) n FROM service_operations WHERE contract_id=$1',[id])).rows[0].n,'1');
  assert.equal((await call(`contracts/${id}/services/apply`,{...payload,original_amount:'1'})).status,400);
});

test('S17. propuestas concurrentes diferentes, pagos y ediciones invalidan simulaciones anteriores',async t=>{
  const {input,preview,call,id,jan,snap}=await setup(t),a=input(),b=input({description:'Agua',category:'Agua'}),pa=await preview(a),pb=await preview(b);
  const result=await Promise.all([call(`contracts/${id}/services/apply`,{...a,token:pa.token,confirm:true}),call(`contracts/${id}/services/apply`,{...b,token:pb.token,confirm:true})]);assert.deepEqual(result.map(r=>r.status).sort(),[200,400]);
  const c=input(),pc=await preview(c);await call(`payments/${jan}/register`,{amount:'100'});const before=await snap();assert.equal((await call(`contracts/${id}/services/apply`,{...c,token:pc.token,confirm:true})).status,400);assert.deepEqual(await snap(),before);
});

test('S18. token manipulado y propuesta modificada no autorizan cambios',async t=>{
  const {input,preview,call,id,snap}=await setup(t),body=input(),p=await preview(body),before=await snap();
  for(const patch of [{token:p.token+'x'},{token:p.token,original_amount:'26000'},{token:p.token,reason:'Otro motivo diferente'},{confirm:true}]){assert.equal((await call(`contracts/${id}/services/apply`,{...body,confirm:true,...patch})).status,400);assert.deepEqual(await snap(),before);}
});

test('S19. fallo tras actualizar cargos revierte proyección, auditoría y clave idempotente',async t=>{
  const {input,preview,call,id,snap,db}=await setup(t),body=input(),p=await preview(body),before=await snap();
  await db.query("CREATE FUNCTION fail_service_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fallo de prueba'; END $$; CREATE TRIGGER fail_service_test BEFORE INSERT ON service_operations FOR EACH ROW EXECUTE FUNCTION fail_service_test()");
  try{assert.equal((await call(`contracts/${id}/services/apply`,{...body,token:p.token,confirm:true})).status,400);assert.deepEqual(await snap(),before);}finally{await db.query('DROP TRIGGER fail_service_test ON service_operations; DROP FUNCTION fail_service_test()');}
});

test('S20. distribución usa el saldo con servicios, decimales y una transacción idempotente',async t=>{
  const {apply,input,call,id,jan,data,db}=await setup(t);await apply(input({original_amount:'0.10'}));const body={contract_id:id,amount:'500000.30',currency:'ARS',request_id:uid()};
  const a=await call('payments/register',body);assert.equal(a.status,201,JSON.stringify(a.body));assert.equal(a.body.distributed,500000.30);assert.equal(a.body.remaining,0);assert.equal((await data()).installments[0].status,'Pagado');assert.equal((await data()).installments[1].paid_amount,'0.20');
  const b=await call('payments/register',body);assert.equal(b.body.replayed,true);assert.equal((await db.query('SELECT COUNT(*) n FROM payments')).rows[0].n,'2');
  assert.equal((await call(`payments/${jan}/register`,{amount:1,currency:'USD'})).status,400);
});

test('S21. pago individual reintentado o simultáneo no se duplica',async t=>{
  const {call,jan,db}=await setup(t),body={amount:'5000',request_id:uid()},result=await Promise.all([call(`payments/${jan}/register`,body),call(`payments/${jan}/register`,body)]);assert.ok(result.every(r=>r.status===201));assert.equal(result.filter(r=>r.body.replayed).length,1);assert.equal((await db.query('SELECT COUNT(*) n FROM payments')).rows[0].n,'1');
});

test('S22. distribución fallida revierte cuotas anteriores de la misma operación',async t=>{
  const {call,id,installments,db,snap}=await setup(t);await db.query('UPDATE installments SET financial_closed_at=now() WHERE id=$1',[installments[1].id]);const before=await snap();
  assert.equal((await call('payments/register',{contract_id:id,amount:'600000',request_id:uid()})).status,400);assert.deepEqual(await snap(),before);
});

test('S23. subtotales mensuales y monedas independientes reflejan servicios y condonaciones',async t=>{
  const {apply,input,contract,data,call,id}=await setup(t);await apply(input());const usd=await contract('SERV-USD','USD'),d=await data(usd),body=input({installment_id:d.installments[0].id,currency:'USD',original_amount:'20.25'});
  const p=await call(`contracts/${usd}/services/simulate`,body);assert.equal(p.status,200);assert.equal((await call(`contracts/${usd}/services/apply`,{...body,token:p.body.token,confirm:true})).status,200);
  const pending=(await call('pending-collections')).body,{groupByPeriod}=await import('../frontend/src/utils/periods.mjs'),groups=groupByPeriod(pending);assert.deepEqual(groups[0].totals,[{currency:'ARS',amount:'525000.00'},{currency:'USD',amount:'120.25'}]);
  const details=await data(id);assert.equal(details.installments[0].total_amount,'525000.00');assert.equal(details.charges[0].net_amount,'25000.00');
});

test('S24. archivo conserva servicios y la eliminación física queda bloqueada explícitamente',async t=>{
  const {apply,input,call,id,db,data}=await setup(t);await apply(input());const impact=await call(`contracts/${id}/impact`);assert.equal(impact.status,200,JSON.stringify(impact.body));assert.equal(impact.body.can_delete,false);assert.ok(impact.body.blockers.some(x=>x.includes('servicios')));
  await db.query("UPDATE contracts SET status='Archivado' WHERE id=$1",[id]);assert.equal((await data()).charges.length,1);
});

test('S25. reconciliación IPC conserva servicios y usa el saldo integrado',async t=>{
  const {apply,input,call,id,jan,data,db}=await setup(t);await apply(input());const before=(await db.query('SELECT * FROM installment_services ORDER BY id')).rows;
  const preview=await call('ipc/reconciliation/simulate',{contract_id:id});assert.equal(preview.status,200);const plan=preview.body.rows.find(r=>r.id===jan);assert.equal(plan.balance,'525000.00');
  const result=await call('ipc/reconciliation/apply',{contract_id:id,token:preview.body.token,reason:'Verificación de servicios independientes',interpretation_confirmed:true});assert.equal(result.status,200);assert.deepEqual((await db.query('SELECT * FROM installment_services ORDER BY id')).rows,before);assert.equal((await data()).installments[0].due_amount,'525000.00');
});

test('S26. renovación conserva cargos superpuestos y no traslada recurrencias al nuevo contrato',async t=>{
  const {apply,input,call,id,installments,data,db,snap}=await setup(t),july=installments[6].id;
  await apply(input({installment_id:july,scope:'future',mode:'fixed',original_amount:'15000',description:'Internet del contrato anterior'}));
  const original=(await data()).contract,next=uid(),document=uid();
  const tenant=(await db.query('SELECT tenant_id FROM contracts WHERE id=$1',[id])).rows[0].tenant_id;
  await db.query("INSERT INTO documents(id,filename,absolute_path,sha256,property_id) VALUES($1,'renovacion-sintetica.pdf',$2,$3,$4)",[document,`/isolated-fixture/${document}.pdf`,'a'.repeat(64),original.property_id]);
  await db.query("INSERT INTO contracts(id,code,property_id,tenant_id,rental_type,duration_months,start_date,end_date,initial_amount,currency,status,source_document_id) VALUES($1,'SERV-RENOVACION',$2,$3,'Residencial',12,'2026-07-01','2027-06-30',600000,'ARS','Revisión',$4)",[next,original.property_id,tenant,document]);
  await db.query('UPDATE documents SET contract_id=$1 WHERE id=$2',[next,document]);
  const before=await snap(),renew=await call(`contracts/${id}/renew`,{new_contract_id:next});assert.equal(renew.status,201,JSON.stringify(renew.body));
  assert.equal((await data()).installments.find(i=>i.id===july).status,'Pendiente');assert.equal((await data(next)).rules.length,0);assert.equal((await data(next)).charges.length,0);assert.deepEqual((await snap()).charges,before.charges);
  assert.equal((await call(`contracts/${id}/services/simulate`,input({installment_id:july}))).status,400);
});

test('S27. dashboard muestra saldo integrado y totales mensuales separados por moneda',async t=>{
  const {db,apply,input,call,id,installments}=await setup(t),month=new Date().toISOString().slice(0,7);let row=installments.find(i=>i.period===month);
  if(!row){row=installments[0];await db.query('UPDATE contracts SET start_date=$1,end_date=$2 WHERE id=$3',[month+'-01',month+'-28',id]);await db.query('UPDATE installments SET period=$1 WHERE id=$2',[month,row.id]);}
  await apply(input({installment_id:row.id,original_amount:'25.10'}));
  const dashboard=(await call('dashboard')).body,pending=(await call('pending-collections')).body;
  const total=(await db.query('SELECT (expected_amount+vat_amount+late_fee_amount+services_amount-discount_amount)::text total FROM installments WHERE id=$1',[row.id])).rows[0].total;
  assert.equal(dashboard.kpis.expected_month_by_currency.ARS,total);assert.equal(dashboard.kpis.expected_month,Number(total));
  for(const item of dashboard.due){assert.equal(item.due_amount,pending.find(p=>p.id===item.id).due_amount);}
});

test('S28. migrar una cartera 014 con pagos, descuentos y gastos no cambia saldos ni crea cargos',async()=>{
  const {Pool}=require('pg'),fs=require('node:fs'),path=require('node:path');
  const db=new Pool({connectionString:process.env.DATABASE_URL}),client=await db.connect(),schema='legacy_services_'+uid().replaceAll('-','');
  try{
    await client.query(`CREATE SCHEMA ${schema}`);await client.query(`SET search_path TO ${schema},public`);
    const directory=path.join(__dirname,'..','database','migrations');
    for(const file of fs.readdirSync(directory).filter(f=>f.endsWith('.sql')&&f<'015').sort())await client.query(fs.readFileSync(path.join(directory,file),'utf8'));
    const person=uid(),property=uid(),contract=uid(),installment=uid(),payment=uid(),expense=uid();
    await client.query("INSERT INTO persons(id,full_name) VALUES($1,'Cartera anterior')",[person]);
    await client.query("INSERT INTO properties(id,code,address,normalized_address,property_type) VALUES($1,'LEGACY','Cartera 014','cartera 014','Departamento')",[property]);
    await client.query("INSERT INTO contracts(id,code,property_id,tenant_id,rental_type,duration_months,start_date,end_date,initial_amount) VALUES($1,'LEGACY',$2,$3,'Residencial',12,'2026-01-01','2026-12-31',500000)",[contract,property,person]);
    await client.query("INSERT INTO installments(id,contract_id,period,due_date,expected_amount,vat_amount,late_fee_amount,discount_amount,manual_partial_amount,status) VALUES($1,$2,'2026-01','2026-01-10',500000,105000,2000,1000,10000,'Parcial')",[installment,contract]);
    await client.query("INSERT INTO payments(id,installment_id,amount,paid_at) VALUES($1,$2,100000,'2026-01-05')",[payment,installment]);
    await client.query("INSERT INTO ledger_entries(id,entry_date,kind,category,description,amount,property_id,contract_id) VALUES($1,'2026-01-03','Gasto','Servicio','Luz del propietario',20000,$2,$3)",[expense,property,contract]);
    await client.query("INSERT INTO recurring_charges(id,contract_id,charge_type,value) VALUES($1,$2,'Agua',12000)",[uid(),contract]);
    const before=(await client.query('SELECT * FROM installments')).rows[0],payments=(await client.query('SELECT * FROM payments')).rows,ledger=(await client.query('SELECT * FROM ledger_entries')).rows;
    const oldBalance=balance(before,'110000');assert.equal(oldBalance,'496000.00');
    await client.query(fs.readFileSync(path.join(directory,'015_installment_services.sql'),'utf8'));
    const after=(await client.query('SELECT * FROM installments')).rows[0];assert.equal(after.services_amount,'0.00');assert.equal(after.financial_closed_at,null);assert.equal(balance(after,'110000'),oldBalance);
    const {services_amount,financial_closed_at,...originalColumns}=after;assert.deepEqual(originalColumns,before);assert.deepEqual((await client.query('SELECT * FROM payments')).rows,payments);assert.deepEqual((await client.query('SELECT * FROM ledger_entries')).rows,ledger);
    assert.equal((await client.query('SELECT COUNT(*) n FROM installment_services')).rows[0].n,'0');assert.equal((await client.query('SELECT COUNT(*) n FROM service_rules')).rows[0].n,'0');assert.equal((await client.query('SELECT COUNT(*) n FROM recurring_charges')).rows[0].n,'1');
  }finally{await client.query('SET search_path TO public');await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);client.release();await db.end();}
});
