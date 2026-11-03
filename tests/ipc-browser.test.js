require('./require-isolated');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const {openDatabase,uid}=require('../backend/src/database');
const {createApp}=require('../backend/src/app');
const {generateInstallments}=require('../backend/src/modules/rent');

test('navegador → simulación → conciliación → cobro → PostgreSQL',async()=>{
  const cli=process.env.PLAYWRIGHT_CLI||(process.platform==='win32'?path.join(process.env.APPDATA,'npm','node_modules','@playwright','cli','playwright-cli.js'):'');
  assert.ok(cli&&fs.existsSync(cli),'Indicá PLAYWRIGHT_CLI con la ruta de playwright-cli.js instalado.');
  const cwd=process.env.FERRARO_TEST_IMPORT_DIRECTORY,run=async(...args)=>{
    const result=await promisify(execFile)(process.execPath,[cli,'-s=ferraro-ipc-verification',...args],{cwd,windowsHide:true,timeout:60000,maxBuffer:2000000});
    assert.doesNotMatch(result.stdout,/### Error/,result.stdout);return result.stdout;
  };
  const db=await openDatabase();let app;
  try{
    const person=uid(),property=uid(),contract=uid();
    await db.query('INSERT INTO persons(id,full_name) VALUES($1,$2)',[person,'Inquilino navegador']);
    await db.query("INSERT INTO properties(id,code,address,normalized_address,property_type,status) VALUES($1,'BROWSER-IPC','Prueba navegador 123','prueba navegador 123','Departamento','Alquilada')",[property]);
    await db.query("INSERT INTO contracts(id,code,property_id,tenant_id,rental_type,duration_months,start_date,end_date,initial_amount,currency,adjustment_index,adjustment_frequency_months,ipc_lag_months,ipc_clause_text) VALUES($1,'BROWSER-IPC',$2,$3,'Residencial',6,'2026-01-01','2026-06-30',500000,'ARS','IPC',3,1,'Ajuste IPC trimestral con un mes de rezago.')",[contract,property,person]);
    const client=await db.connect();try{await client.query('BEGIN');await generateInstallments(client,(await client.query('SELECT * FROM contracts WHERE id=$1',[contract])).rows[0]);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    await db.query("UPDATE installments SET expected_amount=500000,original_expected_amount=NULL,contractual_amount=NULL,ipc_managed=false,calculation_hash=NULL,calculation_json='{}',adjustment_pending=false WHERE contract_id=$1",[contract]);
    const april=(await db.query("SELECT id FROM installments WHERE contract_id=$1 AND period='2026-04'",[contract])).rows[0].id;
    await db.query("INSERT INTO payments(id,installment_id,amount,paid_at) VALUES($1,$2,500000,'2026-04-10')",[uid(),april]);
    await db.query("UPDATE installments SET status='Pagado' WHERE id=$1",[april]);
    app=await createApp({db});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
    fs.mkdirSync(path.join(__dirname,'..','tmp'),{recursive:true});
    const screenshot=path.join(__dirname,'..','tmp','ipc-browser-settings.png');
    const script=path.join(cwd,'ipc-browser-flow.js');
    fs.writeFileSync(script,`async page => {
      const errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.goto(${JSON.stringify(base+'/#settings')});
      await page.getByRole('heading',{name:'IPC oficial y conciliación de alquileres'}).waitFor();
      await page.getByLabel('Contrato a conciliar').selectOption(${JSON.stringify(contract)});
      await page.getByRole('button',{name:'Simular conciliación',exact:true}).click();
      await page.getByText('6 cuotas examinadas',{exact:false}).waitFor();
      if(!await page.getByText('47.211,45',{exact:false}).first().isVisible())throw new Error('Falta diferencia histórica en la simulación.');
      await page.emulateMedia({reducedMotion:'reduce'});await page.evaluate(()=>window.scrollTo(0,0));
      await page.screenshot({path:${JSON.stringify(screenshot)},fullPage:true});
      await page.getByLabel('Motivo de la conciliación').fill('Verificación de navegador en base aislada');
      await page.getByRole('checkbox').check();
      await page.getByRole('button',{name:'Aplicar conciliación revisada'}).click();
      await page.getByText('Conciliación aplicada:',{exact:false}).waitFor();
      await page.goto(${JSON.stringify(base+'/#pending-collections')});
      await page.getByRole('heading',{name:'Cobros pendientes',exact:true}).waitFor();
      await page.getByLabel('Filtrar por mes de cobro').fill('2026-04');
      const row=page.getByRole('row').filter({hasText:'Prueba navegador 123'});
      await row.getByRole('button',{name:'Marcar como pagado'}).click();
      await page.getByRole('dialog',{name:'Nuevo cobro'}).waitFor();
      await page.getByRole('dialog').getByRole('button',{name:'Guardar',exact:true}).click();
      await page.getByText('Cobro registrado correctamente.').waitFor();
      if(errors.length)throw new Error(errors.join('; '));
      await page.setViewportSize({width:390,height:844});
      await page.goto(${JSON.stringify(base+'/#settings')});await page.reload();
      await page.getByRole('heading',{name:'IPC oficial y conciliación de alquileres'}).waitFor();
      await page.screenshot({path:${JSON.stringify(path.join(__dirname,'..','tmp','ipc-browser-mobile.png'))},fullPage:true});
      console.log(JSON.stringify({consoleErrors:errors,desktopScreenshot:${JSON.stringify(screenshot)}}));
    }`);
    await run('open',base+'/#settings','--browser=chrome');
    console.log(await run('run-code','--filename='+script));
    const row=(await db.query('SELECT * FROM installments WHERE id=$1',[april])).rows[0];assert.equal(row.expected_amount,'547211.45');assert.equal(row.original_expected_amount,'500000.00');assert.equal(row.status,'Pagado');
    const payments=(await db.query('SELECT amount FROM payments WHERE installment_id=$1 ORDER BY amount DESC',[april])).rows;assert.deepEqual(payments.map(p=>p.amount),['500000.00','47211.45']);
    const editScript=path.join(cwd,'ipc-browser-edit.js');
    fs.writeFileSync(editScript,`async page=>{
      await page.setViewportSize({width:1280,height:900});
      await page.goto(${JSON.stringify(base+'/#contracts')});
      const row=page.getByRole('row').filter({hasText:'BROWSER-IPC'});
      await row.getByRole('button',{name:'Ver acciones'}).click();
      await page.getByRole('button',{name:'Editar contrato',exact:true}).click();
      const dialog=page.getByRole('dialog',{name:'Editar contrato'});
      await dialog.getByLabel('Canon inicial').fill('600000');
      await dialog.getByRole('button',{name:'Simular cambios'}).click();
      await dialog.getByText('cuotas cambiarían.',{exact:false}).waitFor();
      await dialog.getByRole('checkbox').check();
      await dialog.getByRole('button',{name:'Confirmar cambios revisados'}).click();
      await page.getByText('Contrato y cuotas actualizados.').waitFor();
    }`);
    await run('run-code','--filename='+editScript);
    const changed=(await db.query('SELECT expected_amount,status FROM installments WHERE id=$1',[april])).rows[0];assert.equal(changed.expected_amount,'656653.74');assert.equal(changed.status,'Parcial');
    assert.deepEqual((await db.query('SELECT amount FROM payments WHERE installment_id=$1 ORDER BY amount DESC',[april])).rows,payments);
    const created=await fetch(`${base}/api/contracts`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:'BROWSER-PROVISIONAL',property_id:property,tenant_id:person,rental_type:'Residencial',duration_months:24,start_date:'2026-01-01',initial_amount:500000,currency:'ARS',adjustment_index:'IPC',adjustment_frequency_months:3,management_fee_pct:3})}).then(r=>r.json());
    const january=(await db.query("SELECT * FROM installments WHERE contract_id=$1 AND period='2027-01'",[created.id])).rows[0];
    const received=await fetch(`${base}/api/payments/${january.id}/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:january.expected_amount})}).then(r=>r.json());assert.equal(received.status,'Parcial');
    const pendingScript=path.join(cwd,'ipc-browser-provisional.js');
    fs.writeFileSync(pendingScript,`async page=>{
      await page.goto(${JSON.stringify(base+'/#pending-collections')});
      await page.getByLabel('Filtrar por mes de cobro').fill('2027-01');
      const button=page.getByRole('button',{name:'Esperando índice'});await button.waitFor();
      if(!await button.isDisabled())throw new Error('Un saldo provisional cero permite volver a cobrar el canon.');
    }`);
    await run('run-code','--filename='+pendingScript);
  }finally{await run('close').catch(()=>{});if(app)await new Promise(r=>app.server.close(r));await db.end();}
});
