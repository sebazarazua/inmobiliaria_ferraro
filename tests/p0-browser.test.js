require('./require-isolated');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const {createApp}=require('../backend/src/app');
const {generateInstallments,refreshAndUpdate,reconcileInstallments}=require('../backend/src/modules/rent');
const {uid}=require('../backend/src/database');
const {pdf,review}=require('./support/p0-fixtures');
const {adjustedMoney}=require('../backend/src/lib/money');

test('P0 navegador: reimportación completa, IPC histórico, incorporación antigua y reactivación',async()=>{
  const cli=process.env.PLAYWRIGHT_CLI;assert.ok(cli&&fs.existsSync(cli),'Indicá PLAYWRIGHT_CLI.');
  const cwd=process.env.FERRARO_TEST_IMPORT_DIRECTORY,artifacts=path.join(__dirname,'..','tmp','p0-verification');fs.mkdirSync(artifacts,{recursive:true});
  const run=async(...args)=>{const r=await promisify(execFile)(process.execPath,[cli,'-s=ferraro-p0',...args],{cwd,timeout:60000,maxBuffer:2000000}).catch(e=>{throw new Error([e.message,e.stdout,e.stderr].join('\n'));});assert.doesNotMatch(r.stdout,/### Error/,r.stdout);return r.stdout;};
  const app=await createApp(),db=app.db;
  await db.query('TRUNCATE persons,properties,contracts,installments,payments,documents,imports,import_exclusions,audit_log,rent_adjustment_history RESTART IDENTITY CASCADE');
  await db.query("UPDATE settings SET value=$1 WHERE key='import_directory'",[cwd]);
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
  const uploadFile=path.join(path.dirname(cwd),'p0-browser.pdf');fs.writeFileSync(uploadFile,pdf('Documento ficticio para prueba de reimportacion IPC'));
  const invoke=async(name,script)=>{const file=path.join(cwd,name+'.js');fs.writeFileSync(file,script);const output=await run('run-code','--filename='+file).catch(async error=>{fs.writeFileSync(path.join(artifacts,name+'-failure.txt'),await run('snapshot').catch(e=>e.message));await run('screenshot','--filename='+path.join(artifacts,name+'-failure.png')).catch(()=>{});throw error;});fs.writeFileSync(path.join(artifacts,name+'.txt'),output);return output;};
  const snapshot=async(id)=>(await db.query('SELECT * FROM installments WHERE contract_id=$1 ORDER BY period',[id])).rows;
  const historical={...review,start_date:'2025-11-01',end_date:'2027-10-31',alias:'P0 navegador histórico'};
  const reviewScript=`async function confirmReview(page){
    const dialog=page.getByRole('dialog',{name:'Revisar importación de contrato'});await dialog.waitFor();
    const values=${JSON.stringify(historical)};
    for(const field of ['address','owner_full_name','owner_document_number','tenant_full_name','tenant_document_number','start_date','end_date','duration_months','initial_amount','alias','payment_due_day'])await dialog.locator('[name="'+field+'"]').fill(String(values[field]));
    for(const field of ['property_type','rental_type','currency','guarantee_type','guarantee_provider'])await dialog.locator('[name="'+field+'"]').selectOption(values[field]);
    await dialog.getByLabel('¿Cómo se actualiza el alquiler?').selectOption('IPC');
    await dialog.getByLabel('¿Cada cuánto aumenta el alquiler?').selectOption(String(values.adjustment_frequency_months));
    await dialog.getByLabel('¿Qué mes del IPC se utiliza para calcular el aumento?').selectOption({label:'Mes anterior al ajuste'});
    await dialog.getByRole('button',{name:'Confirmar y crear contrato'}).click();await dialog.waitFor({state:'hidden'});
  }`;
  try{
    await run('open',base+'/#imports','--browser=chrome');
    await invoke('01-import',`async page=>{
      await page.emulateMedia({reducedMotion:'reduce'});await page.setViewportSize({width:1440,height:1000});
      const errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.goto(${JSON.stringify(base+'/#imports')});await page.locator('input[type=file]').setInputFiles(${JSON.stringify(uploadFile)});
      const row=page.getByRole('row').filter({hasText:'p0-browser.pdf'});await row.getByRole('button',{name:'Completar',exact:true}).click();
      ${reviewScript}
      await confirmReview(page);if(errors.length)throw new Error(errors.join(';'));
    }`);
    const first=(await db.query('SELECT * FROM contracts')).rows[0],firstRows=await snapshot(first.id);
    assert.equal(firstRows.length,24);assert.equal(firstRows.find(r=>r.period==='2026-02').expected_amount,adjustedMoney('500000','9603.8623','10413.0309'));
    assert.equal(firstRows.find(r=>r.period==='2026-11').adjustment_pending,true);
    const entities=(await db.query('SELECT id FROM persons UNION ALL SELECT id FROM properties ORDER BY id')).rows;
    await invoke('02-delete-reimport',`async page=>{
      await page.goto(${JSON.stringify(base+'/#contracts')});const row=page.getByRole('row').filter({hasText:${JSON.stringify(first.code)}});
      await row.getByRole('button',{name:'Ver acciones'}).click();await page.getByRole('button',{name:'Eliminar contrato…'}).click();
      const impact=page.getByRole('dialog',{name:'Eliminar contrato'});await impact.getByRole('checkbox').check();await impact.getByRole('button',{name:'Eliminar definitivamente'}).click();await impact.waitFor({state:'hidden'});
      await page.goto(${JSON.stringify(base+'/#imports')});await page.locator('input[type=file]').setInputFiles(${JSON.stringify(uploadFile)});
      const confirmation=page.getByRole('dialog',{name:'Volver a importar'});await confirmation.waitFor();
      await page.screenshot({path:${JSON.stringify(path.join(artifacts,'reimport-confirmation.png'))},fullPage:true});
      await confirmation.getByRole('button',{name:'Cancelar',exact:true}).click();
    }`);
    assert.equal((await db.query('SELECT COUNT(*) n FROM contracts')).rows[0].n,'0');assert.equal((await db.query('SELECT COUNT(*) n FROM imports')).rows[0].n,'1');
    await invoke('03-confirm-analysis',`async page=>{
      await page.locator('input[type=file]').setInputFiles(${JSON.stringify(uploadFile)});
      const confirmation=page.getByRole('dialog',{name:'Volver a importar'});await confirmation.getByRole('button',{name:'Volver a importar',exact:true}).click();await confirmation.waitFor({state:'hidden'});
      const rows=page.getByRole('row').filter({hasText:'p0-browser.pdf'});await rows.getByRole('button',{name:'Completar',exact:true}).click();
      await page.getByRole('dialog',{name:'Revisar importación de contrato'}).waitFor();
      await page.screenshot({path:${JSON.stringify(path.join(artifacts,'new-review.png'))},fullPage:true});
    }`);
    assert.equal((await db.query('SELECT COUNT(*) n FROM contracts')).rows[0].n,'0','confirmar reanálisis no crea contrato');
    await invoke('04-recreate',`async page=>{${reviewScript}await confirmReview(page);}`);
    const current=(await db.query('SELECT * FROM contracts')).rows[0];assert.notEqual(current.id,first.id);
    assert.deepEqual((await db.query('SELECT id FROM persons UNION ALL SELECT id FROM properties ORDER BY id')).rows,entities);
    assert.equal((await db.query('SELECT COUNT(*) n FROM documents')).rows[0].n,'1');assert.equal((await db.query('SELECT COUNT(*) n FROM payments')).rows[0].n,'0');
    assert.deepEqual(fs.readdirSync(cwd).filter(f=>f.endsWith('.pdf')),['p0-browser.pdf']);
    const attempts=(await db.query('SELECT id,status,previous_import_id FROM imports ORDER BY created_at')).rows;assert.equal(attempts[1].previous_import_id,attempts[0].id);
    assert.deepEqual((await snapshot(current.id)).map(r=>({period:r.period,amount:r.expected_amount})),firstRows.map(r=>({period:r.period,amount:r.expected_amount})));
    // Seed an actual old-format contract and an independent blocked contract in the isolated database.
    async function legacy(code,blocked=false){
      const property=uid(),tenant=current.tenant_id,id=uid();await db.query("INSERT INTO properties(id,code,address,normalized_address,property_type,status) VALUES($1,$2,$2,$2,'Departamento','Alquilada')",[property,code]);
      await db.query("INSERT INTO contracts(id,code,property_id,tenant_id,rental_type,duration_months,start_date,end_date,initial_amount,currency,adjustment_index,adjustment_frequency_months,ipc_lag_months,ipc_clause_text) VALUES($1,$2,$3,$4,'Residencial',12,'2026-01-01','2026-12-31',500000,'ARS','IPC',3,1,'IPC trimestral con un mes de rezago.')",[id,code,property,tenant]);
      const client=await db.connect();try{await client.query('BEGIN');await generateInstallments(client,(await db.query('SELECT * FROM contracts WHERE id=$1',[id])).rows[0]);await client.query('COMMIT');}finally{client.release();}
      await db.query("UPDATE installments SET expected_amount=500000,contractual_amount=NULL,original_expected_amount=NULL,ipc_managed=false,calculation_hash=NULL,calculation_json='{}',adjustment_pending=false WHERE contract_id=$1",[id]);
      if(blocked)await db.query("DELETE FROM installments WHERE contract_id=$1 AND period='2026-02'",[id]);return id;
    }
    const old=await legacy('P0-ANTIGUO'),blocked=await legacy('P0-BLOQUEADO',true);
    const april=(await snapshot(old))[3];await db.query("INSERT INTO payments(id,installment_id,amount,paid_at) VALUES($1,$2,500000,'2026-04-10')",[uid(),april.id]);await db.query("UPDATE installments SET status='Pagado' WHERE id=$1",[april.id]);
    const paidBefore=(await db.query('SELECT * FROM payments ORDER BY id')).rows;
    await invoke('05-enroll',`async page=>{
      await page.goto(${JSON.stringify(base+'/#settings')});await page.getByRole('button',{name:'Simular conciliación',exact:true}).click();
      await page.getByRole('checkbox',{name:'Incorporar P0-ANTIGUO',exact:true}).waitFor();
      if(!await page.getByRole('checkbox',{name:'Incorporar P0-BLOQUEADO',exact:true}).isDisabled())throw new Error('El contrato bloqueado puede seleccionarse.');
      await page.getByRole('checkbox',{name:'Incorporar P0-ANTIGUO',exact:true}).check();
      await page.getByLabel('Motivo de la conciliación').fill('Incorporación histórica revisada en navegador');await page.getByRole('checkbox',{name:'Confirmar revisión de contratos seleccionados'}).check();
      await page.screenshot({path:${JSON.stringify(path.join(artifacts,'ipc-batch-preview.png'))},fullPage:true});
      await page.getByRole('button',{name:'Aplicar conciliación revisada'}).click();await page.getByText('1 contratos incorporados',{exact:false}).waitFor();
    }`);
    assert.ok((await snapshot(old)).every(r=>r.ipc_managed));assert.ok((await snapshot(blocked)).every(r=>!r.ipc_managed));assert.equal((await snapshot(old))[3].expected_amount,'547211.45');assert.deepEqual((await db.query('SELECT * FROM payments ORDER BY id')).rows,paidBefore);
    assert.equal((await reconcileInstallments(db,{contractId:old})).changed,0);
    const fixture=fs.readFileSync(path.join(__dirname,'fixtures','ipc-national-official.csv'),'utf8');
    const next=fixture.trim()+'\n0;NIVEL GENERAL;Nivel general y divisiones COICOP;202610;12800,0000;2,3;33,4;Nacional\n';
    const refreshed=await refreshAndUpdate(db,{force:true,fetchImpl:async()=>({ok:true,text:async()=>next}),now:new Date('2026-11-15T12:00:00Z')});assert.ok(refreshed.reconciliation.changed>0);
    assert.equal((await snapshot(current.id)).find(r=>r.period==='2026-11').adjustment_pending,false);assert.deepEqual((await db.query('SELECT * FROM payments ORDER BY id')).rows,paidBefore);
    // Real overdue + partial + paid installments must survive both browser actions verbatim.
    const statusRows=await snapshot(old);await db.query("UPDATE installments SET status='Vencido' WHERE id=$1",[statusRows[0].id]);
    await db.query("INSERT INTO payments(id,installment_id,amount,paid_at) VALUES($1,$2,100000,'2026-02-10'),($3,$4,500000,'2026-03-10')",[uid(),statusRows[1].id,uid(),statusRows[2].id]);
    await db.query("UPDATE installments SET status='Parcial' WHERE id=$1",[statusRows[1].id]);await db.query("UPDATE installments SET status='Pagado' WHERE id=$1",[statusRows[2].id]);
    const before=await snapshot(old),financial=(await db.query('SELECT * FROM payments ORDER BY id')).rows;
    await invoke('06-reactivate',`async page=>{
      const errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.goto(${JSON.stringify(base+'/#contracts?contract='+old)});
      const row=page.getByRole('row').filter({hasText:'P0-ANTIGUO'});await row.getByRole('button',{name:'Ver acciones'}).click();
      page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Desactivar temporalmente',exact:true}).click();await page.getByText('Contrato desactivado temporalmente.',{exact:false}).waitFor();
      await row.getByRole('button',{name:'Ver acciones'}).click();page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Volver a activar',exact:true}).click();await page.getByText('Contrato activado nuevamente.',{exact:false}).waitFor();
      await page.screenshot({path:${JSON.stringify(path.join(artifacts,'reactivated-contract.png'))},fullPage:true});if(errors.length)throw new Error(errors.join(';'));
    }`);
    assert.deepEqual(await snapshot(old),before);assert.deepEqual((await db.query('SELECT * FROM payments ORDER BY id')).rows,financial);
    await invoke('07-pending-dashboard',`async page=>{
      await page.goto(${JSON.stringify(base+'/#pending-collections?contract='+old)});await page.getByRole('heading',{name:'Cobros pendientes',exact:true,level:2}).waitFor();
      await page.screenshot({path:${JSON.stringify(path.join(artifacts,'pending-collections.png'))},fullPage:true});
      await page.goto(${JSON.stringify(base+'/#dashboard')});await page.getByRole('heading',{name:'Buen día',exact:true,level:2}).waitFor();
      await page.screenshot({path:${JSON.stringify(path.join(artifacts,'dashboard.png'))},fullPage:true});
      await page.setViewportSize({width:390,height:844});await page.goto(${JSON.stringify(base+'/#settings')});await page.getByRole('button',{name:'Simular conciliación',exact:true}).click();await page.getByRole('checkbox',{name:'Incorporar P0-ANTIGUO',exact:true}).waitFor();
      await page.screenshot({path:${JSON.stringify(path.join(artifacts,'ipc-mobile.png'))},fullPage:true});
    }`);
    fs.writeFileSync(path.join(artifacts,'evidence.json'),JSON.stringify({scenarios:4,legacyContracts:2,firstContract:first.id,reimportedContract:current.id,attempts,entitiesPreserved:true,pdfs:1,paymentsPreserved:true,reactivationPreserved:true,updatedAfterPublication:true},null,2));
  }finally{await run('close').catch(()=>{});await new Promise(r=>app.server.close(r));await db.end();}
});
