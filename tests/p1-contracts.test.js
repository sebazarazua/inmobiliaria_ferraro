require('./require-isolated');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createApp}=require('../backend/src/app'),{uid}=require('../backend/src/database');
const {pdf}=require('./support/p0-fixtures');
const QUOTE='Contrato original. Actualizacion por IPC cada tres meses. Canon inicial 500000 pesos.';
async function setup(t){
  const app=await createApp(),db=app.db;await db.query('TRUNCATE persons,properties,contracts,installments,payments,documents,imports,import_exclusions,audit_log,rent_adjustment_history RESTART IDENTITY CASCADE');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ferraro-p1-'));await db.query("UPDATE settings SET value=$1 WHERE key='import_directory'",[directory]);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await db.query("UPDATE settings SET value=$1 WHERE key='import_directory'",[process.env.FERRARO_TEST_IMPORT_DIRECTORY]);await new Promise(r=>app.server.close(r));await db.end();fs.rmSync(directory,{recursive:true,force:true});});
  const call=async(route,input,method='POST')=>{const res=await fetch(`http://127.0.0.1:${app.server.address().port}/api/${route}`,{method,headers:{'Content-Type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})});return{status:res.status,body:await res.json()};};
  const tenant=uid(),property=uid();await db.query("INSERT INTO persons(id,full_name) VALUES($1,'Persona de prueba P1')",[tenant]);await db.query("INSERT INTO properties(id,code,address,normalized_address,property_type) VALUES($1,'P1','Prueba P1','prueba p1','Departamento')",[property]);
  const c=await call('contracts',{code:'P1-CONTRATO',property_id:property,tenant_id:tenant,rental_type:'Residencial',duration_months:12,start_date:'2026-01-01',initial_amount:500000,currency:'ARS',management_fee_pct:3,adjustment_type:'IPC',adjustment_index:'IPC',adjustment_frequency_months:4,ipc_lag_months:0,payment_due_day:10});assert.equal(c.status,201,JSON.stringify(c.body));const id=c.body.id;
  const file=path.join(directory,'original.pdf'),bytes=pdf(QUOTE),document=uid();fs.writeFileSync(file,bytes);
  await db.query('INSERT INTO documents(id,filename,absolute_path,sha256,contract_id,property_id) VALUES($1,$2,$3,$4,$5,$6)',[document,'original.pdf',file,crypto.createHash('sha256').update(bytes).digest('hex'),id,property]);await db.query('UPDATE contracts SET source_document_id=$1 WHERE id=$2',[document,id]);
  const input={operation:'original_document_correction',document_id:document,reason:'Error al leer la frecuencia del PDF original',document_reference:'Cláusula de actualización, página 1',document_quote:QUOTE,changes:{adjustment_frequency_months:3}};
  const snapshot=async()=>({contract:(await db.query('SELECT * FROM contracts WHERE id=$1',[id])).rows[0],installments:(await db.query('SELECT * FROM installments WHERE contract_id=$1 ORDER BY id',[id])).rows,payments:(await db.query('SELECT * FROM payments ORDER BY id')).rows,ledger:(await db.query('SELECT * FROM ledger_entries ORDER BY id')).rows,history:(await db.query('SELECT * FROM rent_adjustment_history ORDER BY id')).rows});
  return{app,db,call,id,document,file,input,snapshot};
}

test('P1. edición normal y PUT no permiten cambios legales, aunque se envíen confirmaciones y tokens',async t=>{
  const {call,snapshot,id}=await setup(t),before=await snapshot();
  const attempts=[{adjustment_type:'MANUAL',adjustment_index:null},{adjustment_frequency_months:3},{initial_amount:600000},{currency:'USD'},{ipc_lag_months:2},{start_date:'2026-02-01'},{end_date:'2027-12-31'},{duration_months:24},{payment_due_day:15},{payment_period_start_day:2},{late_fee_json:{type:'FIXED_DAILY',dailyPercentage:1}},{deposit_amount:10000},{management_fee_pct:5},{rental_type:'Comercial'},{notes:'Nueva cláusula'},{cbu:'1111111111111111111111'},{source_document_id:uid()},{property_id:uid()}];
  for(const changes of attempts){const res=await call(`contracts/${id}`,{alias:'Intento',...changes,confirmed:true,confirm:true,interpretation_confirmed:true,reconciliation_token:'inventado'},'PATCH');assert.equal(res.status,400,JSON.stringify(changes));assert.deepEqual(await snapshot(),before);}
  assert.ok((await call(`contracts/${id}`,{initial_amount:600000},'PUT')).status>=400);
});

test('P1. formatos equivalentes y datos administrativos conservan los originales, cuotas y pagos',async t=>{
  const {db,call,snapshot,id}=await setup(t);await db.query("UPDATE contracts SET adjustment_type=NULL,payment_period_start_day=NULL WHERE id=$1",[id]);
  const before=await snapshot();const response=await call(`contracts/${id}`,{created_at:before.contract.created_at.toISOString(),updated_at:before.contract.updated_at.toISOString(),rescission_penalty:Number(before.contract.rescission_penalty),deposit_returned_amount:Number(before.contract.deposit_returned_amount),alias:'Uso administrativo',administrative_note:'Revisar contacto del propietario',initial_amount:'500000.000',start_date:'2026-01-01T00:00:00.000Z',adjustment_frequency_months:'4',ipc_lag_months:'1',adjustment_type:'',payment_period_start_day:'',management_fee_pct:'3.000'},'PATCH');assert.equal(response.status,200,JSON.stringify(response.body));
  const after=await snapshot();assert.equal(after.contract.initial_amount,before.contract.initial_amount);assert.equal(after.contract.ipc_lag_months,0);assert.equal(after.contract.adjustment_type,null);assert.deepEqual(after.installments,before.installments);assert.deepEqual(after.history,before.history);
  const info=await call(`contracts/${id}/protection`,undefined,'GET');assert.equal(info.body.administrative_note,'Revisar contacto del propietario');assert.equal(info.body.document.id,before.contract.source_document_id);
});

test('P1. rectificación documentada simula sin cambios, exige token propio y conserva pagos y movimientos al aplicar',async t=>{
  const {db,call,snapshot,id,input}=await setup(t);const april=(await db.query("SELECT id FROM installments WHERE contract_id=$1 AND period='2026-04'",[id])).rows[0].id;
  await call(`payments/${april}/register`,{amount:500000,paid_at:'2026-04-10'});
  await db.query("INSERT INTO ledger_entries(id,entry_date,kind,category,description,amount,currency,contract_id) VALUES($1,'2026-04-10','Ingreso','General','Movimiento anterior',100,'ARS',$2)",[uid(),id]);
  const before=await snapshot(),preview=await call(`contracts/${id}/rectification/simulate`,input);assert.equal(preview.status,200,JSON.stringify(preview.body));assert.equal(preview.body.blocked.length,0);assert.ok(preview.body.changed>0);assert.deepEqual(await snapshot(),before);
  const noToken=await call(`contracts/${id}/rectification/apply`,{...input,confirm:true});assert.equal(noToken.status,400);assert.deepEqual(await snapshot(),before);
  const normal=await call(`contracts/${id}`,{...input.changes,reconciliation_token:preview.body.token,confirm:true},'PATCH');assert.equal(normal.status,400);
  const result=await call(`contracts/${id}/rectification/apply`,{...input,token:preview.body.token,confirm:true});assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.version,1);
  const after=await snapshot();assert.equal(after.contract.adjustment_frequency_months,3);assert.deepEqual(after.payments,before.payments);assert.deepEqual(after.ledger,before.ledger);
  const changed=after.installments.find(r=>r.id===april);assert.equal(changed.expected_amount,'547211.45');assert.equal(changed.status,'Parcial');
  const log=(await db.query("SELECT * FROM audit_log WHERE entity_id=$1 AND action='contract_rectified'",[id])).rows[0];assert.equal(log.details_json.before.adjustment_frequency_months,4);assert.equal(log.details_json.changes.adjustment_frequency_months,3);assert.equal(log.details_json.actor.id,'local-operator');assert.equal(log.details_json.evidence.reference,input.document_reference);assert.ok(log.created_at);
  const replay=await call(`contracts/${id}/rectification/apply`,{...input,token:preview.body.token,confirm:true});assert.equal(replay.status,400);assert.deepEqual(await snapshot(),after);
});

test('P1. sin documento original, fragmento verificable o propósito de corrección se bloquea la rectificación',async t=>{
  const {db,call,snapshot,id,input}=await setup(t),before=await snapshot();
  for(const change of [{reason:''},{document_id:uid()},{document_reference:''},{document_quote:'Un texto inventado que no consta en el PDF original.'},{operation:'adenda'},{operation:'new_contract'}]){
    const response=await call(`contracts/${id}/rectification/simulate`,{...input,...change});assert.equal(response.status,400,JSON.stringify(change));assert.deepEqual(await snapshot(),before);
  }
  await db.query('UPDATE contracts SET source_document_id=NULL WHERE id=$1',[id]);assert.equal((await call(`contracts/${id}/rectification/simulate`,input)).status,400);
});

test('P1. un PDF cambiado o un adjunto posterior no puede autorizar una condición nueva',async t=>{
  const {db,call,snapshot,id,input,file}=await setup(t);const attached=uid();await db.query('INSERT INTO documents(id,filename,absolute_path,sha256,contract_id) VALUES($1,$2,$3,$4,$5)',[attached,'adenda.pdf',path.join(path.dirname(file),'adenda.pdf'),'b'.repeat(64),id]);
  const before=await snapshot();assert.equal((await call(`contracts/${id}/rectification/simulate`,{...input,document_id:attached})).status,400);
  fs.writeFileSync(file,pdf('Documento distinto al original con otras condiciones.'));assert.equal((await call(`contracts/${id}/rectification/simulate`,input)).status,400);assert.deepEqual(await snapshot(),before);
});

test('P1. simulaciones bloqueadas por cronograma, mecanismo o moneda no alteran el contrato ni cuotas',async t=>{
  const {call,snapshot,id,input}=await setup(t),before=await snapshot();
  for(const changes of [{adjustment_type:'MANUAL',adjustment_index:null},{currency:'USD'},{payment_due_day:15},{duration_months:24},{end_date:'2026-06-30'}]){
    const preview=await call(`contracts/${id}/rectification/simulate`,{...input,changes});assert.equal(preview.status,200,JSON.stringify(preview.body));assert.ok(preview.body.blocked.length);
    const applied=await call(`contracts/${id}/rectification/apply`,{...input,changes,confirm:true,token:preview.body.token});assert.equal(applied.status,400);assert.deepEqual(await snapshot(),before);
  }
});

test('P1. un pago nuevo, motivo cambiado o propuesta distinta invalidan la simulación',async t=>{
  const {call,snapshot,id,input}=await setup(t),preview=await call(`contracts/${id}/rectification/simulate`,input);
  assert.equal(preview.status,200);for(const patch of [{reason:'Otro motivo diferente'},{changes:{initial_amount:600000}},{token:preview.body.token+'x'}])assert.equal((await call(`contracts/${id}/rectification/apply`,{...input,confirm:true,token:preview.body.token,...patch})).status,400);
  const before=await snapshot();await call(`payments/${before.installments[0].id}/register`,{amount:1000});const paid=await snapshot();
  assert.equal((await call(`contracts/${id}/rectification/apply`,{...input,confirm:true,token:preview.body.token})).status,400);assert.deepEqual(await snapshot(),paid);
});

test('P1. filtro y agrupación usan el período, ordenan vencimientos y separan saldos por moneda',async()=>{
  const {filterByPeriod,groupByPeriod,totalsByCurrency,formatPeriod}=await import('../frontend/src/utils/periods.mjs');
  const rows=[{id:'b',period:'2027-01',due_date:'2026-12-01',currency:'ARS',due_amount:10.01},{id:'a',period:'2026-12',due_date:'2027-01-01',currency:'USD',due_amount:100},{id:'c',period:'2026-12',due_date:'2026-11-30',currency:'ARS',due_amount:250.20},{id:'d',period:'2026-12',due_date:'2026-12-10',currency:'ARS',due_amount:99.80},{id:'e',period:'2027-01',due_date:'2027-01-10',currency:'ARS',due_amount:0}];
  const original=structuredClone(rows),groups=groupByPeriod(rows);assert.deepEqual(groups.map(g=>g.period),['2026-12','2027-01']);assert.deepEqual(groups[0].rows.map(r=>r.id),['c','d','a']);assert.deepEqual(groups[0].totals,[{currency:'ARS',amount:'350.00'},{currency:'USD',amount:'100.00'}]);assert.equal(groups[1].totals[0].amount,'10.01');assert.equal(new Set(groups.flatMap(g=>g.rows).map(r=>r.id)).size,rows.length);assert.deepEqual(rows,original);
  assert.deepEqual(filterByPeriod(rows,'2026-12').map(r=>r.id),['a','c','d']);assert.equal(filterByPeriod(rows,'').length,5);assert.equal(formatPeriod('2027-01'),'Enero de 2027');assert.deepEqual(totalsByCurrency([{currency:'ARS',due_amount:0.1},{currency:'ARS',due_amount:0.2}]),[{currency:'ARS',amount:'0.30'}]);
  assert.equal(groupByPeriod([{id:'unknown',period:null,due_amount:5}])[0].rows[0].id,'unknown');
});

test('P1. dos confirmaciones simultáneas producen una sola versión de rectificación',async t=>{
  const {db,call,id,input}=await setup(t),preview=await call(`contracts/${id}/rectification/simulate`,input);
  const results=await Promise.all([1,2].map(()=>call(`contracts/${id}/rectification/apply`,{...input,confirm:true,token:preview.body.token})));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,400]);assert.equal((await db.query("SELECT COUNT(*) n FROM audit_log WHERE action='contract_rectified' AND entity_id=$1",[id])).rows[0].n,'1');
});

test('P1. una renovación conserva las condiciones legales del contrato original',async t=>{
  const {db,call,snapshot,id,file}=await setup(t),before=(await snapshot()).contract;
  const created=await call('contracts',{code:'P1-RENOVADO',property_id:before.property_id,tenant_id:before.tenant_id,rental_type:'Residencial',duration_months:12,start_date:'2027-01-01',initial_amount:700000,currency:'ARS',management_fee_pct:3,adjustment_type:'IPC',adjustment_index:'IPC',adjustment_frequency_months:3,ipc_lag_months:1,payment_due_day:10});assert.equal(created.status,201);
  const next=created.body.id,document=uid(),filename=path.join(path.dirname(file),'renovacion.pdf'),bytes=pdf('Nuevo contrato independiente con su propio documento.');fs.writeFileSync(filename,bytes);
  await db.query('INSERT INTO documents(id,filename,absolute_path,sha256,contract_id) VALUES($1,$2,$3,$4,$5)',[document,'renovacion.pdf',filename,crypto.createHash('sha256').update(bytes).digest('hex'),next]);await db.query('UPDATE contracts SET source_document_id=$1 WHERE id=$2',[document,next]);
  assert.equal((await call(`contracts/${id}/renew`,{new_contract_id:next})).status,201);
  const after=(await snapshot()).contract;for(const field of require('../backend/src/modules/contracts/protection').PROTECTED_FIELDS)assert.deepEqual(after[field],before[field],field);
});

test('P1. adjuntar un PDF no permite reasignar evidencia original de otro contrato',async t=>{
  const {app,db,call,snapshot,id,file}=await setup(t),original=(await snapshot()).contract;
  const other=await call('contracts',{code:'OTRO-P1',property_id:original.property_id,tenant_id:original.tenant_id,rental_type:'Residencial',duration_months:12,start_date:'2027-01-01',initial_amount:1000,management_fee_pct:3});assert.equal(other.status,201);
  const form=new FormData();form.append('file',new Blob([fs.readFileSync(file)],{type:'application/pdf'}),'mismo-original.pdf');
  const response=await fetch(`http://127.0.0.1:${app.server.address().port}/api/contracts/${other.body.id}/upload-file`,{method:'POST',body:form});assert.equal(response.status,400);
  assert.equal((await db.query('SELECT contract_id FROM documents WHERE id=$1',[original.source_document_id])).rows[0].contract_id,id);
});

test('P1. una cita existente no respalda valores económicos distintos de los que indica',async t=>{
  const {call,snapshot,id,input}=await setup(t),before=await snapshot();
  for(const changes of [{adjustment_frequency_months:12},{initial_amount:600000},{ipc_lag_months:2},{ipc_clause_text:'Nueva condición que no pertenece al documento'}])assert.equal((await call(`contracts/${id}/rectification/simulate`,{...input,changes})).status,400);
  assert.deepEqual(await snapshot(),before);
});

test('P1. evidencia explícita de canon, IPC trimestral y dos meses de rezago permite simular la corrección',async t=>{
  const {db,call,snapshot,id,input,file,document}=await setup(t);
  const quote='Contrato original. Actualizacion IPC trimestral con dos meses de rezago. Canon inicial $600.000,00.';
  const bytes=pdf(quote);fs.writeFileSync(file,bytes);await db.query('UPDATE documents SET sha256=$1 WHERE id=$2',[crypto.createHash('sha256').update(bytes).digest('hex'),document]);
  const before=await snapshot(),result=await call(`contracts/${id}/rectification/simulate`,{...input,document_quote:quote,changes:{initial_amount:600000,adjustment_frequency_months:3,ipc_lag_months:2}});
  assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.blocked.length,0);assert.equal(result.body.comparison.length,3);assert.deepEqual(await snapshot(),before);
});
