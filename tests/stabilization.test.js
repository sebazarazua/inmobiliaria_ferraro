require('./require-isolated');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {spawnSync}=require('node:child_process');
const {createApp}=require('../backend/src/app'),{uid}=require('../backend/src/database');
const {expenseOperation}=require('../backend/src/modules/services/expenses');
const {serviceRegistry}=require('../backend/src/modules/services');
const {syncRates,gaps,editionDate}=require('../backend/src/modules/late-fees/sync');
const {importRates}=require('../backend/src/modules/late-fees/rates');
const {ocrPage,ocrDiagnostics}=require('../backend/src/modules/late-fees/ocr');
const {checkRequest,assertSafeBinding,allowedHosts}=require('../backend/src/lib/access');
const {balance}=require('../backend/src/lib/money');
const MIGRATIONS=path.join(__dirname,'../database/migrations');
const BNA_URL='https://www.boletinoficial.gov.ar/detalleAviso/primera/332108/20250930';
const bnaHtml=fs.readFileSync(path.join(__dirname,'fixtures/bna-cartera-20250930.html'),'utf8');
const indexFor=(ymd,links=[])=>`<script>var fechaSeleccionadaYMD = '${ymd}';</script>`+links.map(l=>`<a href="${l}"><p>BANCO DE LA NACIÓN ARGENTINA</p></a>`).join('');

async function setup(t,{lateFee='FIXED_DAILY',start='2025-01-01'}={}){
  const app=await createApp(),db=app.db;
  await db.query('TRUNCATE persons,properties,contracts,installments,payments,documents,ledger_entries,audit_log,expense_operations,service_operations,late_fee_rate_sources,late_fee_sync_days,integrity_findings RESTART IDENTITY CASCADE');
  await db.query("DELETE FROM settings WHERE key='late_fee_policy'");await db.query("UPDATE late_fee_sync_state SET checked_at=NULL,successful_at=NULL,updated_at=NULL,status='never',error=NULL,recovery_json='{}'");
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>app.server.close(r));await db.end();});
  const port=app.server.address().port,base=`http://127.0.0.1:${port}/api/`;
  const call=async(route,input,method)=>{const res=await fetch(base+route,{method:method||(input?'POST':'GET'),headers:{'Content-Type':'application/json'},...(input?{body:JSON.stringify(input)}:{})});return{status:res.status,body:await res.json()};};
  const tenant=uid(),property=uid();
  await db.query("INSERT INTO persons(id,full_name) VALUES($1,'Persona Sintética Estabilización')",[tenant]);
  await db.query("INSERT INTO properties(id,code,address,normalized_address) VALUES($1,'ESTAB','Calle Sintética 456','calle sintetica 456')",[property]);
  const created=await call('contracts',{code:'ESTAB-1',rental_type:'Residencial',management_fee_pct:3,property_id:property,tenant_id:tenant,start_date:start,duration_months:12,initial_amount:100000,currency:'ARS',adjustment_type:'IPC',adjustment_index:'IPC',adjustment_frequency_months:24,payment_due_day:10,late_fee_type:lateFee,...(lateFee==='FIXED_DAILY'?{late_fee_daily_pct:'0.10'}:{})});
  assert.equal(created.status,201,JSON.stringify(created.body));
  const contract=created.body.id,installments=(await db.query('SELECT id,period,due_date::text FROM installments WHERE contract_id=$1 ORDER BY period',[contract])).rows;
  const expense=async patch=>{const input={request_id:uid(),operation:'create',entry_date:'2025-09-23',category:'Servicio',description:'Factura sintética de agua',amount:'20000',currency:'ARS',property_id:property,contract_id:contract,installment_id:installments[8].id,responsibility:'tenant',responsibility_confirmed:true,responsibility_reference:'Cláusula sintética revisada',reason:'Comprobante sintético revisado',...patch};const preview=await expenseOperation(db,input);return expenseOperation(db,{...input,token:preview.token,confirm:true},{apply:true});};
  const balances=async()=>(await db.query(`SELECT i.id,i.period,i.status,i.expected_amount::text,i.services_amount::text,(COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.installment_id=i.id),0)+i.manual_partial_amount)::text paid FROM installments i ORDER BY i.period,i.id`)).rows;
  return{app,db,port,call,contract,property,tenant,installments,expense,balances};
}
function rawRequest(port,{method='GET',path:route='/api/contracts',headers={},body=''}){
  return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,method,path:route,headers:{...headers,...(body?{'Content-Length':Buffer.byteLength(body)}:{})}},res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:data}));});req.on('error',reject);if(body)req.write(body);req.end();});
}
async function withSchema(db,before,work){
  const schema='estab_'+uid().replaceAll('-',''),client=await db.connect();
  try{await client.query('CREATE SCHEMA '+schema);await client.query('SET search_path TO '+schema);
    for(const file of fs.readdirSync(MIGRATIONS).filter(f=>f.endsWith('.sql')&&f<before).sort())await client.query(fs.readFileSync(path.join(MIGRATIONS,file),'utf8'));
    return await work(client,file=>client.query(fs.readFileSync(path.join(MIGRATIONS,file),'utf8')));
  }finally{await client.query('SET search_path TO public');await client.query('DROP SCHEMA '+schema+' CASCADE');client.release();}
}

// FASE 1
test('E01. gastos de servicio informan su responsable real y su cargo vinculado como una única obligación',async t=>{
  const s=await setup(t);
  await s.expense({responsibility:'owner',description:'Servicio sintético del propietario'});
  const tenantExpense=await s.expense({});
  const rows=(await s.call('services')).body;
  const owner=rows.find(r=>r.description==='Servicio sintético del propietario'),tenant=rows.find(r=>r.id===tenantExpense.expense.id);
  assert.equal(owner.responsibility,'owner');assert.equal(owner.charge_id,null,'un gasto del propietario no figura como deuda del inquilino');
  assert.equal(tenant.responsibility,'tenant');assert.equal(tenant.charge_status,'Confirmado');assert.equal(tenant.charge_period,'2025-09');assert.equal(tenant.charge_original_amount,'20000.00');
  const charges=await serviceRegistry(s.db);
  assert.equal(charges.length,1);assert.equal(charges[0].expense_id,tenant.id);
  assert.equal((await s.db.query('SELECT services_amount::text v FROM installments WHERE id=$1',[s.installments[8].id])).rows[0].v,'20000.00','el gasto trasladado suma una sola vez al saldo');
});

// FASE 2
test('E02. la base rechaza un segundo cargo para el mismo gasto aunque se omita la aplicación',async t=>{
  const s=await setup(t),created=await s.expense({});
  assert.equal((await s.db.query("SELECT 1 FROM pg_indexes WHERE indexname='installment_services_expense_uq'")).rowCount,1);
  const insert=(status,currency='ARS')=>s.db.query(`INSERT INTO installment_services(id,installment_id,category,description,original_amount,currency,status,responsibility_reference,expense_id) VALUES($1,$2,'Agua','Duplicado directo',20000,$3,$4,'Referencia sintética',$5)`,[uid(),s.installments[9].id,currency,status,created.expense.id]);
  await assert.rejects(()=>insert('Confirmado'),/ya tiene un cargo asociado|duplicate key/);
  await s.db.query("UPDATE installment_services SET status='Anulado' WHERE expense_id=$1",[created.expense.id]);
  await assert.rejects(()=>insert('Borrador'),/ya tiene un cargo asociado|duplicate key/,'un cargo anulado sigue reservando el gasto');
  const other=await s.expense({responsibility:'owner',description:'Otro gasto sintético'});
  await assert.rejects(()=>s.db.query(`INSERT INTO installment_services(id,installment_id,category,description,original_amount,currency,status,responsibility_reference,expense_id) VALUES($1,$2,'Agua','Moneda cruzada',100,'USD','Borrador','Referencia sintética',$3)`,[uid(),s.installments[9].id,other.expense.id]),/moneda/i);
  assert.equal((await serviceRegistry(s.db)).length,1);
});

test('E03. migración 018 sobre historia con duplicados: no los toca, los informa y bloquea los nuevos',async t=>{
  const s=await setup(t);
  await withSchema(s.db,'018',async(client,apply)=>{
    const person=uid(),property=uid(),contract=uid(),installment=uid(),expense=uid(),a=uid(),b=uid();
    await client.query("INSERT INTO persons(id,full_name) VALUES($1,'Sintética Histórica')",[person]);
    await client.query("INSERT INTO properties(id,code,address,normalized_address) VALUES($1,'HIST','Histórica 1','historica 1')",[property]);
    await client.query("INSERT INTO contracts(id,code,property_id,tenant_id,rental_type,start_date,end_date,duration_months,initial_amount,currency) VALUES($1,'HIST',$2,$3,'Residencial','2025-01-01','2025-12-31',12,100000,'ARS')",[contract,property,person]);
    await client.query("INSERT INTO installments(id,contract_id,period,due_date,expected_amount,currency) VALUES($1,$2,'2025-09','2025-09-10',100000,'ARS')",[installment,contract]);
    await client.query("INSERT INTO payments(id,installment_id,amount,paid_at) VALUES($1,$2,50000,'2025-09-12')",[uid(),installment]);
    await client.query("INSERT INTO ledger_entries(id,entry_date,kind,category,description,amount,currency,property_id,contract_id) VALUES($1,'2025-09-01','Gasto','Servicio','Gasto histórico sintético',5000,'ARS',$2,$3)",[expense,property,contract]);
    for(const id of [a,b])await client.query("INSERT INTO installment_services(id,installment_id,category,description,original_amount,currency,status,responsibility_reference,expense_id) VALUES($1,$2,'Agua','Cargo histórico repetido',5000,'ARS','Confirmado','Cláusula histórica revisada',$3)",[id,installment,expense]);
    const before={installments:(await client.query('SELECT * FROM installments ORDER BY id')).rows,charges:(await client.query('SELECT * FROM installment_services ORDER BY id')).rows,payments:(await client.query('SELECT * FROM payments ORDER BY id')).rows,ledger:(await client.query('SELECT * FROM ledger_entries ORDER BY id')).rows};
    await apply('018_financial_integrity.sql');
    assert.equal((await client.query("SELECT 1 FROM pg_indexes WHERE schemaname=current_schema() AND indexname='installment_services_expense_uq'")).rowCount,0,'sin índice único mientras haya duplicados históricos');
    const findings=(await client.query('SELECT check_name,details_json FROM integrity_findings')).rows;
    assert.equal(findings.length,1);assert.equal(findings[0].check_name,'installment_services_expense_duplicates');assert.deepEqual([...findings[0].details_json.charge_ids].sort(),[a,b].sort());
    assert.deepEqual({installments:(await client.query('SELECT * FROM installments ORDER BY id')).rows,charges:(await client.query('SELECT * FROM installment_services ORDER BY id')).rows,payments:(await client.query('SELECT * FROM payments ORDER BY id')).rows,ledger:(await client.query('SELECT * FROM ledger_entries ORDER BY id')).rows},before,'no combina, borra ni recalcula importes');
    await assert.rejects(()=>client.query("INSERT INTO installment_services(id,installment_id,category,description,original_amount,currency,status,responsibility_reference,expense_id) VALUES($1,$2,'Agua','Tercer cargo',5000,'ARS','Borrador','Cláusula histórica revisada',$3)",[uid(),installment,expense]),/ya tiene un cargo asociado/);
    await client.query("UPDATE installment_services SET forgiven_amount=1000 WHERE id=$1",[a]);
    assert.equal((await client.query('SELECT services_amount::text v FROM installments WHERE id=$1',[installment])).rows[0].v,'9000.00','los vínculos históricos siguen operables para su conciliación');
  });
});

test('E04. migración 018 desde un esquema 017 poblado no cambia saldos, pagos, cargos ni gastos',async t=>{
  const s=await setup(t);
  await withSchema(s.db,'018',async(client,apply)=>{
    const person=uid(),property=uid(),contract=uid(),installment=uid(),expense=uid();
    await client.query("INSERT INTO persons(id,full_name) VALUES($1,'Sintética 017')",[person]);
    await client.query("INSERT INTO properties(id,code,address,normalized_address) VALUES($1,'M17','Prueba 17','prueba 17')",[property]);
    await client.query("INSERT INTO contracts(id,code,property_id,tenant_id,rental_type,start_date,end_date,duration_months,initial_amount,currency) VALUES($1,'M17',$2,$3,'Residencial','2025-01-01','2025-12-31',12,100000,'ARS')",[contract,property,person]);
    await client.query("INSERT INTO installments(id,contract_id,period,due_date,expected_amount,currency,late_fee_amount) VALUES($1,$2,'2025-09','2025-09-10',100000,'ARS',700)",[installment,contract]);
    await client.query("INSERT INTO payments(id,installment_id,amount,paid_at) VALUES($1,$2,130000,'2025-09-15')",[uid(),installment]);
    await client.query("INSERT INTO ledger_entries(id,entry_date,kind,category,description,amount,currency,property_id,contract_id,responsibility) VALUES($1,'2025-09-01','Gasto','Servicio','Gasto 017 sintético',8000,'ARS',$2,$3,'tenant')",[expense,property,contract]);
    await client.query("INSERT INTO installment_services(id,installment_id,category,description,original_amount,forgiven_amount,currency,status,responsibility_reference,expense_id,charge_kind) VALUES($1,$2,'Agua','Cargo 017 sintético',8000,500,'ARS','Confirmado','Cláusula sintética revisada',$3,'service')",[uid(),installment,expense]);
    const snapshot=async()=>({rows:(await client.query('SELECT i.*,(SELECT SUM(amount) FROM payments p WHERE p.installment_id=i.id)::text paid FROM installments i ORDER BY id')).rows,charges:(await client.query('SELECT * FROM installment_services ORDER BY id')).rows,ledger:(await client.query('SELECT * FROM ledger_entries ORDER BY id')).rows,contracts:(await client.query('SELECT * FROM contracts ORDER BY id')).rows});
    const before=await snapshot(),oldBalance=balance(before.rows[0],before.rows[0].paid);
    await apply('018_financial_integrity.sql');
    const after=await snapshot();assert.deepEqual(after,before);assert.equal(balance(after.rows[0],after.rows[0].paid),oldBalance);
    assert.equal((await client.query("SELECT 1 FROM pg_indexes WHERE schemaname=current_schema() AND indexname='installment_services_expense_uq'")).rowCount,1);
    assert.equal((await client.query('SELECT COUNT(*)::int n FROM installment_services')).rows[0].n,1,'la migración no crea obligaciones');
  });
});

test('E05. un período cerrado posterior bloquea la edición repetida aunque su día de la semana ordene antes',async t=>{
  const s=await setup(t,{start:'2026-06-01'});
  const june=s.installments.find(i=>i.period==='2026-06'),july=s.installments.find(i=>i.period==='2026-07');
  assert.equal(june.due_date,'2026-06-10');assert.equal(july.due_date,'2026-07-10');
  await s.db.query('UPDATE installments SET financial_closed_at=now() WHERE id=$1',[july.id]);
  const before=await s.balances();
  const repeated=await s.call(`pending-collections/${june.id}`,{declared_amount:90000,repeat_remaining:true},'PATCH');
  assert.equal(repeated.status,400);assert.match(repeated.body.error,/período está cerrado/);
  assert.deepEqual(await s.balances(),before);
  const direct=await s.call(`pending-collections/${july.id}`,{declared_amount:90000},'PATCH');
  assert.equal(direct.status,400);
  const open=await s.call(`pending-collections/${june.id}`,{declared_amount:90000},'PATCH');
  assert.equal(open.status,200,JSON.stringify(open.body));
});

// FASE 3
test('E06. recuperación BNA: calcula la cobertura necesaria, avanza por lotes y no repite días resueltos',async t=>{
  const s=await setup(t,{lateFee:'BANK_ACTIVE_RATE',start:'2025-09-01'});
  await importRates(s.db,{url:BNA_URL},{fetchImpl:async()=>({ok:true,text:async()=>bnaHtml})});
  const requested=[],fetchImpl=async url=>{const ymd=url.match(/\/(\d{8})$/)[1];requested.push(ymd);return{ok:true,text:async()=>indexFor(ymd)};};
  const now=new Date('2025-11-15T12:00:00Z');
  let r=await syncRates(s.db,{fetchImpl,now});
  assert.equal(r.required.required,true);assert.equal(r.required.from,'2025-09-10');
  assert.ok(r.gaps.length>=2,'faltan los días previos y posteriores a la publicación conocida');
  assert.equal(r.coverage_complete,false);
  assert.equal(requested.length,7+14,'semana reciente más un lote acotado');
  const firstBatch=new Set(requested);
  assert.ok(r.pending_recovery_days>0);
  requested.length=0;
  r=await syncRates(s.db,{fetchImpl,now:new Date(now.getTime()+60_000)});
  assert.ok(requested.length>0&&requested.length<=14,'el segundo lote no vuelve a consultar la semana reciente ya verificada');
  assert.ok(requested.every(d=>!firstBatch.has(d)),'no repite días ya resueltos');
  for(let i=0;i<10&&r.pending_recovery_days>0;i++)r=await syncRates(s.db,{fetchImpl,now:new Date(now.getTime()+(i+2)*60_000)});
  assert.equal(r.pending_recovery_days,0);
  requested.length=0;r=await syncRates(s.db,{fetchImpl,now:new Date(now.getTime()+3600_000)});
  assert.equal(r.skipped,true);assert.equal(requested.length,0,'con la recuperación terminada y la semana reciente al día no consulta');
  assert.equal((await s.db.query("SELECT COUNT(*)::int n FROM late_fee_sync_days WHERE status='no_publication'")).rows[0].n,(await s.db.query('SELECT COUNT(*)::int n FROM late_fee_sync_days')).rows[0].n);
  assert.ok(r.gaps.length>=2,'días sin publicación no se rellenan con tasas inventadas');
  assert.equal((await s.db.query('SELECT COUNT(*)::int n FROM late_fee_rates')).rows[0].n,5);
});

test('E07. recuperación BNA distingue sin publicación, edición de otro día, error HTTP, formato y contradicción',async t=>{
  const s=await setup(t,{lateFee:'BANK_ACTIVE_RATE',start:'2025-09-01'});
  const contradicting=bnaHtml.replace('52,05','59,05');
  await importRates(s.db,{url:BNA_URL},{fetchImpl:async()=>({ok:true,text:async()=>bnaHtml})});
  const behaviour={'20250930':()=>({ok:true,text:async()=>indexFor('20250930',['/detalleAviso/primera/332108/20250930'])}),'20250929':()=>({ok:false,status:503,text:async()=>''}),'20250928':()=>({ok:true,text:async()=>indexFor('20250926')}),'20250927':()=>({ok:true,text:async()=>'<html>rediseño</html>'}),'20250926':()=>({ok:true,text:async()=>indexFor('20250926')})};
  const fetchImpl=async url=>{if(url.includes('detalleAviso'))return{ok:true,text:async()=>contradicting};const ymd=url.match(/\/(\d{8})$/)[1];return (behaviour[ymd]||(()=>({ok:true,text:async()=>indexFor(ymd)})))();};
  const r=await syncRates(s.db,{fetchImpl,force:true,from:'2025-09-26',until:'2025-09-30',now:new Date('2025-11-15T12:00:00Z')});
  const days=Object.fromEntries((await s.db.query('SELECT day::text,status FROM late_fee_sync_days')).rows.map(x=>[x.day,x.status]));
  assert.deepEqual(days,{'2025-09-30':'contradiction','2025-09-29':'index_error','2025-09-28':'no_publication','2025-09-27':'format_error','2025-09-26':'no_publication'});
  assert.equal(r.status,'partial');
  assert.ok(r.failures.some(f=>f.status==='contradiction'&&/revisión/.test(f.label)));
  assert.equal((await s.db.query("SELECT COUNT(*)::int n FROM late_fee_rates WHERE annual_percentage=59.05")).rows[0].n,0,'la contradicción no reemplaza la tasa verificada');
  assert.equal(editionDate(indexFor('20250926')),'2025-09-26');
});

test('E08. sin conexión: conserva la cobertura, informa huecos, se detiene sin martillar y reintenta luego',async t=>{
  const s=await setup(t,{lateFee:'BANK_ACTIVE_RATE',start:'2025-09-01'});
  await importRates(s.db,{url:BNA_URL},{fetchImpl:async()=>({ok:true,text:async()=>bnaHtml})});
  const balancesBefore=await s.balances();let calls=0;
  const offline=async()=>{calls++;throw new Error('ENOTFOUND');};
  const now=new Date('2025-11-15T12:00:00Z');
  let r=await syncRates(s.db,{fetchImpl:offline,now});
  assert.equal(r.status,'offline');assert.equal(calls,1,'se detiene al primer fallo de red');
  assert.equal(r.coverage.length,5);assert.ok(r.gaps.length>0);
  calls=0;r=await syncRates(s.db,{fetchImpl:offline,now:new Date(now.getTime()+5*60_000)});
  assert.ok(calls<=1);
  assert.deepEqual(await s.balances(),balancesBefore,'sin conexión no cambian cuotas ni punitorios');
  const pending=await s.call(`contracts/${s.contract}/late-fees`);
  assert.equal(pending.status,200,'el resto del sistema sigue operativo sin red');
  assert.deepEqual(gaps([{valid_from:'2025-09-23',valid_until:'2025-09-30'}],'2025-09-20','2025-10-02'),[{from:'2025-09-20',until:'2025-09-22'},{from:'2025-09-30',until:'2025-10-02'}]);
});

// FASE 4
test('E09. OCR: diagnostica ejecutables e idioma faltantes y clasifica errores sin dejar temporales',async t=>{
  const enoent=Object.assign(new Error('spawn pdftoppm ENOENT'),{code:'ENOENT'});
  let d=await ocrDiagnostics({run:async()=>{throw enoent;},enabled:true});
  assert.equal(d.available,false);assert.deepEqual(d.missing,['pdftoppm','tesseract']);assert.match(d.message,/brew install poppler tesseract tesseract-lang/);
  d=await ocrDiagnostics({run:async(cmd,args)=>cmd==='tesseract'&&args[0]==='--list-langs'?{stdout:'List of available languages (2):\neng\nosd\n'}:{stdout:'version 1'},enabled:true});
  assert.deepEqual(d.missing,['tesseract-spa']);
  d=await ocrDiagnostics({run:async(cmd,args)=>cmd==='tesseract'&&args[0]==='--list-langs'?{stdout:'eng\nspa\n'}:{stdout:'ok'},enabled:false});
  assert.equal(d.available,true);assert.match(d.message,/deshabilitado/);
  const temps=()=>fs.readdirSync(os.tmpdir()).filter(f=>f.startsWith('ferraro-mora-ocr-')).length,initial=temps();
  const cases=[[async()=>{throw enoent;},'missing_executable'],[async()=>{throw Object.assign(new Error('killed'),{killed:true,signal:'SIGTERM'});},'timeout'],[async()=>{throw Object.assign(new Error('Syntax Error'),{code:1,stderr:'Syntax Error: Couldn\'t read xref table'});},'unreadable_pdf'],[async cmd=>{if(cmd==='tesseract')throw Object.assign(new Error('fail'),{code:1,stderr:"Failed loading language 'spa'"});return{stdout:''};},'missing_language'],[async cmd=>{if(cmd==='tesseract')throw Object.assign(new Error('fail'),{code:1,stderr:'segfault'});return{stdout:''};},'processing_error']];
  for(const [run,kind] of cases)await assert.rejects(()=>ocrPage('/inexistente.pdf',1,{run}),e=>e.kind===kind);
  assert.equal(temps(),initial,'no quedan imágenes temporales');
});

const installed=cmd=>spawnSync(cmd,[cmd==='pdftoppm'?'-v':'--version']).error?.code!=='ENOENT';
const ocrInstalled=installed('pdftoppm')&&installed('tesseract')&&/\bspa\b/.test(spawnSync('tesseract',['--list-langs'],{encoding:'utf8'}).stdout||'');
// Image-only PDF (no text layer), built from a rasterized synthetic page: what a scanner produces.
function scannedPdf(textPdf,dir){
  const prefix=path.join(dir,'raster');const r=spawnSync('pdftoppm',['-f','1','-l','1','-r','150','-gray','-singlefile',textPdf,prefix]);assert.equal(r.status,0,String(r.stderr));
  const pgm=fs.readFileSync(prefix+'.pgm'),header=pgm.toString('latin1',0,64).match(/^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/);assert.ok(header,'PGM inesperado');
  const [,w,h]=header.map(Number),pixels=require('node:zlib').deflateSync(pgm.subarray(header[0].length));
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w*72/150} ${h*72/150}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,null,null];
  const parts=[Buffer.from('%PDF-1.4\n')],offsets=[];const push=b=>parts.push(Buffer.isBuffer(b)?b:Buffer.from(b,'latin1'));const size=()=>parts.reduce((n,b)=>n+b.length,0);
  const draw=`q ${w*72/150} 0 0 ${h*72/150} 0 0 cm /Im0 Do Q`;
  for(let i=0;i<5;i++){offsets.push(size());push(`${i+1} 0 obj\n`);
    if(i===3){push(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${pixels.length} >>\nstream\n`);push(pixels);push('\nendstream');}
    else if(i===4)push(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);else push(objects[i]);
    push('\nendobj\n');}
  const xref=size();push(`xref\n0 6\n0000000000 65535 f \n${offsets.map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const file=path.join(dir,'escaneado.pdf');fs.writeFileSync(file,Buffer.concat(parts));return file;
}
test('E10. OCR nativo: un PDF escaneado sintético sin capa de texto se lee localmente',{skip:ocrInstalled?false:'Poppler o Tesseract con idioma español no están instalados: integración nativa sin verificar'},async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ferraro-ocr-native-'));
  try{
    const textPdf=path.join(dir,'texto.pdf');fs.writeFileSync(textPdf,require('./support/late-fee-fixtures').clausePdf('SEXTA: INTERESES PUNITORIOS. En caso de mora se aplicara un interes punitorio del 0,10% diario desde el dia siguiente al vencimiento.'));
    const scanned=scannedPdf(textPdf,dir);
    assert.equal(String(spawnSync('pdftotext',[scanned,'-']).stdout||'').trim(),'','el PDF de prueba no tiene texto extraíble');
    const text=(await ocrPage(scanned,1)).toUpperCase();
    assert.match(text,/PUNITORIO/);assert.match(text,/VENCIMIENTO/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

// FASE 6
test('E11. barreras de acceso: bloquea CSRF de otro sitio, DNS rebinding y formularios, sin afectar el uso local',async t=>{
  const s=await setup(t),port=s.port,count=async()=>Number((await s.db.query('SELECT COUNT(*) n FROM properties')).rows[0].n),before=await count();
  const form='{"address":"Intrusa","x":"="}';
  assert.equal((await rawRequest(port,{method:'POST',path:'/api/properties',headers:{Host:`127.0.0.1:${port}`,'Content-Type':'text/plain',Origin:'https://hostil.example','Sec-Fetch-Site':'cross-site'},body:form})).status,403);
  assert.equal((await rawRequest(port,{method:'POST',path:'/api/properties',headers:{Host:`127.0.0.1:${port}`,'Content-Type':'text/plain'},body:form})).status,415,'un formulario sin Origin tampoco pasa');
  assert.equal((await rawRequest(port,{method:'POST',path:'/api/properties',headers:{Host:`127.0.0.1:${port}`,'Content-Type':'application/json',Origin:'null'},body:'{"address":"Intrusa"}'})).status,403);
  assert.equal((await rawRequest(port,{method:'POST',path:'/api/properties',headers:{Host:`127.0.0.1:${port}`,'Content-Type':'application/json',Origin:`http://localhost:${port}`},body:'{"address":"Intrusa"}'})).status,403,'Origin y Host deben coincidir');
  assert.equal((await rawRequest(port,{path:'/api/contracts',headers:{Host:'atacante.example'}})).status,421);
  assert.equal((await rawRequest(port,{path:'/',headers:{Host:'atacante.example'}})).status,421,'tampoco sirve la interfaz a otro dominio');
  assert.equal(await count(),before);
  const ok=await rawRequest(port,{method:'POST',path:'/api/properties',headers:{Host:`127.0.0.1:${port}`,'Content-Type':'application/json',Origin:`http://127.0.0.1:${port}`,'Sec-Fetch-Site':'same-origin'},body:'{"address":"Local legítima"}'});
  assert.equal(ok.status,201,ok.body);assert.equal(ok.headers['x-frame-options'],'DENY');assert.equal(ok.headers['x-content-type-options'],'nosniff');
  assert.equal(checkRequest({method:'POST',headers:{host:'webhook.example','content-type':'application/json'}},'/api/whatsapp/webhook',{hosts:allowedHosts({})}),null,'el webhook firmado no depende del Host');
  assert.throws(()=>assertSafeBinding('0.0.0.0',{}),/sin autenticación|no hay autenticación/);
  assert.throws(()=>assertSafeBinding('192.168.1.20',{}));
  assert.doesNotThrow(()=>assertSafeBinding('127.0.0.1',{}));assert.doesNotThrow(()=>assertSafeBinding('localhost',{}));
});

// FASE 5
test('E12. el control de privacidad rechaza PDFs, entornos, snapshots y .DS_Store en el índice',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ferraro-privacy-')),script=path.join(__dirname,'../backend/scripts/check-private-artifacts.js');
  try{
    const git=(...args)=>spawnSync('git',args,{cwd:dir,encoding:'utf8'});git('init','-q');
    fs.writeFileSync(path.join(dir,'README.md'),'ok');git('add','README.md');
    assert.equal(spawnSync(process.execPath,[script],{cwd:dir}).status,0);
    for(const file of ['contrato.pdf','.env','.DS_Store','.playwright-cli/page.yml','tmp/captura.png']){
      fs.mkdirSync(path.dirname(path.join(dir,file)),{recursive:true});fs.writeFileSync(path.join(dir,file),'x');git('add','-f',file);
      assert.equal(spawnSync(process.execPath,[script],{cwd:dir}).status,1,file);git('rm','-q','--cached',file);
    }
    fs.writeFileSync(path.join(dir,'.env.example'),'X=1');git('add','.env.example');
    assert.equal(spawnSync(process.execPath,[script],{cwd:dir}).status,0);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

// FASE 8
test('E13. el diagnóstico de base es de solo lectura y detecta saldos a favor y migraciones pendientes',async t=>{
  const s=await setup(t),{diagnose}=require('../backend/scripts/diagnose-database');
  await s.db.query("INSERT INTO payments(id,installment_id,amount,paid_at) VALUES($1,$2,150000,'2025-01-11')",[uid(),s.installments[0].id]);
  const fingerprint=async()=>(await s.db.query('SELECT (SELECT COUNT(*) FROM audit_log) a,(SELECT COUNT(*) FROM payments) p,(SELECT md5(string_agg(i.id::text||i.status||i.expected_amount::text,\',\' ORDER BY i.id)) FROM installments i) h')).rows[0];
  const before=await fingerprint();
  const report=await diagnose(process.env.DATABASE_URL);
  assert.deepEqual(await fingerprint(),before);
  assert.deepEqual(report.migrations.pending,[]);assert.equal(report.migrations.latest_applied,'018_financial_integrity.sql');
  assert.equal(report.checks.negative_balances.count,1);assert.deepEqual(report.checks.negative_balances.credit_by_currency,{ARS:'50000.00'});
  assert.equal(report.checks.duplicate_expense_links.unique_index,true);
  assert.ok(!JSON.stringify(report).includes('Persona Sintética'),'no expone nombres');
});
