require('./require-isolated');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {uid}=require('../backend/src/database'),{createApp}=require('../backend/src/app');
const {pdf}=require('./support/p0-fixtures'),{importRates,parseOfficialBulletin,sourceUrl,PRODUCT}=require('../backend/src/modules/late-fees/rates');
const {calculate}=require('../backend/src/modules/late-fees/engine');
const {fixedQuote,bankQuote,clausePdf}=require('./support/late-fee-fixtures');
const fixture=fs.readFileSync(path.join(__dirname,'fixtures/bna-cartera-20250930.html'),'utf8');
const source='https://www.boletinoficial.gov.ar/detalleAviso/primera/332108/20250930';
const terms=(type='FIXED_DAILY')=>({type,dailyPercentage:'0.10',startsFrom:'AFTER_DUE_DATE',graceDays:0,base:'RENT_OUTSTANDING',accumulation:'SIMPLE',allocation:'RENT_FIRST',periodicity:'DAILY',paymentTiming:'START_OF_DAY',cutoffConvention:'INCLUSIVE',...(type==='BANK_ACTIVE_RATE'?{product:PRODUCT,dayBasis:365}:{})});
async function setup(t,{bank=false}={}){
  const app=await createApp(),db=app.db;await db.query('TRUNCATE persons,properties,contracts,installments,payments,documents,imports,audit_log,rent_adjustment_history,service_operations,payment_requests,late_fee_operations,late_fee_rates,late_fee_rate_sources RESTART IDENTITY CASCADE');
  const directory=path.join(process.env.FERRARO_TEST_IMPORT_DIRECTORY,'late-fees-'+uid());fs.mkdirSync(directory);await db.query("UPDATE settings SET value=$1 WHERE key='import_directory'",[directory]);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await db.query("UPDATE settings SET value=$1 WHERE key='import_directory'",[process.env.FERRARO_TEST_IMPORT_DIRECTORY]);await new Promise(r=>app.server.close(r));await db.end();fs.rmSync(directory,{recursive:true,force:true});});
  const call=async(route,input,method=input===undefined?'GET':'POST')=>{const response=await fetch(`http://127.0.0.1:${app.server.address().port}/api/${route}`,{method,headers:{'Content-Type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})});return{status:response.status,body:await response.json()};};
  const person=uid(),property=uid(),id=uid(),installment=uid(),doc=uid(),quote=bank?bankQuote:fixedQuote;
  await db.query("INSERT INTO persons(id,full_name) VALUES($1,'Mora prueba')",[person]);await db.query("INSERT INTO properties(id,code,address,normalized_address,property_type) VALUES($1,'MORA','Mora Prueba 140','mora prueba 140','Departamento')",[property]);
  await db.query("INSERT INTO contracts(id,code,property_id,tenant_id,rental_type,duration_months,start_date,end_date,initial_amount,adjustment_index,late_fee_json) VALUES($1,'MORA',$2,$3,'Residencial',12,'2025-01-01','2025-12-31',100000,'IPC',$4)",[id,property,person,JSON.stringify({type:bank?'BANK_ACTIVE_RATE':'FIXED_DAILY',dailyPercentage:bank?null:0.1,startsFrom:'AFTER_DUE_DATE',bankRateMultiplier:1})]);
  await db.query("INSERT INTO installments(id,contract_id,period,due_date,expected_amount,contractual_amount,ipc_managed) VALUES($1,$2,'2025-09','2025-09-22',100000,100000,true)",[installment,id]);
  const file=path.join(directory,'mora.pdf'),bytes=clausePdf(quote);fs.writeFileSync(file,bytes);await db.query('INSERT INTO documents(id,filename,absolute_path,sha256,contract_id,property_id) VALUES($1,$2,$3,$4,$5,$6)',[doc,'mora.pdf',file,crypto.createHash('sha256').update(bytes).digest('hex'),id,property]);await db.query('UPDATE contracts SET source_document_id=$1 WHERE id=$2',[doc,id]);
  const reviewInput=()=>({request_id:uid(),confirm:true,reason:'Interpretación cotejada con cláusula original',document_id:doc,document_quote:quote,document_reference:'Cláusula mora página 1',terms:terms(bank?'BANK_ACTIVE_RATE':'FIXED_DAILY')});
  const review=async()=>{const r=await call(`contracts/${id}/late-fees/review`,reviewInput());assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  const input=(patch={})=>({request_id:uid(),operation:'calculate',cutoff:'2025-09-29',reason:'Revisión de mora hasta fecha de corte',...patch});
  const snapshot=async()=>({contract:(await db.query('SELECT * FROM contracts WHERE id=$1',[id])).rows[0],installments:(await db.query('SELECT * FROM installments ORDER BY id')).rows,payments:(await db.query('SELECT * FROM payments ORDER BY id')).rows,ledger:(await db.query('SELECT * FROM ledger_entries ORDER BY id')).rows,services:(await db.query('SELECT * FROM installment_services ORDER BY id')).rows,ipc:(await db.query('SELECT * FROM rent_adjustment_history ORDER BY id')).rows,history:(await db.query('SELECT * FROM late_fee_history ORDER BY id')).rows,audit:(await db.query('SELECT * FROM audit_log ORDER BY id')).rows,operations:(await db.query('SELECT * FROM late_fee_operations ORDER BY request_id')).rows});
  const simulate=async body=>{const before=await snapshot(),r=await call(`installments/${installment}/late-fees/simulate`,body);assert.equal(r.status,200,JSON.stringify(r.body));assert.deepEqual(await snapshot(),before);return r.body;};
  const apply=async(body=input())=>{const p=await simulate(body),r=await call(`installments/${installment}/late-fees/apply`,{...body,token:p.token,confirm:true});assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  const rates=()=>importRates(db,{url:source},{fetchImpl:async()=>({ok:true,text:async()=>fixture})});
  return {db,call,id,installment,doc,quote,file,review,reviewInput,input,snapshot,simulate,apply,rates};
}

test('M01. tasa fija diaria con revisión documental, corte incluido y saldo autoritativo',async t=>{
  const s=await setup(t);await s.review();const before=await s.snapshot(),preview=await s.simulate(s.input());assert.equal(preview.calculation.days,7);assert.equal(preview.gross_amount,'700.00');assert.equal(preview.balance,'100700.00');
  await s.apply();const after=await s.snapshot();assert.equal(after.installments[0].late_fee_amount,'700.00');assert.deepEqual(after.contract,before.contract);assert.deepEqual(after.payments,before.payments);assert.deepEqual(after.ipc,before.ipc);assert.equal((await s.call('pending-collections')).body[0].due_amount,100700);
});
test('M02. tasas BNA históricas reales, modalidad TNA30 exacta y cambios dentro del período',async t=>{
  const s=await setup(t,{bank:true});await s.review();assert.equal((await s.rates()).count,5);const result=await s.simulate(s.input());assert.equal(result.calculation.segments.length,5);assert.deepEqual(result.calculation.segments.map(x=>x.percentage),['52.050000','51.900000','53.170000','54.300000','54.450000']);
  assert.equal(result.gross_amount,'1025.95');assert.ok(result.calculation.segments.every(x=>x.source.url===source&&x.source.content_hash));await s.apply();
});
test('M03. parser oficial no confunde anticipada, vencida, plazos ni TEA; importación idempotente',async t=>{
  const s=await setup(t,{bank:true}),parsed=parseOfficialBulletin(fixture);assert.equal(parsed[0].annual_percentage,'52.05');assert.equal(parsed[0].valid_from,'2025-09-23');assert.equal(parsed.at(-1).valid_until,'2025-09-30');
  const a=await s.rates(),b=await s.rates();assert.equal(a.id,b.id);assert.equal(b.replayed,true);assert.equal((await s.db.query('SELECT COUNT(*) n FROM late_fee_rates')).rows[0].n,'5');
  for(const value of ['http://www.boletinoficial.gov.ar/detalleAviso/primera/332108/20250930','https://example.com','https://www.boletinoficial.gov.ar.evil.test/detalleAviso/primera/1/20250101','https://user@www.boletinoficial.gov.ar/detalleAviso/primera/1/20250101'])assert.throws(()=>sourceUrl(value));
  assert.throws(()=>parseOfficialBulletin('<table>TNA 50</table>'));assert.throws(()=>parseOfficialBulletin(fixture.replace('<td>30</td>','<td>60</td>')));
});
test('M04. falta de revisión, serie o un día oficial bloquea sin alterar cuotas',async t=>{
  const s=await setup(t,{bank:true});assert.equal((await s.call(`installments/${s.installment}/late-fees/simulate`,s.input())).status,400);await s.review();const before=await s.snapshot();assert.equal((await s.call(`installments/${s.installment}/late-fees/simulate`,s.input())).status,400);assert.deepEqual(await s.snapshot(),before);
  await s.rates();const missing=await s.call(`installments/${s.installment}/late-fees/simulate`,s.input({cutoff:'2025-09-30'}));assert.equal(missing.status,400);assert.match(missing.body.error,/2025-09-30/);
});
test('M05. cláusula ambigua, otro producto, capitalización o parámetros insuficientes no se aprueban',async t=>{
  const s=await setup(t,{bank:true}),body=s.reviewInput(),before=await s.snapshot();
  for(const patch of [{terms:{...body.terms,product:'BNA_DESCUBIERTO'}},{terms:{...body.terms,accumulation:'COMPOUND'}},{terms:{...body.terms,base:'TOTAL_WITH_SERVICES'}},{terms:{...body.terms,dayBasis:null}},{document_quote:'Tasa activa del Banco Nacion.'},{confirm:false}]){assert.equal((await s.call(`contracts/${s.id}/late-fees/review`,{...body,...patch})).status,400);assert.deepEqual(await s.snapshot(),before);}
});
test('M06. mora con pago parcial reduce capital desde el inicio de su día, sin duplicar pagos',async t=>{
  const s=await setup(t);await s.review();await s.call(`payments/${s.installment}/register`,{amount:'40000',paid_at:'2025-09-25'});const result=await s.simulate(s.input());assert.equal(result.gross_amount,'500.00');assert.deepEqual(result.calculation.segments.map(s=>[s.days,s.principal]),[[2,'100000.00'],[5,'60000.00']]);assert.equal(result.balance,'60500.00');
});
test('M07. fecha de corte anterior al pago, pago total y crédito histórico no generan mora posterior',async t=>{
  const s=await setup(t);await s.review();await s.call(`payments/${s.installment}/register`,{amount:'100000',paid_at:'2025-09-25'});assert.equal((await s.simulate(s.input({cutoff:'2025-09-24'}))).gross_amount,'200.00');const result=await s.simulate(s.input());assert.equal(result.gross_amount,'200.00');assert.equal(result.calculation.days,2);assert.equal(result.calculation.segments.at(-1).principal,'0.00');
  await s.db.query('INSERT INTO payments(id,installment_id,amount,paid_at) VALUES($1,$2,20000,$3)',[uid(),s.installment,'2025-09-22']);assert.equal((await s.simulate(s.input())).gross_amount,'160.00');
});
test('M08. condonación parcial, total y restauración conservan el cálculo original y motivo',async t=>{
  const s=await setup(t);await s.review();await s.apply();await s.apply(s.input({operation:'forgive',forgiven_amount:'200',reason:'Acuerdo de condonación parcial'}));let row=(await s.snapshot()).installments[0];assert.equal(row.late_fee_calculated_amount,'700.00');assert.equal(row.late_fee_forgiven_amount,'200.00');assert.equal(row.late_fee_amount,'500.00');
  await s.apply(s.input({operation:'forgive',forgiven_amount:'700'}));assert.equal((await s.snapshot()).installments[0].late_fee_amount,'0.00');await s.apply(s.input({operation:'restore'}));row=(await s.snapshot()).installments[0];assert.equal(row.late_fee_amount,'700.00');assert.equal((await s.snapshot()).history.length,4);
});
test('M09. no se autorizan cambios con confirmación sola, token ajeno, montos negativos o condonación excesiva',async t=>{
  const s=await setup(t);await s.review();await s.apply();const before=await s.snapshot(),body=s.input(),p=await s.simulate(body);
  for(const patch of [{token:p.token+'x',confirm:true},{token:p.token,confirm:false},{token:p.token,confirm:true,cutoff:'2025-09-28'}])assert.equal((await s.call(`installments/${s.installment}/late-fees/apply`,{...body,...patch})).status,400);
  for(const value of ['-1','700.01','1.001'])assert.equal((await s.call(`installments/${s.installment}/late-fees/simulate`,s.input({operation:'forgive',forgiven_amount:value}))).status,400);assert.deepEqual(await s.snapshot(),before);
  assert.equal((await s.call(`pending-collections/${s.installment}`,{late_fee_amount:800},'PATCH')).status,400);
});
test('M10. reintentos concurrentes y cálculo equivalente no duplican versiones',async t=>{
  const s=await setup(t);await s.review();const body=s.input(),p=await s.simulate(body),responses=await Promise.all([1,2].map(()=>s.call(`installments/${s.installment}/late-fees/apply`,{...body,token:p.token,confirm:true})));assert.ok(responses.every(r=>r.status===200));assert.equal(responses.filter(r=>r.body.replayed).length,1);assert.equal((await s.apply()).unchanged,true);assert.equal((await s.snapshot()).history.length,1);
});
test('M11. pagos o PDF alterados invalidan la simulación anterior',async t=>{
  const s=await setup(t);await s.review();const body=s.input(),p=await s.simulate(body);await s.call(`payments/${s.installment}/register`,{amount:'1000',paid_at:'2025-09-25'});const paid=await s.snapshot();assert.equal((await s.call(`installments/${s.installment}/late-fees/apply`,{...body,token:p.token,confirm:true})).status,400);assert.deepEqual(await s.snapshot(),paid);
  fs.writeFileSync(s.file,pdf('Documento cambiado de prueba'));assert.equal((await s.call(`installments/${s.installment}/late-fees/simulate`,s.input())).status,400);
});
test('M12. capital provisional, pago manual sin fecha, descuento sin imputación y cierre quedan bloqueados',async t=>{
  const s=await setup(t);await s.review();
  for(const patch of ["adjustment_pending=true","manual_partial_amount=1000","discount_amount=500","financial_closed_at=now()","status='Sustituido'","period='2026-01'","currency='USD'"]){await s.db.query('UPDATE installments SET '+patch+' WHERE id=$1',[s.installment]);const before=await s.snapshot();assert.equal((await s.call(`installments/${s.installment}/late-fees/simulate`,s.input())).status,400);assert.deepEqual(await s.snapshot(),before);await s.db.query("UPDATE installments SET adjustment_pending=false,manual_partial_amount=0,discount_amount=0,financial_closed_at=NULL,status='Pendiente',period='2025-09',currency='ARS' WHERE id=$1",[s.installment]);}
});
test('M13. rollback de error posterior a actualizar importe preserva todo el historial',async t=>{
  const s=await setup(t);await s.review();const body=s.input(),p=await s.simulate(body),before=await s.snapshot();await s.db.query("CREATE FUNCTION fail_late_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Fallo aislado'; END $$; CREATE TRIGGER fail_late_test BEFORE INSERT ON late_fee_operations FOR EACH ROW EXECUTE FUNCTION fail_late_test()");try{assert.equal((await s.call(`installments/${s.installment}/late-fees/apply`,{...body,token:p.token,confirm:true})).status,400);assert.deepEqual(await s.snapshot(),before);}finally{await s.db.query('DROP TRIGGER fail_late_test ON late_fee_operations; DROP FUNCTION fail_late_test()');}
});
test('M14. integración con servicios y canon IPC conserva ambos componentes y pagos históricos',async t=>{
  const s=await setup(t);await s.review();await s.db.query("INSERT INTO installment_services(id,installment_id,category,description,original_amount,forgiven_amount,currency,status,responsibility_reference) VALUES($1,$2,'Agua','Agua',10000,2000,'ARS','Confirmado','Cláusula de servicios')",[uid(),s.installment]);const before=await s.snapshot();await s.apply();const after=await s.snapshot();assert.equal(after.installments[0].services_amount,'8000.00');assert.equal(after.installments[0].expected_amount,before.installments[0].expected_amount);assert.deepEqual(after.services,before.services);assert.deepEqual(after.ipc,before.ipc);assert.equal((await s.call('pending-collections')).body[0].due_amount,108700);
});
test('M15. registro normal y distribuido rechazan sobrepago sin escrituras; no hay bypass manual',async t=>{
  const s=await setup(t),before=await s.snapshot();for(const route of [`payments/${s.installment}/register`,'payments/register']){const r=await s.call(route,{contract_id:s.id,amount:'100001',allow_excess:true,confirmed:true,request_id:uid()});assert.equal(r.status,400);assert.deepEqual(await s.snapshot(),before);}
  assert.equal((await s.call(`pending-collections/${s.installment}`,{manual_partial_amount:100001},'PATCH')).status,400);assert.deepEqual(await s.snapshot(),before);
});
test('M16. excedente explícito muestra crédito, requiere token y confirmación y no se duplica',async t=>{
  const s=await setup(t),body={amount:'110000',paid_at:'2025-09-29',excess_reason:'Transferencia recibida con excedente acordado',request_id:uid()},before=await s.snapshot(),p=await s.call(`payments/${s.installment}/excess/simulate`,body);assert.equal(p.status,200);assert.equal(p.body.credit_amount,'10000.00');assert.deepEqual(await s.snapshot(),before);
  assert.equal((await s.call(`payments/${s.installment}/excess/apply`,{...body,excess_token:p.body.token,excess_confirm:false})).status,400);
  const payload={...body,excess_token:p.body.token,excess_confirm:true},responses=await Promise.all([1,2].map(()=>s.call(`payments/${s.installment}/excess/apply`,payload)));assert.ok(responses.every(r=>r.status===201));assert.equal(responses.filter(r=>r.body.replayed).length,1);const after=await s.snapshot();assert.equal(after.payments.length,1);assert.equal(after.payments[0].amount,'110000.00');assert.ok(after.audit.some(a=>a.action==='payment_excess_confirmed'));assert.deepEqual(after.ledger,before.ledger);
});
test('M17. cambio de deuda invalida excedente; créditos históricos se conservan y pueden revisarse explícitamente',async t=>{
  const s=await setup(t),body={amount:'110000',excess_reason:'Transferencia con crédito explícito',request_id:uid()},p=await s.call(`payments/${s.installment}/excess/simulate`,body);await s.call(`payments/${s.installment}/register`,{amount:'1000'});const paid=await s.snapshot();assert.equal((await s.call(`payments/${s.installment}/excess/apply`,{...body,excess_token:p.body.token,excess_confirm:true})).status,400);assert.deepEqual(await s.snapshot(),paid);
  await s.db.query('INSERT INTO payments(id,installment_id,amount,paid_at) VALUES($1,$2,110000,$3)',[uid(),s.installment,'2025-09-25']);const before=await s.snapshot();assert.equal((await s.call(`payments/${s.installment}/register`,{amount:'1'})).status,400);assert.deepEqual(await s.snapshot(),before);const q=await s.call(`payments/${s.installment}/excess/simulate`,{...body,request_id:uid(),amount:'100'});assert.equal(q.body.previous_credit,'11000.00');assert.equal(q.body.credit_amount,'11100.00');
});
test('M18. sin mora aún no hay interés ni necesidad de extrapolar una tasa futura',async t=>{
  const s=await setup(t,{bank:true});await s.review();const p=await s.simulate(s.input({cutoff:'2025-09-22'}));assert.equal(p.gross_amount,'0.00');assert.equal(p.calculation.days,0);
});

test('M19. un PDF real con tasa activa genérica o acumulación contradictoria no autoriza una modalidad',async t=>{
  const s=await setup(t,{bank:true}),generic=bankQuote.replace('cartera general prestamos nominal anual vencida a 30 dias, base 365','tasa activa contractual sin modalidad precisa');
  const bytes=clausePdf(generic);fs.writeFileSync(s.file,bytes);await s.db.query('UPDATE documents SET sha256=$1 WHERE id=$2',[crypto.createHash('sha256').update(bytes).digest('hex'),s.doc]);
  const r=await s.call(`contracts/${s.id}/late-fees/review`,{...s.reviewInput(),document_quote:generic});assert.equal(r.status,400);assert.match(r.body.error,/modalidad BNA/);
  for(const ambiguous of [bankQuote.replace('primero al capital','primero a los intereses y luego al capital'),bankQuote.replace('Se incluye','No se incluye'),bankQuote.replace('del alquiler','del alquiler y los servicios')]){const data=clausePdf(ambiguous);fs.writeFileSync(s.file,data);await s.db.query('UPDATE documents SET sha256=$1 WHERE id=$2',[crypto.createHash('sha256').update(data).digest('hex'),s.doc]);assert.equal((await s.call(`contracts/${s.id}/late-fees/review`,{...s.reviewInput(),document_quote:ambiguous})).status,400);}
  const contradictory=bankQuote+' Con capitalizacion mensual.',other=clausePdf(contradictory);fs.writeFileSync(s.file,other);await s.db.query('UPDATE documents SET sha256=$1 WHERE id=$2',[crypto.createHash('sha256').update(other).digest('hex'),s.doc]);assert.equal((await s.call(`contracts/${s.id}/late-fees/review`,{...s.reviewInput(),document_quote:contradictory})).status,400);
});
test('M20. errores oficiales, contenido no reconocido y tasas contradictorias no reemplazan evidencia',async t=>{
  const s=await setup(t,{bank:true});
  await assert.rejects(importRates(s.db,{url:source},{fetchImpl:async()=>({ok:false})}));assert.equal((await s.db.query('SELECT COUNT(*) n FROM late_fee_rates')).rows[0].n,'0');
  await assert.rejects(importRates(s.db,{url:source},{fetchImpl:async()=>({ok:true,text:async()=>'<html>Sin publicación</html>'})}));await s.rates();
  const changed=fixture.replace('52,05','52,06');await assert.rejects(importRates(s.db,{url:source},{fetchImpl:async()=>({ok:true,text:async()=>changed})}),/contradice/);assert.equal((await s.db.query('SELECT COUNT(*) n FROM late_fee_rate_sources')).rows[0].n,'1');assert.equal((await s.db.query('SELECT annual_percentage FROM late_fee_rates ORDER BY valid_from LIMIT 1')).rows[0].annual_percentage,'52.050000');
});
test('M21. primer día condicionado a mora, gracia y redondeo único al final',()=>{
  const contract={adjustment_index:'IPC'},installment={expected_amount:'100000',manual_partial_amount:0,discount_amount:0,currency:'ARS',ipc_managed:true,due_date:'2025-09-22'},base={contract,installment,payments:[],rates:[]};
  let review={id:uid(),terms_json:{...terms(),startsFrom:'FIRST_DAY_OF_MONTH'},evidence_json:{}};
  assert.equal(calculate({...base,review,cutoff:'2025-09-22'}).gross_amount,'0.00');assert.equal(calculate({...base,review,cutoff:'2025-09-23'}).gross_amount,'2300.00');
  review={...review,terms_json:{...terms(),graceDays:2}};assert.equal(calculate({...base,review,cutoff:'2025-09-26'}).gross_amount,'200.00');
  review={...review,terms_json:{...terms(),dailyPercentage:'0.333333'}};assert.equal(calculate({...base,review,cutoff:'2025-09-25'}).gross_amount,'1000.00');
  assert.throws(()=>calculate({...base,review,cutoff:'2025-02-30'}));assert.throws(()=>calculate({...base,review,cutoff:'9999-01-01'}));
});
test('M22. pagos históricos con claves anteriores siguen siendo reintentables sin nuevo movimiento',async t=>{
  const s=await setup(t),body={amount:110000,request_id:uid()},oldResult={id:s.installment,paid:110000,status:'Pagado'};
  await s.db.query('INSERT INTO payments(id,installment_id,amount,paid_at) VALUES($1,$2,110000,$3)',[uid(),s.installment,'2025-09-22']);
  const oldHash=crypto.createHash('sha256').update(JSON.stringify({installmentId:s.installment,distribute:false,input:body})).digest('hex');await s.db.query('INSERT INTO payment_requests(request_id,request_hash,result_json) VALUES($1,$2,$3)',[body.request_id,oldHash,JSON.stringify(oldResult)]);
  const before=await s.snapshot(),r=await s.call(`payments/${s.installment}/register`,body);assert.equal(r.status,201);assert.equal(r.body.replayed,true);assert.deepEqual(await s.snapshot(),before);
});
test('M23. condonación de importe histórico conserva el registrado sin fingir un cálculo nuevo',async t=>{
  const s=await setup(t);await s.db.query('UPDATE installments SET late_fee_amount=1200 WHERE id=$1',[s.installment]);await s.db.query('INSERT INTO payments(id,installment_id,amount,paid_at) VALUES($1,$2,101200,$3)',[uid(),s.installment,'2025-09-22']);const before=await s.snapshot();const r=await s.apply(s.input({operation:'forgive',forgiven_amount:'200',reason:'Condonación de importe histórico por acuerdo'}));assert.equal(r.calculation.origin,'legacy_recorded');assert.equal(r.balance,'-200.00');assert.deepEqual((await s.snapshot()).payments,before.payments);
});

test('M24. migración 016 conserva cartera 015 con punitorios y sobrepago históricos',async()=>{
  const {Pool}=require('pg'),db=new Pool({connectionString:process.env.DATABASE_URL}),client=await db.connect(),schema='legacy_mora_'+uid().replaceAll('-','');
  try{await client.query(`CREATE SCHEMA ${schema}`);await client.query(`SET search_path TO ${schema},public`);const dir=path.join(__dirname,'..','database/migrations');for(const file of fs.readdirSync(dir).filter(f=>f.endsWith('.sql')&&f<'016').sort())await client.query(fs.readFileSync(path.join(dir,file),'utf8'));
    const person=uid(),property=uid(),contract=uid(),installment=uid();await client.query("INSERT INTO persons(id,full_name) VALUES($1,'Histórico mora')",[person]);await client.query("INSERT INTO properties(id,code,address,normalized_address,property_type) VALUES($1,'HIST','Histórico','historico','Departamento')",[property]);await client.query("INSERT INTO contracts(id,code,property_id,tenant_id,rental_type,duration_months,start_date,end_date,initial_amount) VALUES($1,'HIST',$2,$3,'Residencial',12,'2025-01-01','2025-12-31',100000)",[contract,property,person]);await client.query("INSERT INTO installments(id,contract_id,period,due_date,expected_amount,late_fee_amount,manual_partial_amount,status) VALUES($1,$2,'2025-09','2025-09-22',100000,1200,10000,'Pagado')",[installment,contract]);await client.query("INSERT INTO payments(id,installment_id,amount,paid_at) VALUES($1,$2,110000,'2025-09-23')",[uid(),installment]);
    const before=(await client.query('SELECT * FROM installments')).rows[0],payments=(await client.query('SELECT * FROM payments')).rows;
    await client.query(fs.readFileSync(path.join(dir,'016_late_fees_financial_integrity.sql'),'utf8'));const after=(await client.query('SELECT * FROM installments')).rows[0],{late_fee_calculated_amount,late_fee_forgiven_amount,late_fee_calculation_json,late_fee_calculation_hash,...original}=after;
    assert.deepEqual(original,before);assert.equal(late_fee_calculated_amount,null);assert.equal(late_fee_forgiven_amount,'0.00');assert.equal(late_fee_calculation_json,null);assert.equal(late_fee_calculation_hash,null);assert.deepEqual((await client.query('SELECT * FROM payments')).rows,payments);assert.equal(require('../backend/src/lib/money').balance(after,120000),'-18800.00');assert.equal((await client.query('SELECT COUNT(*) n FROM late_fee_history')).rows[0].n,'0');
  }finally{await client.query('SET search_path TO public');await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);client.release();await db.end();}
});
test('M25. dos pagos normales simultáneos con claves diferentes no crean crédito accidental',async t=>{
  const s=await setup(t),responses=await Promise.all([1,2].map(()=>s.call(`payments/${s.installment}/register`,{amount:'100000',request_id:uid()})));assert.deepEqual(responses.map(r=>r.status).sort(),[201,400]);assert.equal((await s.snapshot()).payments.length,1);
});
