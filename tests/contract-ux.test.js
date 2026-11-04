require('./require-isolated');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createApp}=require('../backend/src/app');
const {uid}=require('../backend/src/database');
const {importPdf,completeImportReview}=require('../backend/src/modules/imports/contract-parser');
const {pdf,review}=require('./support/p0-fixtures');
let catalog;
test.before(async()=>{catalog=await import('../frontend/src/utils/contract-options.mjs');});

test('UX: catálogo legible y correspondencia interna de los seis mecanismos',()=>{
  assert.deepEqual(catalog.UPDATE_OPTIONS.map(([,label])=>label),['Por IPC (INDEC)','Por ICL','Por índice CAC','Por porcentaje fijo','Según acuerdo de las partes','Otro mecanismo contractual']);
  for(const [method] of catalog.UPDATE_OPTIONS){const terms=catalog.selectUpdateMethod(method);assert.equal(catalog.updateMethod(terms),method);}
  assert.deepEqual(catalog.selectUpdateMethod('IPC'),{adjustment_type:'IPC',adjustment_index:'IPC'});
  assert.deepEqual(catalog.selectUpdateMethod('CAC'),{adjustment_type:'CUSTOM_INDEX',adjustment_index:'CAC'});
  assert.deepEqual(catalog.selectUpdateMethod('FIXED_PERCENTAGE'),{adjustment_type:'FIXED_PERCENTAGE',adjustment_index:null});
  assert.equal(catalog.updateMethod({adjustment_type:null,adjustment_index:'IPC'}),'IPC');
  assert.equal(catalog.updateMethod({adjustment_type:'MANUAL',adjustment_index:'Acuerdo de partes'}),'MANUAL');
  assert.equal(catalog.updateMethod({adjustment_type:'FIXED_PERCENTAGE',adjustment_index:'IPC'}),'');
  assert.throws(()=>catalog.validateUpdateTerms({adjustment_type:'FIXED_PERCENTAGE',adjustment_index:'IPC',adjustment_value_pct:10}),/coherente/);
});

test('UX: opciones de demora y frecuencia no exponen constantes; el próximo ajuste solo usa condiciones fiables',()=>{
  assert.deepEqual(catalog.LATE_FEE_OPTIONS.map(([value])=>value),['NONE','FIXED_DAILY','BANK_ACTIVE_RATE']);
  assert.ok(catalog.LATE_FEE_OPTIONS.every(([value,label])=>value!==label));
  assert.equal(catalog.nextAdjustmentPeriod({start_date:'2026-01-01',end_date:'2026-12-31',adjustment_frequency_months:3},'2026-01'),'2026-04');
  assert.equal(catalog.nextAdjustmentPeriod({start_date:'2026-01-01',end_date:'2026-12-31',adjustment_frequency_months:3},'2026-12'),null);
  assert.equal(catalog.nextAdjustmentPeriod({start_date:'incorrecto',adjustment_frequency_months:3},'2026-01'),null);
});

async function setup(t){
  const app=await createApp(),db=app.db;
  await db.query('TRUNCATE persons,properties,contracts,installments,payments,documents,imports,import_exclusions,audit_log,rent_adjustment_history RESTART IDENTITY CASCADE');
  const directory=process.env.FERRARO_TEST_IMPORT_DIRECTORY;await db.query("UPDATE settings SET value=$1 WHERE key='import_directory'",[directory]);
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}/api/`;
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));await db.end();});
  const call=async(route,body,method='POST')=>{const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};};
  return{db,directory,call};
}

test('UX: revisión permite quitar IPC explícitamente y conserva porcentaje, condiciones y días distintos',async t=>{
  const {db,directory}=await setup(t),file=path.join(directory,'formulario-fijo.pdf');fs.writeFileSync(file,pdf());
  const draft=await importPdf(db,file);
  await db.query("UPDATE imports SET result_json=jsonb_set(result_json,'{parsed,adjustmentIndex}','\"IPC\"') WHERE id=$1",[draft.id]);
  const done=await completeImportReview(db,draft.id,{...review,adjustment_type:'FIXED_PERCENTAGE',adjustment_index:null,adjustment_value_pct:'12.500',payment_period_start_day:5,payment_period_end_day:12,payment_due_day:10,notes:'Aumento fijo según contrato.'});
  const contract=(await db.query('SELECT * FROM contracts WHERE id=$1',[done.contractId])).rows[0];
  assert.equal(contract.adjustment_type,'FIXED_PERCENTAGE');assert.equal(contract.adjustment_index,null);assert.equal(contract.adjustment_value_pct,'12.500');
  assert.equal(contract.payment_period_start_day,5);assert.equal(contract.payment_period_end_day,12);assert.equal(contract.payment_due_day,10);assert.equal(contract.notes,'Aumento fijo según contrato.');
  assert.ok((await db.query('SELECT * FROM installments WHERE contract_id=$1',[done.contractId])).rows.every(row=>row.expected_amount==='500000.00'&&!row.ipc_managed));
});

test('UX: creación y edición conservan los campos contractuales sin cambiar cuotas ni pagos por metadatos',async t=>{
  const {db,call}=await setup(t),property=uid(),tenant=uid();
  await db.query("INSERT INTO persons(id,full_name) VALUES($1,'Persona ficticia UX')",[tenant]);
  await db.query("INSERT INTO properties(id,code,address,normalized_address,property_type) VALUES($1,'UX-FORM','Prueba UI 5','prueba ui 5','Departamento')",[property]);
  const created=await call('contracts',{code:'UX-FIJO',property_id:property,tenant_id:tenant,rental_type:'Residencial',duration_months:6,start_date:'2026-01-01',initial_amount:500000,currency:'ARS',management_fee_pct:3,adjustment_frequency_months:4,adjustment_type:'FIXED_PERCENTAGE',adjustment_index:null,adjustment_value_pct:0,payment_period_start_day:5,payment_period_end_day:12,payment_due_day:10,notes:'Condición manual conservada.'});
  assert.equal(created.status,201,JSON.stringify(created.body));const id=created.body.id;
  const before=(await db.query('SELECT * FROM installments WHERE contract_id=$1 ORDER BY id',[id])).rows;
  const edited=await call(`contracts/${id}`,{alias:'Dato administrativo',administrative_note:'Revisado por administración',adjustment_type:'FIXED_PERCENTAGE',adjustment_value_pct:0,payment_period_start_day:5,payment_period_end_day:12,payment_due_day:10,notes:'Condición manual conservada.'},'PATCH');
  assert.equal(edited.status,200,JSON.stringify(edited.body));
  const c=(await db.query('SELECT * FROM contracts WHERE id=$1',[id])).rows[0];assert.equal(c.adjustment_type,'FIXED_PERCENTAGE');assert.equal(c.adjustment_value_pct,'0.000');assert.equal(c.payment_due_day,10);
  assert.deepEqual((await db.query('SELECT * FROM installments WHERE contract_id=$1 ORDER BY id',[id])).rows,before);
  const read=await call('pending-collections',undefined,'GET');assert.equal(read.status,200);assert.equal(read.body[0].adjustment_type,'FIXED_PERCENTAGE');assert.equal(read.body[0].notes,'Condición manual conservada.');
  const history=await call(`contracts/${id}/adjustments`,undefined,'GET');assert.equal(history.status,200);assert.equal((await db.query('SELECT COUNT(*) n FROM payments')).rows[0].n,'0');
});
