require('./require-isolated');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const crypto=require('node:crypto'),{uid}=require('../backend/src/database'),{createApp}=require('../backend/src/app');
const {pdf}=require('./support/p0-fixtures'),{choosePeriodSource}=require('./support/month-picker');
const QUOTE='Contrato original. Actualizacion por IPC cada tres meses. Canon inicial 500000 pesos.';
for(const browser of (process.env.P1_BROWSERS||process.env.UX_BROWSERS||'chrome').split(','))test(`P1 ${browser}: protección, rectificación y organización mensual`,async()=>{
  const cli=process.env.PLAYWRIGHT_CLI;assert.ok(cli&&fs.existsSync(cli),'Indicá PLAYWRIGHT_CLI.');
  const cwd=process.env.FERRARO_TEST_IMPORT_DIRECTORY,directory=path.join(cwd,`p1-files-${browser}`),out=path.join(__dirname,'..','tmp','p1-verification',browser);fs.mkdirSync(directory,{recursive:true});fs.mkdirSync(out,{recursive:true});
  const app=await createApp(),db=app.db;
  await db.query('TRUNCATE persons,properties,contracts,installments,payments,documents,imports,import_exclusions,audit_log,rent_adjustment_history RESTART IDENTITY CASCADE');await db.query("UPDATE settings SET value=$1 WHERE key='import_directory'",[directory]);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
  const post=async(route,input)=>{const r=await fetch(`${base}/api/${route}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}),body=await r.json();assert.ok(r.ok,JSON.stringify(body));return body;};
  const tenant=uid();await db.query("INSERT INTO persons(id,full_name) VALUES($1,'Inquilina de prueba mensual')",[tenant]);
  async function create(code,amount,currency='ARS'){
    const property=uid();await db.query("INSERT INTO properties(id,code,address,normalized_address,property_type) VALUES($1,$2,$2,$2,'Departamento')",[property,code]);
    return(await post('contracts',{code,property_id:property,tenant_id:tenant,rental_type:'Residencial',duration_months:18,start_date:'2026-01-01',initial_amount:amount,currency,management_fee_pct:3,adjustment_type:'IPC',adjustment_index:'IPC',adjustment_frequency_months:4,ipc_lag_months:0,payment_due_day:10})).id;
  }
  const a=await create('P1-A',500000),b=await create('P1-B',1000),usd=await create('P1-USD',100,'USD');
  const bytes=pdf(QUOTE),file=path.join(directory,'original-p1.pdf'),document=uid();fs.writeFileSync(file,bytes);await db.query('INSERT INTO documents(id,filename,absolute_path,sha256,contract_id) VALUES($1,$2,$3,$4,$5)',[document,'original-p1.pdf',file,crypto.createHash('sha256').update(bytes).digest('hex'),a]);await db.query('UPDATE contracts SET source_document_id=$1 WHERE id=$2',[document,a]);
  const may=(await db.query("SELECT id FROM installments WHERE contract_id=$1 AND period='2026-05'",[a])).rows[0].id;
  await post(`payments/${may}/register`,{amount:100000,paid_at:'2026-05-05'});
  await db.query("UPDATE installments SET due_date='2026-06-12' WHERE id=$1",[may]);
  await db.query("UPDATE installments SET due_date='2025-12-20' WHERE contract_id=$1 AND period='2026-01'",[b]);
  const rows=await fetch(`${base}/api/pending-collections`).then(r=>r.json());const mayRows=rows.filter(r=>r.period==='2026-05');
  const {totalsByCurrency}=await import('../frontend/src/utils/periods.mjs');const mayTotals=totalsByCurrency(mayRows);assert.equal(mayTotals.length,2);
  const snapshot=async()=>({installments:(await db.query('SELECT * FROM installments ORDER BY id')).rows,payments:(await db.query('SELECT * FROM payments ORDER BY id')).rows,ledger:(await db.query('SELECT * FROM ledger_entries ORDER BY id')).rows,history:(await db.query('SELECT * FROM rent_adjustment_history ORDER BY id')).rows});
  const before=await snapshot(),run=async(...args)=>{const result=await promisify(execFile)(process.execPath,[cli,`-s=ferraro-p1-${browser}`,...args],{cwd,timeout:60000,maxBuffer:4000000}).catch(e=>{throw new Error([e.message,e.stdout,e.stderr].join('\n'));});assert.doesNotMatch(result.stdout,/### Error/,result.stdout);return result.stdout;};
  async function invoke(name,script){const filename=path.join(cwd,`p1-${browser}-${name}.js`);fs.writeFileSync(filename,script);try{fs.writeFileSync(path.join(out,name+'.txt'),await run('run-code','--filename='+filename));}catch(e){fs.writeFileSync(path.join(out,name+'-failure.txt'),await run('snapshot').catch(e=>e.message));await run('screenshot','--filename='+path.join(out,name+'-failure.png')).catch(()=>{});throw e;}}
  try{
    await run('open',base+'/#pending-collections',`--browser=${browser}`);
    await invoke('monthly',`async page=>{
      ${choosePeriodSource}
      await page.setViewportSize({width:1440,height:1000});await page.emulateMedia({reducedMotion:'reduce'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.goto(${JSON.stringify(base+'/#pending-collections')});await page.locator('[data-installment-id]').first().waitFor();
      if(await page.locator('.pending-table').count()!==1)throw new Error('Se duplicó la tabla por mes.');
      const periods=await page.locator('[data-period-group]').evaluateAll(elements=>elements.map(el=>el.dataset.periodGroup));if(JSON.stringify(periods)!==JSON.stringify([...periods].sort()))throw new Error('Meses fuera de orden.');
      const ids=await page.locator('[data-installment-id]').evaluateAll(elements=>elements.map(el=>el.dataset.installmentId));if(ids.length!==${rows.length}||new Set(ids).size!==ids.length)throw new Error('Se duplicaron o perdieron cuotas.');
      if(await page.locator('input[type=month]').count())throw new Error('Permanece el control mensual del sistema operativo.');
      await page.screenshot({path:${JSON.stringify(path.join(out,'all-months-desktop.png'))},fullPage:true});
      await choosePeriod(page,'2026-05');if(await page.locator('[data-period-group]').count()!==1||await page.locator('[data-installment-id]').count()!==3)throw new Error('Filtro de mayo incorrecto.');
      const group=page.locator('[data-period-group="2026-05"]');
      for(const total of ${JSON.stringify(mayTotals)}){const text=await group.locator('.pending-month-totals').innerText();const formatted=new Intl.NumberFormat('es-AR',{style:'currency',currency:total.currency,minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(total.amount));if(!text.includes(total.currency)||!text.includes(formatted))throw new Error('Subtotal incorrecto o monedas mezcladas: '+text);}
const cross=group.locator('[data-installment-id="'+${JSON.stringify(may)}+'"]');await cross.waitFor();if((await cross.locator('td').first().innerText()).trim()!=='12/06/26')throw new Error('La cuota no conserva su vencimiento diferente.');
      await page.getByLabel('Elegir contrato:').selectOption(${JSON.stringify(a)});if(await page.locator('[data-installment-id]').count()!==1)throw new Error('No se combinan contrato y mes.');
      await page.getByRole('button',{name:'Escanear contratos',exact:true}).click();await page.getByRole('button',{name:'Escanear contratos',exact:true}).waitFor();await page.locator('[data-period-group="2026-05"]').waitFor();
      if(await page.getByLabel('Elegir contrato:').inputValue()!==${JSON.stringify(a)})throw new Error('Se perdió el contrato al recargar.');
      await page.getByRole('button',{name:'Filtrar por mes de cobro:',exact:false}).click();let picker=page.getByRole('dialog',{name:'Elegir mes y año'});await picker.getByLabel('Año del período').fill('2027');await picker.getByRole('button',{name:'Año siguiente',exact:true}).click();if(await picker.getByLabel('Año del período').inputValue()!=='2028')throw new Error('No cambia de año.');await picker.getByRole('button',{name:'Año anterior',exact:true}).click();
      await page.screenshot({path:${JSON.stringify(path.join(out,'month-year-picker.png'))},fullPage:true});await picker.locator('[data-period="2027-01"]').click();await page.locator('[data-period-group="2027-01"]').waitFor();
      await page.getByRole('button',{name:'Filtrar por mes de cobro:',exact:false}).click();picker=page.getByRole('dialog',{name:'Elegir mes y año'});await picker.locator('[data-period="2027-01"]').focus();await page.keyboard.press('PageDown');await page.keyboard.press('ArrowRight');await page.keyboard.press('Enter');
      await page.getByRole('button',{name:'Filtrar por mes de cobro: Febrero de 2028',exact:true}).waitFor();if(await page.locator('[data-installment-id]').count())throw new Error('Se filtró por vencimiento en vez de período.');
      await choosePeriod(page,'');if(await page.locator('[data-period-group]').count()<2)throw new Error('No restaura todos los meses.');
      await choosePeriod(page,'2026-05');
      const row=page.locator('[data-installment-id="'+${JSON.stringify(may)}+'"]');await row.getByRole('button',{name:'Ver detalle del alquiler',exact:false}).click();let dialog=page.getByRole('dialog',{name:'Detalle del alquiler',exact:false});await dialog.waitFor();await dialog.press('Escape');
      for(const label of ['Editar alquiler','Editar IVA','Editar punitorios','Editar descuento','Editar pago parcial']){await row.getByRole('button',{name:label,exact:true}).click();dialog=page.getByRole('dialog').filter({visible:true});await dialog.getByRole('button',{name:'Cancelar',exact:true}).click();}
      await row.getByRole('button',{name:'+ Agregar nota',exact:true}).click();dialog=page.getByRole('dialog').filter({visible:true});await dialog.getByRole('button',{name:'Cancelar',exact:true}).click();
await row.getByRole('button',{name:'Cobrar',exact:true}).click();dialog=page.getByRole('dialog',{name:'Nuevo cobro',exact:true});await dialog.getByRole('button',{name:'Cancelar',exact:true}).click();
      await row.getByRole('button',{name:'Liquidación',exact:true}).click();dialog=page.getByRole('dialog',{name:'Liquidación inquilino',exact:true});await dialog.press('Escape');
      await page.setViewportSize({width:390,height:844});await page.locator('.pending-scroll').first().evaluate(el=>{el.scrollLeft=0;});await page.getByRole('button',{name:'Filtrar por mes de cobro:',exact:false}).click();picker=page.getByRole('dialog',{name:'Elegir mes y año'});if((await picker.boundingBox()).width>390)throw new Error('El selector desborda el celular.');await page.screenshot({path:${JSON.stringify(path.join(out,'month-picker-mobile.png'))},fullPage:true});await picker.press('Escape');await page.screenshot({path:${JSON.stringify(path.join(out,'month-group-mobile.png'))},fullPage:true});
      if(errors.length)throw new Error(errors.join('; '));
    }`);
    assert.deepEqual(await snapshot(),before,'agrupar, filtrar y consultar no escribe información financiera');
    await invoke('administrative',`async page=>{
      await page.setViewportSize({width:1440,height:1000});await page.goto(${JSON.stringify(base+'/#contracts?contract='+a)});const row=page.getByRole('row').filter({hasText:'P1-A'});await row.getByRole('button',{name:'Ver acciones'}).click();await page.getByRole('button',{name:'Editar contrato',exact:true}).click();
      const dialog=page.getByRole('dialog',{name:'Editar contrato',exact:true});await dialog.getByRole('heading',{name:'Condiciones del contrato original'}).waitFor();if(await dialog.locator('select,input[name="initial_amount"],input[name="payment_due_day"]').count())throw new Error('Hay controles contractuales editables.');await dialog.getByRole('link',{name:'Consultar PDF original'}).waitFor();await dialog.getByLabel('Alias interno').fill('Identificador administrativo P1');await dialog.getByLabel('Nota administrativa').fill('Control de carpeta realizado.');await page.screenshot({path:${JSON.stringify(path.join(out,'protected-administrative-form.png'))},fullPage:true});await dialog.getByRole('button',{name:'Guardar datos administrativos'}).click();await dialog.waitFor({state:'hidden'});
    }`);
    assert.deepEqual(await snapshot(),before);
    await invoke('rectification-preview',`async page=>{
      await page.getByRole('row').filter({hasText:'P1-A'}).getByRole('button',{name:'Ver acciones'}).click();await page.getByRole('button',{name:'Rectificar datos del contrato',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Rectificar datos del contrato',exact:true});await dialog.getByLabel('Motivo de la rectificación').fill('El PDF indica aumentos trimestrales, no cuatrimestrales.');await dialog.getByLabel('Referencia a la cláusula y página del PDF original').fill('Cláusula de actualización, página 1');await dialog.getByLabel('Fragmento textual del contrato original').fill(${JSON.stringify(QUOTE)});await dialog.getByLabel('¿Cada cuánto aumenta el alquiler?').selectOption('3');await dialog.getByRole('button',{name:'Simular rectificación',exact:true}).click();await dialog.getByRole('heading',{name:'Comparación con los datos registrados'}).waitFor();await dialog.getByText('Frecuencia de aumentos',{exact:true}).waitFor();await page.screenshot({path:${JSON.stringify(path.join(out,'rectification-simulation.png'))},fullPage:true});
    }`);
    assert.deepEqual(await snapshot(),before,'la simulación del navegador no confirma importes');
    await invoke('rectification-apply',`async page=>{const dialog=page.getByRole('dialog',{name:'Rectificar datos del contrato',exact:true});await dialog.getByRole('checkbox',{name:'Cotejé el documento original',exact:false}).check();await dialog.getByRole('button',{name:'Aplicar rectificación documentada'}).click();await dialog.waitFor({state:'hidden'});await page.getByText('Rectificación documental registrada.',{exact:false}).waitFor();}`);
    const after=await snapshot();assert.deepEqual(after.payments,before.payments);assert.deepEqual(after.ledger,before.ledger);assert.equal((await db.query('SELECT adjustment_frequency_months FROM contracts WHERE id=$1',[a])).rows[0].adjustment_frequency_months,3);assert.equal((await db.query("SELECT COUNT(*) n FROM audit_log WHERE action='contract_rectified' AND entity_id=$1",[a])).rows[0].n,'1');assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),crypto.createHash('sha256').update(bytes).digest('hex'));
    fs.writeFileSync(path.join(out,'evidence.json'),JSON.stringify({browser,monthlyGroups:true,uniqueInstallments:rows.length,mixedCurrencyTotals:mayTotals,keyboard:true,mobile:true,filtersSurviveReload:true,readOnlyContract:true,documentedRectification:true,simulationReadOnly:true,paymentsPreserved:true},null,2));
  }finally{await run('close').catch(()=>{});await new Promise(r=>app.server.close(r));await db.end();fs.rmSync(directory,{recursive:true,force:true});}
});
