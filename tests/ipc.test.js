require('./require-isolated');
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {types}=require('pg');
const {openDatabase,uid}=require('../backend/src/database');
const {createApp}=require('../backend/src/app');
const {periodKey,addMonths,shiftMonth,dueDate}=require('../backend/src/lib/calendar');
const {adjustedMoney}=require('../backend/src/lib/money');
const {calculateIpcAmount}=require('../backend/src/modules/ipc');
const {parseIndecCsv,parseMacroCsv,validateSeries,INDEC_CSV_URL}=require('../backend/src/modules/ipc/source');
const {refreshOfficialIndices,loadStoredSeries,latestIpcSummary}=require('../backend/src/modules/ipc/store');
const {reconcileInstallments,refreshAndUpdate}=require('../backend/src/modules/rent');
const {buildRentPreview,extractIpcClause,completeImportReview}=require('../backend/src/modules/imports/contract-parser');
const fixture=fs.readFileSync(path.join(__dirname,'fixtures','ipc-national-official.csv'),'utf8');
const nativeFetch=global.fetch;
let db,app,base;
const csvFetch=text=>async()=>({ok:true,text:async()=>text});
const officialSeries=()=>({series:new Map(parseIndecCsv(fixture).map(r=>[r.period,r])),latestPeriod:'2026-09'});
function subset(last){return fixture.split('\n').filter((line,i)=>i===0||!line||line.split(';')[3]<=last.replace('-','')).join('\n');}
function syntheticCsv(months=40){let value=100;return 'Codigo;Region;Periodo;Indice_IPC\n'+Array.from({length:months},(_,i)=>{
  const p=shiftMonth('2023-12',i);if(i)value*=1.02;return `0;Nacional;${p.replace('-','')};${value.toFixed(10)}`;
}).join('\n');}
async function seed(text=fixture,now=new Date('2026-11-03T12:00:00Z')){return refreshOfficialIndices(db,{force:true,fetchImpl:csvFetch(text),now});}
async function request(route,body,method=body===undefined?'GET':'POST'){
  const response=await nativeFetch(`${base}/api/${route}`,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const result=await response.json();return {status:response.status,result};
}
async function create(overrides={}){
  const tenant=uid(),property=uid();
  await db.query('INSERT INTO persons(id,full_name) VALUES($1,$2)',[tenant,'Prueba IPC']);
  await db.query("INSERT INTO properties(id,code,address,normalized_address,property_type,status) VALUES($1,$2,$3,$3,'Departamento','Alquilada')",[property,uid(),'Prueba '+uid()]);
  const input={code:uid(),property_id:property,tenant_id:tenant,rental_type:'Residencial',duration_months:24,start_date:'2026-01-01',initial_amount:500000,currency:'ARS',adjustment_index:'IPC',adjustment_frequency_months:3,ipc_lag_months:0,payment_due_day:10,management_fee_pct:3,...overrides};
  const {status,result}=await request('contracts',input);assert.equal(status,201,JSON.stringify(result));return result.id;
}
const installments=async id=>(await db.query('SELECT * FROM installments WHERE contract_id=$1 ORDER BY period',[id])).rows;
test.before(async()=>{db=await openDatabase();app=await createApp({db});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${app.server.address().port}`;});
test.after(async()=>{global.fetch=nativeFetch;await new Promise(r=>app.server.close(r));await db.end();});
test.beforeEach(async()=>{
  global.fetch=nativeFetch;
  await db.query('TRUNCATE persons,properties,contracts,installments,payments,documents,imports,audit_log,rent_adjustment_history,ipc_indices,ipc_index_versions RESTART IDENTITY CASCADE');
  await db.query('UPDATE ipc_refresh_state SET last_attempt_at=NULL,last_success_at=NULL,last_error=NULL,latest_period=NULL,source_url=NULL');
});

test('normaliza Date de pg, Date ISO y períodos; rechaza fechas inválidas',()=>{
  assert.equal(periodKey(types.getTypeParser(1082,'text')('2026-01-01')),'2026-01');
  assert.equal(periodKey(new Date('2026-01-01T00:00:00Z')),'2026-01');
  assert.equal(periodKey('2026-01-31'),'2026-01');
  assert.throws(()=>periodKey('2026-13'));assert.throws(()=>periodKey('2026-02-31'));
  const c={start_date:'2026-01-01',initial_amount:500000,adjustment_index:'IPC',adjustment_frequency_months:3};
  assert.equal(calculateIpcAmount(c,'2026-04',officialSeries()).amount,547211.45);
  assert.deepEqual(calculateIpcAmount({...c,start_date:types.getTypeParser(1082,'text')(c.start_date)},'2026-04',officialSeries()),calculateIpcAmount(c,'2026-04',officialSeries()));
});
test('redondeo decimal y fin de mes sin desbordamiento',()=>{
  assert.equal(adjustedMoney('1.005','1','1'),'1.01');
  assert.equal(adjustedMoney('100.01','100','150'),'150.02');
  assert.equal(addMonths('2026-01-31',1),'2026-02-28');
  assert.equal(addMonths('2024-01-31',1),'2024-02-29');
  assert.equal(dueDate('2026-02',31),'2026-02-28');
});
test('fuentes oficiales validan valores, huecos, orden y duplicados',()=>{
  const rows=parseIndecCsv(fixture);assert.equal(rows.at(-1).period,'2026-09');assert.equal(rows.at(-1).value,'12514.1508000000');
  assert.throws(()=>validateSeries([]));
  assert.throws(()=>validateSeries([{period:'2026-01',value:null}]));
  assert.throws(()=>validateSeries([{period:'2026-01',value:'100'},{period:'2026-03',value:'110'}]));
  assert.throws(()=>validateSeries([{period:'2026-01',value:'100'},{period:'2026-01',value:'110'}]));
  assert.throws(()=>validateSeries([{period:'2026-02',value:'100'},{period:'2026-01',value:'110'}]));
  assert.throws(()=>parseIndecCsv(fixture.replace('12514,1508','NA')));
  assert.equal(parseMacroCsv('indice_tiempo,ipc_ng_nacional\n2026-01-01,100\n2026-02-01,102')[1].value,'102.0000000000');
});
test('rezago 0 y 1 equivalen; 2 desplaza base y comparación; conserva cláusula ambigua',()=>{
  const c={start_date:'2026-01-01',initial_amount:500000,adjustment_index:'IPC',adjustment_frequency_months:3};
  const a=calculateIpcAmount(c,'2026-04',officialSeries()),b=calculateIpcAmount({...c,ipc_lag_months:1},'2026-04',officialSeries()),two=calculateIpcAmount({...c,ipc_lag_months:2},'2026-04',officialSeries());
  assert.equal(a.amount,b.amount);assert.equal(two.basePeriod,'2025-11');assert.equal(two.comparisonPeriod,'2026-02');
  assert.equal(two.amount,Number(adjustedMoney('500000','9841.3581','10714.6255')));
  const clause='Se ajustará por IPC según el último índice disponible.';assert.equal(extractIpcClause(clause).ipcClauseText,clause);assert.equal(extractIpcClause(clause).ipcClauseReviewRequired,true);
  assert.equal(extractIpcClause('IPC con dos meses de rezago.').ipcClauseReviewRequired,false);
});
test('caso A persiste tramos oficiales y conserva el valor en todos sus meses',async()=>{
  await seed();const id=await create({duration_months:12}),rows=await installments(id);
  assert.deepEqual(rows.map(r=>r.expected_amount),[...Array(3).fill('500000.00'),...Array(3).fill('547211.45'),...Array(3).fill('584229.63'),...Array(3).fill('618204.30')]);
  assert.ok(rows.every(r=>!r.adjustment_pending&&r.ipc_managed));
  const pending=(await request('pending-collections')).result;assert.equal(pending.find(r=>r.period==='2026-10').expected_amount,618204.3);
  const history=(await request(`contracts/${id}/adjustments`)).result;assert.equal(history.length,12);assert.equal(history[3].details_json.calculation.steps[0].coefficient,'1.094422905038');
});
for(const duration of [6,12,18,24])for(const frequency of [3,4,6,12])test(`persistencia sintética: ${duration} meses, frecuencia ${frequency}`,async()=>{
  await seed(syntheticCsv());const id=await create({start_date:'2024-01-31',duration_months:duration,initial_amount:100000,adjustment_frequency_months:frequency,payment_due_day:31}),rows=await installments(id);
  assert.equal(rows.length,duration);assert.deepEqual(rows.map(r=>r.period),Array.from({length:duration},(_,i)=>shiftMonth('2024-01',i)));
  for(let i=0;i<duration;i++){const exponent=Math.floor(i/frequency)*frequency,expected=Math.round(100000*1.02**exponent*100)/100;assert.equal(Number(rows[i].expected_amount),expected);assert.equal(rows[i].due_date.getMonth()+1,+rows[i].period.slice(5));}
});
test('caso B importación antigua reconstruye tres aumentos y deja cuarto pendiente',async()=>{
  await seed();const importId=uid();
  await db.query('INSERT INTO imports(id,filename,absolute_path,sha256,status,result_json) VALUES($1,$2,$3,$4,$5,$6)',[importId,'antiguo.pdf',path.join(__dirname,'fixtures','antiguo.pdf'),'b'.repeat(64),'Revisión',{parsed:{warnings:[],ipcClauseText:'IPC trimestral con un mes de rezago.'},extracted_text:'IPC trimestral con un mes de rezago.'}]);
  const result=await completeImportReview(db,importId,{address:'Antiguo 123',owner_full_name:'Propietario Prueba',owner_document_number:'20111111112',tenant_full_name:'Inquilino Prueba',tenant_document_number:'30111111',start_date:'2025-11-01',duration_months:24,initial_amount:400000,currency:'ARS',adjustment_index:'IPC',adjustment_type:'IPC',adjustment_frequency_months:3,ipc_lag_months:1,payment_due_day:10,guarantee_type:'Sin garantía',guarantee_provider:'Otra'});
  const rows=await installments(result.contractId),byPeriod=Object.fromEntries(rows.map(r=>[r.period,r]));
  assert.equal(byPeriod['2026-02'].expected_amount,'433701.80');assert.equal(byPeriod['2026-05'].expected_amount,'473271.69');assert.equal(byPeriod['2026-08'].expected_amount,'502980.71');assert.equal(byPeriod['2026-11'].expected_amount,'502980.71');assert.equal(byPeriod['2026-11'].adjustment_pending,true);
  assert.match((await db.query('SELECT ipc_clause_text FROM contracts WHERE id=$1',[result.contractId])).rows[0].ipc_clause_text,/un mes/);
});
test('caso C no anticipa ajustes cuatrimestrales y la vista previa mantiene tramos',async()=>{
  await seed();const id=await create({duration_months:12,adjustment_frequency_months:4}),rows=await installments(id);
  assert.equal(rows[3].expected_amount,'500000.00');assert.equal(rows[4].expected_amount,'561341.43');assert.equal(rows[7].expected_amount,'561341.43');assert.equal(rows[8].expected_amount,'606477.39');
  const preview=buildRentPreview({startDate:'2026-01-01',durationMonths:24,initialAmount:500000,adjustmentIndex:'IPC',adjustmentFrequencyMonths:4},officialSeries());assert.equal(preview.length,24);assert.equal(preview[7].amount,561341.43);
});
test('caso D conserva último canon, publica nuevo IPC y actualiza idempotentemente',async()=>{
  await seed(subset('2026-05'));const id=await create({duration_months:12});let rows=await installments(id);
  assert.equal(rows[6].expected_amount,'547211.45');assert.equal(rows[6].adjustment_pending,true);
  const before=Number((await db.query('SELECT COUNT(*) n FROM rent_adjustment_history')).rows[0].n);
  await refreshAndUpdate(db,{force:true,fetchImpl:csvFetch(fixture),now:new Date('2026-11-04T12:00:00Z')});rows=await installments(id);
  assert.equal(rows[6].expected_amount,'584229.63');assert.equal(rows[6].adjustment_pending,false);
  const first=Number((await db.query('SELECT COUNT(*) n FROM rent_adjustment_history')).rows[0].n);assert.ok(first>before);
  const repeated=await reconcileInstallments(db,{managedOnly:true,apply:true});assert.equal(repeated.changed,0);assert.equal(Number((await db.query('SELECT COUNT(*) n FROM rent_adjustment_history')).rows[0].n),first);
});
test('caso E simula sin escrituras, aplica con token y conserva pagos originales',async()=>{
  await seed();const id=await create({duration_months:6}),rows=await installments(id),april=rows[3];
  await db.query("UPDATE installments SET expected_amount=500000,contractual_amount=NULL,original_expected_amount=NULL,calculation_hash=NULL,calculation_json='{}',ipc_managed=false,status='Pagado',adjustment_pending=false WHERE contract_id=$1",[id]);
  const paymentId=uid();await db.query('INSERT INTO payments(id,installment_id,amount,paid_at) VALUES($1,$2,500000,$3)',[paymentId,april.id,'2026-04-10']);
  const paymentBefore=(await db.query('SELECT * FROM payments WHERE id=$1',[paymentId])).rows[0];
  const before=(await installments(id)),preview=await reconcileInstallments(db,{contractId:id});assert.deepEqual(await installments(id),before);
  const diff=preview.rows.find(r=>r.id===april.id);assert.equal(diff.balance,'47211.45');assert.equal(diff.original_amount,'500000.00');assert.equal(diff.contractual_amount,'547211.45');
  await assert.rejects(()=>reconcileInstallments(db,{contractId:id,apply:true,token:'wrong',reason:'Prueba',interpretationConfirmed:true}),/simulación/);
  await reconcileInstallments(db,{contractId:id,apply:true,token:preview.token,reason:'Conciliación revisada',interpretationConfirmed:true});
  const updated=(await installments(id))[3];assert.equal(updated.expected_amount,'547211.45');assert.equal(updated.original_expected_amount,'500000.00');assert.equal(updated.status,'Parcial');
  assert.deepEqual((await db.query('SELECT * FROM payments WHERE id=$1',[paymentId])).rows[0],paymentBefore);
});
async function reviewedExcess(id,input){const body={...input,request_id:require('node:crypto').randomUUID(),excess_reason:'Excedente verificado para conservar crédito histórico'};const preview=await request(`payments/${id}/excess/simulate`,body);assert.equal(preview.status,200,JSON.stringify(preview.result));return request(`payments/${id}/excess/apply`,{...body,excess_token:preview.result.token,excess_confirm:true});}

test('transferencias parciales y sobrepagos no cierran definitivamente un ajuste pendiente',async()=>{
  await seed(subset('2026-05'));const id=await create({duration_months:12}),july=(await installments(id))[6];
  const result=await reviewedExcess(july.id,{amount:600000,paid_at:'2026-07-10'});assert.equal(result.status,201);assert.equal(result.result.status,'Parcial');assert.equal(result.result.adjustment_pending,true);
  const provisional=(await request('pending-collections')).result.find(row=>row.id===july.id);assert.equal(provisional.due_amount,0);assert.equal(provisional.adjustment_pending,true);
  const before=(await db.query('SELECT * FROM payments WHERE installment_id=$1',[july.id])).rows;
  await refreshAndUpdate(db,{force:true,fetchImpl:csvFetch(fixture),now:new Date('2026-11-04T12:00:00Z')});
  const updated=(await installments(id))[6];assert.equal(updated.status,'Pagado');assert.equal(updated.expected_amount,'584229.63');
  const preview=await reconcileInstallments(db,{contractId:id});assert.equal(preview.rows.find(r=>r.id===july.id).balance,'-15770.37');
  assert.deepEqual((await db.query('SELECT * FROM payments WHERE installment_id=$1',[july.id])).rows,before);
});
test('fallos externos conservan índices, caché persistente y evitan consultas constantes',async()=>{
  await seed();let calls=0;const failure=async()=>{calls++;throw new Error('Sin conexión');};
  const skipped=await refreshOfficialIndices(db,{fetchImpl:failure,now:new Date('2026-11-03T13:00:00Z')});assert.equal(skipped.skipped,true);assert.equal(calls,0);
  const failed=await refreshOfficialIndices(db,{force:true,fetchImpl:failure,now:new Date('2026-11-04T12:00:00Z')});assert.equal(failed.retainedStoredData,true);assert.equal(calls,2);
  assert.equal((await latestIpcSummary(db)).latestPeriod,'2026-09');
  const id=await create({duration_months:6});global.fetch=failure;assert.equal((await installments(id))[3].expected_amount,'547211.45');
  const payment=await request(`payments/${(await installments(id))[3].id}/register`,{amount:100000});assert.equal(payment.status,201);assert.equal(calls,2);
});
test('refresh concurrente consulta una sola vez y conserva versiones oficiales',async()=>{
  let calls=0,release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);
  const fetchImpl=async()=>{calls++;started();await gate;return {ok:true,text:async()=>fixture};};
  const first=refreshOfficialIndices(db,{force:true,fetchImpl});await ready;
  const second=await refreshOfficialIndices(db,{force:true,fetchImpl});assert.equal(second.reason,'refresh_in_progress');release();await first;assert.equal(calls,1);
  const before=Number((await db.query('SELECT COUNT(*) n FROM ipc_index_versions')).rows[0].n);
  await seed(fixture.replace('12514,1508','12515,1508'),new Date(Date.now()+86400000));
  assert.equal(Number((await db.query('SELECT COUNT(*) n FROM ipc_index_versions')).rows[0].n),before+1);
});
test('correcciones manuales se preservan; dashboard y pendientes leen la misma base',async()=>{
  await seed();const id=await create({duration_months:12}),april=(await installments(id))[3];
  const edited=await request(`pending-collections/${april.id}`,{expected_amount:550000},'PATCH');assert.equal(edited.status,200,JSON.stringify(edited.result));
  const manualHistory=(await db.query("SELECT previous_amount,new_amount FROM rent_adjustment_history WHERE installment_id=$1 AND reason='manual_collection_edit'",[april.id])).rows[0];assert.equal(manualHistory.previous_amount,'547211.45');assert.equal(manualHistory.new_amount,'550000.00');
  await reconcileInstallments(db,{managedOnly:true,apply:true});
  assert.equal((await installments(id))[3].expected_amount,'550000.00');assert.equal((await installments(id))[3].contractual_amount,'547211.45');
  const pending=(await request('pending-collections')).result;assert.equal(pending.find(r=>r.id===april.id).expected_amount,550000);
  const dashboard=(await request('dashboard')).result,month=new Date().toISOString().slice(0,7);
  const total=Number((await db.query('SELECT SUM(expected_amount) total FROM installments WHERE contract_id=$1 AND period=$2',[id,month])).rows[0].total||0);assert.equal(dashboard.kpis.expected_month,total);
});

test('la edición administrativa rechaza cambios económicos incluso con un token de conciliación',async()=>{
  await seed();const id=await create({duration_months:6});
  const change={initial_amount:600000,ipc_lag_months:2};
  const rejected=await request(`contracts/${id}`,change,'PATCH');assert.equal(rejected.status,400);
  assert.equal((await db.query('SELECT initial_amount FROM contracts WHERE id=$1',[id])).rows[0].initial_amount,'500000.00');
  const simulated=await request('ipc/reconciliation/simulate',{contract_id:id,contract_changes:change});assert.equal(simulated.status,200,JSON.stringify(simulated.result));
  assert.equal((await db.query('SELECT initial_amount FROM contracts WHERE id=$1',[id])).rows[0].initial_amount,'500000.00');
  const expected=Number(adjustedMoney('600000','9841.3581','10714.6255'));assert.equal(Number(simulated.result.rows[3].contractual_amount),expected);
  const applied=await request(`contracts/${id}`,{...change,reconciliation_token:simulated.result.token,interpretation_confirmed:true},'PATCH');assert.equal(applied.status,400,JSON.stringify(applied.result));
  assert.equal((await db.query('SELECT initial_amount FROM contracts WHERE id=$1',[id])).rows[0].initial_amount,'500000.00');
  assert.equal((await installments(id))[3].expected_amount,'547211.45');
});
test('un pago nuevo invalida la simulación anterior y un subpago mantiene saldo',async()=>{
  await seed();const id=await create({duration_months:6}),april=(await installments(id))[3];
  const preview=await reconcileInstallments(db,{contractId:id});
  assert.equal((await request(`payments/${april.id}/register`,{amount:100000})).result.status,'Parcial');
  await assert.rejects(()=>reconcileInstallments(db,{contractId:id,apply:true,token:preview.token,reason:'Prueba',interpretationConfirmed:true}),/simulación/);
  const current=await reconcileInstallments(db,{contractId:id});assert.equal(current.rows[3].balance,'447211.45');
});
test('cláusula ambigua bloquea la aplicación y no modifica las cuotas',async()=>{
  await seed();const id=await create({duration_months:6}),before=await installments(id);
  await db.query("UPDATE contracts SET ipc_clause_review_required=true,ipc_clause_text='IPC según último disponible' WHERE id=$1",[id]);
  const preview=await reconcileInstallments(db,{contractId:id});assert.equal(preview.blocked.length,6);
  await assert.rejects(()=>reconcileInstallments(db,{contractId:id,apply:true,token:preview.token,reason:'Prueba',interpretationConfirmed:true}),/bloqueadas/);
  assert.deepEqual(await installments(id),before);
});
test('el pago completo y su estado se revierten juntos ante un fallo de persistencia',async()=>{
  await seed();const id=await create({duration_months:6}),april=(await installments(id))[3];
  await db.query(`CREATE FUNCTION reject_test_installment_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Fallo controlado'; END $$`);
  await db.query('CREATE TRIGGER reject_test_update BEFORE UPDATE ON installments FOR EACH ROW EXECUTE FUNCTION reject_test_installment_update()');
  try{
    const result=await request(`payments/${april.id}/register`,{amount:100000});assert.equal(result.status,400);
    assert.equal(Number((await db.query('SELECT COUNT(*) n FROM payments WHERE installment_id=$1',[april.id])).rows[0].n),0);
    assert.equal((await installments(id))[3].status,'Pendiente');
  }finally{await db.query('DROP TRIGGER reject_test_update ON installments');await db.query('DROP FUNCTION reject_test_installment_update()');}
});
test('fuente alternativa conserva INDEC y una respuesta atrasada no degrada la base',async()=>{
  await seed();const original=(await loadStoredSeries(db)).series.get('2026-09').index_value;
  const alternative='indice_tiempo,ipc_ng_nacional\n2026-08-01,12300\n2026-09-01,12600';
  const fetchImpl=async url=>{if(url===INDEC_CSV_URL)throw new Error('INDEC no disponible');return {ok:true,text:async()=>alternative};};
  const fallback=await refreshOfficialIndices(db,{force:true,fetchImpl,now:new Date('2026-11-04T12:00:00Z')});assert.equal(fallback.changed,0);assert.equal((await loadStoredSeries(db)).series.get('2026-09').index_value,original);
  const stale=await seed(subset('2026-08'),new Date('2026-11-05T12:00:00Z'));assert.equal(stale.retainedStoredData,true);assert.equal((await latestIpcSummary(db)).latestPeriod,'2026-09');
});
test('índices manuales mantienen su aviso de ajuste y las cuotas vencidas su estado',async()=>{
  await seed();const id=await create({duration_months:6,adjustment_index:'ICL'}),rows=await installments(id);
  assert.equal(rows[2].adjustment_pending,false);assert.equal(rows[3].adjustment_pending,true);assert.equal(rows[3].expected_amount,'500000.00');
  const ipc=await create({duration_months:6});await db.query("UPDATE installments SET status='Vencido' WHERE contract_id=$1",[ipc]);
  await reconcileInstallments(db,{managedOnly:true,apply:true});assert.ok((await installments(ipc)).every(row=>row.status==='Vencido'));
});

async function makeLegacy(id){
  await db.query("UPDATE installments SET expected_amount=500000,contractual_amount=NULL,original_expected_amount=NULL,calculation_hash=NULL,calculation_json='{}',ipc_managed=false,adjustment_pending=false WHERE contract_id=$1",[id]);
}
const paymentsSnapshot=async()=>(await db.query('SELECT * FROM payments ORDER BY id')).rows;

test('P0. detecta 4 contratos antiguos, separa revisión y bloqueos y aplica los aprobados en lote',async()=>{
  await seed();
  const ready=await create({duration_months:3,ipc_clause_text:'IPC trimestral, mes anterior.'});await makeLegacy(ready);
  const review=await create({duration_months:12,ipc_clause_text:'IPC trimestral, mes anterior.'});await makeLegacy(review);
  const ambiguous=await create({duration_months:6});await makeLegacy(ambiguous);await db.query('UPDATE contracts SET ipc_clause_review_required=true WHERE id=$1',[ambiguous]);
  const broken=await create({duration_months:6});await makeLegacy(broken);await db.query("DELETE FROM installments WHERE contract_id=$1 AND period='2026-02'",[broken]);
  const april=(await installments(review))[3];await request(`payments/${april.id}/register`,{amount:500000});
  const july=(await installments(review))[6];await request(`payments/${july.id}/register`,{amount:100000});
  const before=(await db.query('SELECT * FROM installments ORDER BY id')).rows,payments=await paymentsSnapshot();
  const preview=(await request('ipc/reconciliation/simulate',{})).result;
  assert.deepEqual((await db.query('SELECT * FROM installments ORDER BY id')).rows,before,'simular no escribe obligaciones');
  const summaries=new Map(preview.contracts.map(c=>[c.id,c]));
  assert.equal(summaries.get(ready).classification,'ready');assert.equal(summaries.get(review).classification,'review');assert.equal(summaries.get(ambiguous).classification,'review');assert.equal(summaries.get(broken).classification,'blocked');
  assert.ok(summaries.get(review).adjustments.length>=3);assert.equal(summaries.get(review).legacy_count,12);
  assert.equal(summaries.get(review).current_amount,'618204.30');
  const applied=await request('ipc/reconciliation/apply',{contract_ids:[ready,review,ambiguous,broken],tokens:Object.fromEntries(preview.contracts.map(c=>[c.id,c.token])),reason:'Incorporación histórica revisada',interpretation_confirmed:true});
  assert.equal(applied.status,200);assert.equal(applied.result.applied,2);assert.equal(applied.result.results.filter(r=>r.status==='blocked').length,2);
  assert.ok((await installments(ready)).every(r=>r.ipc_managed));assert.ok((await installments(review)).every(r=>r.ipc_managed));assert.ok((await installments(ambiguous)).every(r=>!r.ipc_managed));
  assert.deepEqual(await paymentsSnapshot(),payments);
  assert.equal((await installments(review))[3].expected_amount,'547211.45');assert.equal((await installments(review))[3].status,'Parcial');
  const versionCount=(await db.query('SELECT COUNT(*) n FROM rent_adjustment_history')).rows[0].n;
  const repeated=await reconcileInstallments(db,{contractId:review});assert.equal(repeated.changed,0);
  await reconcileInstallments(db,{contractId:review,apply:true,token:repeated.token,reason:'Verificación de idempotencia',interpretationConfirmed:true});
  assert.equal((await db.query('SELECT COUNT(*) n FROM rent_adjustment_history')).rows[0].n,versionCount);
});

test('P0. una simulación obsoleta por un pago no bloquea otro contrato aprobado; requiere motivo y confirmación',async()=>{
  await seed();const ids=[await create({duration_months:6}),await create({duration_months:6})];for(const id of ids)await makeLegacy(id);
  const preview=await reconcileInstallments(db),tokens=Object.fromEntries(preview.contracts.map(c=>[c.id,c.token]));
  await request(`payments/${(await installments(ids[0]))[3].id}/register`,{amount:100000});
  for(const payload of [{reason:'',interpretation_confirmed:true},{reason:'Revisado',interpretation_confirmed:false}])assert.equal((await request('ipc/reconciliation/apply',{contract_ids:ids,tokens,...payload})).status,400);
  const result=(await request('ipc/reconciliation/apply',{contract_ids:ids,tokens,reason:'Revisado con PDF',interpretation_confirmed:true})).result;
  assert.equal(result.applied,1);assert.equal(result.results[0].status,'blocked');assert.match(result.results[0].error,/simulación/);assert.equal(result.results[1].status,'applied');
  assert.ok((await installments(ids[0])).every(r=>!r.ipc_managed));assert.ok((await installments(ids[1])).every(r=>r.ipc_managed));
});

test('P0. un contrato antiguo incorporado se actualiza con una publicación nueva sin duplicar aumentos ni alterar pagos',async()=>{
  await seed(subset('2026-05'));const id=await create({duration_months:12});await makeLegacy(id);
  const july=(await installments(id))[6];await reviewedExcess(july.id,{amount:600000});
  const preview=await reconcileInstallments(db,{contractId:id});await reconcileInstallments(db,{contractId:id,apply:true,token:preview.token,reason:'Incorporación revisada',interpretationConfirmed:true});
  assert.equal((await installments(id))[6].adjustment_pending,true);
  const payments=await paymentsSnapshot();
  const result=await refreshAndUpdate(db,{force:true,fetchImpl:csvFetch(fixture),now:new Date('2026-11-04T12:00:00Z')});assert.ok(result.reconciliation.changed>0);
  assert.equal((await installments(id))[6].expected_amount,'584229.63');assert.equal((await installments(id))[6].adjustment_pending,false);
  assert.deepEqual(await paymentsSnapshot(),payments);
  const history=(await db.query('SELECT * FROM rent_adjustment_history ORDER BY id')).rows;
  assert.equal((await refreshAndUpdate(db,{force:true,fetchImpl:csvFetch(fixture),now:new Date('2026-11-05T12:00:00Z')})).reconciliation.changed,0);
  assert.deepEqual((await db.query('SELECT * FROM rent_adjustment_history ORDER BY id')).rows,history);
  const dashboard=(await request('dashboard')).result,pending=(await request('pending-collections')).result,month=new Date().toISOString().slice(0,7);
  const row=(await installments(id)).find(r=>r.period===month);assert.equal(dashboard.kpis.expected_month,Number(row.expected_amount));
  assert.equal(pending.find(r=>r.id===row.id).expected_amount,Number(row.expected_amount));assert.deepEqual(await paymentsSnapshot(),payments);
});

test('P0. históricos archivados y renovados conservan estado, pagos y obligaciones sustituidas',async()=>{
  await seed();const old=await create({duration_months:12}),archived=await create({duration_months:12});
  for(const id of [old,archived])await makeLegacy(id);
  await db.query("UPDATE contracts SET status='Renovado' WHERE id=$1",[old]);await db.query("UPDATE contracts SET status='Archivado',archived_from_status='Finalizado' WHERE id=$1",[archived]);
  await db.query("UPDATE installments SET status='Sustituido' WHERE contract_id=$1 AND period>='2026-07'",[old]);
  const preserved=(await installments(old)).filter(r=>r.status==='Sustituido');
  const rows=await installments(archived);await db.query('INSERT INTO payments(id,installment_id,amount,paid_at) VALUES($1,$2,700000,$3)',[uid(),rows[3].id,'2026-04-10']);
  await db.query('UPDATE installments SET rent_override_amount=550000,expected_amount=550000 WHERE id=$1',[rows[4].id]);
  const payments=await paymentsSnapshot();
  for(const id of [old,archived]){const p=await reconcileInstallments(db,{contractId:id});await reconcileInstallments(db,{contractId:id,apply:true,token:p.token,reason:'Revisión histórica',interpretationConfirmed:true});}
  assert.deepEqual((await installments(old)).filter(r=>r.status==='Sustituido'),preserved);
  assert.equal((await installments(archived))[4].expected_amount,'550000.00');assert.equal((await installments(archived))[4].contractual_amount,'547211.45');
  assert.equal((await db.query('SELECT status FROM contracts WHERE id=$1',[old])).rows[0].status,'Renovado');assert.equal((await db.query('SELECT status FROM contracts WHERE id=$1',[archived])).rows[0].status,'Archivado');
  assert.deepEqual(await paymentsSnapshot(),payments);
});

test('P0. cambios en descuentos o condiciones invalidan la simulación antes de incorporar',async()=>{
  await seed();const id=await create({duration_months:6});await makeLegacy(id);
  const p=await reconcileInstallments(db,{contractId:id});await db.query('UPDATE installments SET discount_amount=100 WHERE contract_id=$1',[id]);
  await assert.rejects(()=>reconcileInstallments(db,{contractId:id,apply:true,token:p.token,reason:'Revisado',interpretationConfirmed:true}),/simulación/);
  const next=await reconcileInstallments(db,{contractId:id});await db.query("UPDATE contracts SET ipc_lag_months=2 WHERE id=$1",[id]);
  await assert.rejects(()=>reconcileInstallments(db,{contractId:id,apply:true,token:next.token,reason:'Revisado',interpretationConfirmed:true}),/simulación/);
});

test('P1. un formulario antiguo equivalente guarda administración sin cambiar condiciones',async()=>{
  await seed();const id=await create({duration_months:6});
  const form={alias:'',rental_type:'Residencial',duration_months:6,start_date:'2026-01-01',end_date:'2026-06-30',initial_amount:'500000.0000',deposit_amount:'',adjustment_frequency_months:3,adjustment_index:'IPC',ipc_lag_months:0,ipc_clause_text:'',payment_due_day:10,management_fee_pct:3,bank_name:'',cbu:'',status:'Activo',notes:''};
  const preview=await request('ipc/reconciliation/simulate',{contract_id:id,contract_changes:form});assert.equal(preview.status,200);
  const saved=await request(`contracts/${id}`,{...form,reconciliation_token:preview.result.token,ipc_clause_confirmed:true,interpretation_confirmed:true},'PATCH');assert.equal(saved.status,200,JSON.stringify(saved.result));
  assert.equal((await installments(id))[3].expected_amount,'547211.45');
});
