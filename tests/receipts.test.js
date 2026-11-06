require('./require-isolated');
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {PDFDocument}=require('pdf-lib');
const {createApp}=require('../backend/src/app');
const {uid}=require('../backend/src/database');

async function fixture(t,currency='ARS'){
  let app=await createApp(),db=app.db;
  await db.query('TRUNCATE persons,properties,contracts,installments,payments,documents,imports,audit_log,payment_requests RESTART IDENTITY CASCADE');
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>app.server.close(r));await db.end();});
  let root=`http://127.0.0.1:${app.server.address().port}/api/`;
  const request=async(route,input,method=input===undefined?'GET':'POST')=>{const r=await fetch(root+route,{method,headers:{'Content-Type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})});return{status:r.status,body:await r.json()};};
  const restart=async()=>{await new Promise(r=>app.server.close(r));await db.end();app=await createApp();db=app.db;await new Promise(r=>app.server.listen(0,'127.0.0.1',r));root=`http://127.0.0.1:${app.server.address().port}/api/`;};
  const person=uid(),property=uid();await db.query("INSERT INTO persons(id,full_name) VALUES($1,'Inquilino Recibo Prueba')",[person]);
  await db.query("INSERT INTO properties(id,code,address,normalized_address,property_type) VALUES($1,'RECIBO-TEST','Calle Recibo 100','calle recibo 100','Departamento')",[property]);
  const created=await request('contracts',{code:'RECIBO-TEST',property_id:property,tenant_id:person,rental_type:'Residencial',duration_months:12,start_date:'2026-01-01',initial_amount:currency==='ARS'?100000:1000,currency,management_fee_pct:3,payment_due_day:10});
  assert.equal(created.status,201,JSON.stringify(created.body));
  const installment=(await db.query('SELECT id FROM installments WHERE contract_id=$1 ORDER BY period LIMIT 1',[created.body.id])).rows[0].id;
  return{db,request,get root(){return root;},restart,contract:created.body.id,installment};
}

test('R01. pago parcial genera un PDF fijo, único y recuperable sin pagos nuevos',async t=>{
  const {db,request,root,installment}=await fixture(t),key=uid();
  const first=await request(`payments/${installment}/register`,{amount:'30000.25',request_id:key,paid_at:'2026-01-08',method:'Efectivo',reference:'MOV-TEST'});
  assert.equal(first.status,201,JSON.stringify(first.body));const id=first.body.receipt.id;
  const receipt=await request(`receipts/${id}`);assert.equal(receipt.body.snapshot_json.amount,'30000.25');assert.equal(receipt.body.snapshot_json.due,'69999.75');
  assert.equal(receipt.body.snapshot_json.method,'Efectivo');assert.equal(receipt.body.snapshot_json.reference,'MOV-TEST');
  const firstPdf=await fetch(`${root}receipts/${id}/pdf`),bytes=Buffer.from(await firstPdf.arrayBuffer());
  assert.equal(firstPdf.status,200);assert.match(firstPdf.headers.get('content-type'),/application\/pdf/);assert.equal(bytes.subarray(0,5).toString(),'%PDF-');
  assert.equal((await PDFDocument.load(bytes)).getPageCount(),1);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),receipt.body.pdf_sha256);
  const downloaded=Buffer.from(await(await fetch(`${root}receipts/${id}/pdf?download=1`)).arrayBuffer());assert.deepEqual(downloaded,bytes);
  const replay=await request(`payments/${installment}/register`,{amount:'30000.25',request_id:key,paid_at:'2026-01-08',method:'Efectivo',reference:'MOV-TEST'});
  assert.equal(replay.body.replayed,true);assert.equal(replay.body.receipt.id,id);
  assert.equal((await db.query('SELECT COUNT(*)::int n FROM payments')).rows[0].n,1);
  assert.equal((await db.query('SELECT COUNT(*)::int n FROM payment_receipts')).rows[0].n,1);
  assert.equal((await request('collections')).body[0].receipt_id,id);
  await assert.rejects(db.query('UPDATE payments SET amount=1 WHERE id=$1',[first.body.payment_id]),/recibo emitido/);
});

test('R02. cargos, descuento, moneda y crédito quedan congelados en el recibo',async t=>{
  const {db,request,installment}=await fixture(t,'USD');
  await db.query('UPDATE installments SET vat_amount=50,late_fee_amount=20,discount_amount=10 WHERE id=$1',[installment]);
  await db.query(`INSERT INTO installment_services(id,installment_id,category,description,original_amount,forgiven_amount,currency,status,responsibility_reference)
    VALUES($1,$2,'Agua','Agua de enero',100,20,'USD','Confirmado','Cláusula de servicios')`,[uid(),installment]);
  const result=await request(`payments/${installment}/register`,{amount:'400.00',request_id:uid()});assert.equal(result.status,201,JSON.stringify(result.body));
  const id=result.body.receipt.id,before=(await request(`receipts/${id}`)).body;
  assert.equal(before.snapshot_json.currency,'USD');assert.equal(before.snapshot_json.components.services,'80.00');
  assert.equal(before.snapshot_json.components.late_fee,'20.00');assert.equal(before.snapshot_json.components.discount,'10.00');
  await db.query('UPDATE installments SET discount_amount=20 WHERE id=$1',[installment]);
  const after=(await request(`receipts/${id}`)).body;assert.deepEqual(after.snapshot_json,before.snapshot_json);assert.equal(after.pdf_sha256,before.pdf_sha256);
});

test('R03. emisión histórica idempotente, anulación documental y trazabilidad',async t=>{
  const {db,request,installment}=await fixture(t),payment=uid();
  await db.query("INSERT INTO payments(id,installment_id,amount,paid_at) VALUES($1,$2,1000,'2026-01-08')",[payment,installment]);
  const a=await request(`receipts/payment/${payment}`,{}),b=await request(`receipts/payment/${payment}`,{});
  assert.equal(a.status,201);assert.equal(b.body.id,a.body.id);assert.equal(b.body.already_issued,true);
  assert.equal((await request(`receipts/payment/${uid()}`,{})).status,400);
  const bad=await request(`receipts/${a.body.id}/void`,{reason:'no'});assert.equal(bad.status,400);
  const done=await request(`receipts/${a.body.id}/void`,{reason:'Rectificado por error administrativo'});assert.equal(done.status,200);
  assert.equal((await request(`receipts/${a.body.id}`)).body.status,'Anulado');
  assert.equal((await request(`receipts/payment/${payment}`,{})).status,400,'la emisión simple no reemplaza un documento anulado');
  const previous=(await request(`receipts/${a.body.id}`)).body;
  const correction=await request(`receipts/${a.body.id}/rectify`,{reason:'Corrección de identificación administrativa'});assert.equal(correction.status,201,JSON.stringify(correction.body));
  assert.notEqual(correction.body.id,a.body.id);assert.ok(Number(correction.body.number)>Number(a.body.number));
  assert.equal((await request(`receipts/${correction.body.id}`)).body.snapshot_json.replaces_number,String(a.body.number));
  assert.equal((await request(`receipts/${a.body.id}`)).body.pdf_sha256,previous.pdf_sha256);
  assert.equal((await request(`receipts/payment/${payment}`)).body.length,2);
  assert.equal((await request('collections')).body.length,1);
  assert.equal((await request(`receipts/${a.body.id}/rectify`,{reason:'Otra corrección'})).status,400);
  assert.equal((await db.query('SELECT amount FROM payments WHERE id=$1',[payment])).rows[0].amount,'1000.00');
  assert.equal((await db.query('SELECT COUNT(*)::int n FROM payment_receipt_events WHERE receipt_id=$1',[a.body.id])).rows[0].n,2);
  await assert.rejects(db.query('DELETE FROM payment_receipts WHERE id=$1',[a.body.id]),/inmutable/);
});

test('R04. emisión concurrente de un pago existente conserva un solo número',async t=>{
  const {db,request,installment}=await fixture(t),payment=uid();
  await db.query("INSERT INTO payments(id,installment_id,amount,paid_at) VALUES($1,$2,500,'2026-01-08')",[payment,installment]);
  const result=await Promise.all(Array.from({length:4},()=>request(`receipts/payment/${payment}`,{})));
  assert.ok(result.every(r=>r.status===201),JSON.stringify(result));assert.equal(new Set(result.map(r=>r.body.id)).size,1);
  assert.equal((await db.query('SELECT COUNT(*)::int n FROM payment_receipts')).rows[0].n,1);
  assert.equal((await db.query('SELECT COUNT(*)::int n FROM payments')).rows[0].n,1);
});

test('R05. distribución y excedente explícito emiten sólo por dinero registrado',async t=>{
  const {db,request,contract,installment}=await fixture(t);
  const distributed=await request('payments/register',{contract_id:contract,amount:'120000.25',request_id:uid()});
  assert.equal(distributed.status,201,JSON.stringify(distributed.body));assert.equal(distributed.body.receipts.length,2);
  assert.equal(new Set(distributed.body.receipts.map(r=>r.number)).size,2);
  assert.equal((await db.query('SELECT SUM(amount)::text amount FROM payments')).rows[0].amount,'120000.25');
  const second=(await db.query('SELECT id FROM installments WHERE contract_id=$1 ORDER BY period OFFSET 2 LIMIT 1',[contract])).rows[0].id;
  const proposal={amount:'100001.50',request_id:uid(),excess_reason:'Transferencia recibida como anticipo documentado'};
  const preview=await request(`payments/${second}/excess/simulate`,proposal);assert.equal(preview.status,200,JSON.stringify(preview.body));
  const credit=await request(`payments/${second}/excess/apply`,{...proposal,excess_token:preview.body.token,excess_confirm:true});
  assert.equal(credit.status,201,JSON.stringify(credit.body));
  const receipt=(await request(`receipts/${credit.body.receipt.id}`)).body;
  assert.equal(receipt.snapshot_json.amount,'100001.50');assert.equal(receipt.snapshot_json.credit,'1.50');
  assert.equal((await db.query('SELECT COUNT(*)::int n FROM payments')).rows[0].n,3);
});

test('R06. reiniciar el servidor conserva el PDF emitido y su número',async t=>{
  const state=await fixture(t),first=await state.request(`payments/${state.installment}/register`,{amount:'100000.00',request_id:uid()});
  assert.equal(first.status,201);const receipt=first.body.receipt,original=(await state.request(`receipts/${receipt.id}`)).body;
  await state.restart();const recovered=(await state.request(`receipts/${receipt.id}`)).body;
  assert.equal(recovered.number,String(receipt.number));assert.equal(recovered.pdf_sha256,original.pdf_sha256);
  assert.equal((await state.request(`receipts/payment/${first.body.payment_id}`)).body.length,1);
});
