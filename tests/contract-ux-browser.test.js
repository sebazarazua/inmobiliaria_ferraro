require('./require-isolated');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const {createApp}=require('../backend/src/app');
const {uid}=require('../backend/src/database');
const {pdf}=require('./support/p0-fixtures');

for(const browser of (process.env.UX_BROWSERS||'chrome').split(','))test(`UX en ${browser}: formularios, consulta de alquiler y tabla compacta`,async()=>{
  const cli=process.env.PLAYWRIGHT_CLI;assert.ok(cli&&fs.existsSync(cli),'Indicá PLAYWRIGHT_CLI.');
  const cwd=process.env.FERRARO_TEST_IMPORT_DIRECTORY,out=path.join(__dirname,'..','tmp','contract-ux',browser);fs.mkdirSync(out,{recursive:true});
  const session=`ferraro-ux-${browser}`,run=async(...args)=>{const r=await promisify(execFile)(process.execPath,[cli,`-s=${session}`,...args],{cwd,timeout:60000,maxBuffer:3000000}).catch(e=>{throw new Error([e.message,e.stdout,e.stderr].join('\n'));});assert.doesNotMatch(r.stdout,/### Error/,r.stdout);return r.stdout;};
  const fixtureDirectory=path.join(cwd,`ux-${browser}-files`);fs.mkdirSync(fixtureDirectory,{recursive:true});
  const app=await createApp(),db=app.db;await db.query('TRUNCATE persons,properties,contracts,installments,payments,documents,imports,import_exclusions,audit_log,rent_adjustment_history RESTART IDENTITY CASCADE');
  await db.query("UPDATE settings SET value=$1 WHERE key='import_directory'",[fixtureDirectory]);
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
  const post=async(route,body)=>{const res=await fetch(`${base}/api/${route}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const value=await res.json();assert.ok(res.ok,JSON.stringify(value));return value;};
  const tenant=uid();await db.query("INSERT INTO persons(id,full_name,document_number) VALUES($1,'Inquilina prueba UX','40900999')",[tenant]);
  async function create(code,extra={}){const property=uid();await db.query("INSERT INTO properties(id,code,address,normalized_address,property_type) VALUES($1,$2,$2,$2,'Departamento')",[property,code]);return(await post('contracts',{code,property_id:property,tenant_id:tenant,rental_type:'Residencial',duration_months:24,start_date:'2026-01-01',initial_amount:500000,currency:'ARS',management_fee_pct:3,adjustment_frequency_months:3,adjustment_type:'IPC',adjustment_index:'IPC',ipc_lag_months:0,payment_due_day:10,...extra})).id;}
  const ipc=await create('UX-IPC'),legacy=await create('UX-HISTORICO'),manual=await create('UX-FIJO',{adjustment_type:'FIXED_PERCENTAGE',adjustment_index:null,adjustment_value_pct:12.5,adjustment_frequency_months:5,payment_period_start_day:5,payment_period_end_day:12,payment_due_day:10,notes:'Aumento fijo contractual, sin automatización.'});
  await db.query("UPDATE installments SET ipc_managed=false,calculation_json='{}',calculation_hash=NULL,contractual_amount=NULL WHERE contract_id=$1",[legacy]);
  const april=(await db.query("SELECT id FROM installments WHERE contract_id=$1 AND period='2026-04'",[ipc])).rows[0].id;
  await post(`payments/${april}/register`,{amount:100000,paid_at:'2026-04-10'});
  const july=(await db.query("SELECT id FROM installments WHERE contract_id=$1 AND period='2026-07'",[ipc])).rows[0].id;
  await db.query('UPDATE installments SET rent_override_amount=550000,expected_amount=550000 WHERE id=$1',[july]);
  const draft=uid();await db.query("INSERT INTO imports(id,filename,absolute_path,sha256,status,result_json) VALUES($1,'ux-review.pdf',$2,$3,'Revisión',$4)",[draft,path.join(fixtureDirectory,'ux-review.pdf'),'a'.repeat(64),JSON.stringify({parsed:{address:'Prueba UI 10',owners:[{fullName:'Propietaria Prueba',documentNumber:'20900111'}],tenant:{fullName:'Inquilina Prueba',documentNumber:'40900222'},startDate:'2026-01-01',endDate:'2027-12-31',durationMonths:24,initialAmount:500000,currency:'ARS',adjustmentType:'IPC',adjustmentIndex:'IPC',adjustmentFrequencyMonths:3,ipcLagMonths:0,paymentPeriodStartDay:5,paymentPeriodEndDay:12,paymentDueDay:10,lateFee:{type:'FIXED_DAILY',dailyPercentage:0.5},guarantee:{type:'Sin garantía',provider:'Respaldar'}},blocking_fields:[],entity_resolution:{}})]);
  fs.writeFileSync(path.join(fixtureDirectory,'ux-review.pdf'),pdf());
  const snapshot=async()=>({installments:(await db.query('SELECT * FROM installments WHERE contract_id=ANY($1::uuid[]) ORDER BY id',[[ipc,legacy,manual]])).rows,payments:(await db.query('SELECT * FROM payments ORDER BY id')).rows,history:(await db.query('SELECT * FROM rent_adjustment_history ORDER BY id')).rows});
  const before=await snapshot();
  async function invoke(name,code){const file=path.join(cwd,`ux-${browser}-${name}.js`);fs.writeFileSync(file,code);try{const output=await run('run-code','--filename='+file);fs.writeFileSync(path.join(out,name+'.txt'),output);}catch(e){fs.writeFileSync(path.join(out,name+'-failure.txt'),await run('snapshot').catch(err=>err.message));await run('screenshot','--filename='+path.join(out,name+'-failure.png')).catch(()=>{});throw e;}}
  try{
    await run('open',base+'/#imports',`--browser=${browser}`);
    await invoke('forms',`async page=>{
      await page.emulateMedia({reducedMotion:'reduce'});await page.setViewportSize({width:1365,height:960});
      const errors=[];page.on('pageerror',e=>errors.push(e.message));let captured;
      await page.route('**/api/imports/*/complete',async route=>{captured=route.request().postDataJSON();await route.fulfill({status:200,contentType:'application/json',body:'{"status":"Procesado"}'});});
      await page.goto(${JSON.stringify(base+'/#imports')});
      async function open(){await page.getByRole('row').filter({hasText:'ux-review.pdf'}).getByRole('button',{name:'Revisar',exact:true}).click();return page.getByRole('dialog',{name:'Revisar importación de contrato'});}
      const dialog=await open();
      const method=dialog.getByLabel('¿Cómo se actualiza el alquiler?',{exact:true});
      const labels=await method.locator('option').allTextContents();if(labels.some(x=>/FIXED_|CUSTOM_|MANUAL|NONE|BANK_ACTIVE_RATE/.test(x)))throw new Error('Hay constantes visibles.');
      if(await dialog.locator('[name="ipc_lag_months"]').count()!==1)throw new Error('Rezago duplicado.');
      if(await dialog.getByLabel('¿Qué mes del IPC se utiliza para calcular el aumento?').inputValue()!=='0')throw new Error('Se perdió el rezago antiguo 0.');
      const delay=dialog.getByLabel('¿Cómo se calculan los intereses por demora?');
      await delay.selectOption('BANK_ACTIVE_RATE');if(await dialog.getByLabel('Interés diario (%)',{exact:true}).count())throw new Error('Banco Nación muestra porcentaje fijo.');
      await delay.selectOption('FIXED_DAILY');await dialog.getByLabel('Interés diario (%)',{exact:true}).waitFor();
      await method.selectOption('FIXED_PERCENTAGE');if(await dialog.locator('[name="ipc_lag_months"]').count())throw new Error('Rezago visible sin IPC.');
      await dialog.getByLabel('Porcentaje de aumento (%)').fill('12.5');
      await dialog.getByLabel('¿Cada cuánto aumenta el alquiler?').selectOption('other');await dialog.getByLabel('Cantidad de meses entre aumentos').fill('5');
      await dialog.getByRole('heading',{name:'6. Ajustes y vencimiento'}).evaluate(el=>el.scrollIntoView({block:'start'}));
      await page.screenshot({path:${JSON.stringify(path.join(out,'review-fixed.png'))},fullPage:true});
      await dialog.getByRole('button',{name:'Confirmar y crear contrato'}).click();await dialog.waitFor({state:'hidden'});
      if(captured.adjustment_type!=='FIXED_PERCENTAGE'||captured.adjustment_index!==null||captured.adjustment_frequency_months!=='5'||captured.payment_period_start_day!==5||captured.payment_period_end_day!==12||captured.payment_due_day!==10||captured.ipc_lag_months!==0)throw new Error('La conversión alteró las condiciones: '+JSON.stringify(captured));
      const again=await open();await again.getByLabel('¿Cómo se actualiza el alquiler?').selectOption('ICL');if(await again.locator('[name="ipc_lag_months"]').count())throw new Error('ICL usa rezago IPC.');await again.getByText('Este mecanismo requiere intervención manual.',{exact:false}).waitFor();
      await again.getByLabel('¿Cómo se actualiza el alquiler?').selectOption('CAC');await again.getByText('Este mecanismo requiere intervención manual.',{exact:false}).waitFor();
      await again.getByLabel('¿Cómo se actualiza el alquiler?').selectOption('MANUAL');await again.getByLabel('Condiciones de actualización').fill('Acordar importes con las partes.');await again.getByLabel('¿Cada cuánto aumenta el alquiler?').selectOption('');if(await again.getByLabel('¿Cada cuánto aumenta el alquiler?').getAttribute('required')!==null)throw new Error('Se obliga a inventar una frecuencia manual.');
      await again.getByLabel('¿Cómo se actualiza el alquiler?').selectOption('CUSTOM_INDEX');await again.getByLabel('Nombre del índice o mecanismo').fill('Índice salarial contractual');
      await again.getByRole('button',{name:'Cancelar',exact:true}).click();
      await page.goto(${JSON.stringify(base+'/#contracts?contract='+manual)});await page.getByRole('row').filter({hasText:'UX-FIJO'}).getByRole('button',{name:'Ver acciones'}).click();await page.getByRole('button',{name:'Editar contrato',exact:true}).click();
      const edit=page.getByRole('dialog',{name:'Editar contrato'});await page.waitForFunction(()=>document.querySelector('dialog[open] select[name=rent_update_method]')?.value==='FIXED_PERCENTAGE');if(await edit.getByLabel('¿Cómo se actualiza el alquiler?').inputValue()!=='FIXED_PERCENTAGE')throw new Error('No reconoce el contrato anterior.');
      if(await edit.getByLabel('Porcentaje de aumento (%)').inputValue()!=='12.5')throw new Error('Se perdió el porcentaje anterior.');
      if(await edit.getByLabel('Día de vencimiento del alquiler',{exact:true}).inputValue()!=='10')throw new Error('Vencimiento alterado.');
      await edit.getByRole('button',{name:'Guardar cambios',exact:true}).click();await edit.waitFor({state:'hidden'});
      await page.getByRole('button',{name:'+ Agregar',exact:true}).click();const create=page.getByRole('dialog',{name:'Agregar contrato'});await create.getByLabel('¿Cómo se actualiza el alquiler?').selectOption('FIXED_PERCENTAGE');await create.getByLabel('Porcentaje de aumento (%)').fill('8.25');await create.getByLabel('¿Cada cuánto aumenta el alquiler?').selectOption('4');
      await page.screenshot({path:${JSON.stringify(path.join(out,'create-contract.png'))},fullPage:true});await create.getByRole('button',{name:'Cancelar',exact:true}).click();
      if(errors.length)throw new Error(errors.join('; '));
    }`);
    assert.deepEqual(await snapshot(),before,'formulario sin cambios económicos conserva cuotas, pagos e historial');
    await invoke('rent-details',`async page=>{
      const errors=[],external=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',req=>{if(!req.url().startsWith(${JSON.stringify(base)})&&['fetch','xhr'].includes(req.resourceType()))external.push(req.url());});
      async function period(contract,month){await page.goto(${JSON.stringify(base+'/#pending-collections?contract=')}+contract);await page.getByLabel('Elegir contrato:').selectOption(contract);await page.getByLabel('Filtrar por mes de cobro').fill(month);await page.getByRole('button',{name:'Ver detalle del alquiler',exact:false}).waitFor();}
      async function show(){const button=page.getByRole('button',{name:'Ver detalle del alquiler',exact:false});const row=button.locator('xpath=ancestor::tr');if(await row.locator('details').count())throw new Error('El detalle sigue dentro de la tabla.');const height=(await row.boundingBox()).height;await button.focus();await button.press('Enter');const dialog=page.getByRole('dialog',{name:'Detalle del alquiler',exact:false});await dialog.waitFor();return{dialog,button,row,height};}
      await period(${JSON.stringify(ipc)},'2026-04');let state=await show();await state.dialog.getByText('Versiones de este alquiler',{exact:true}).waitFor();await state.dialog.getByText('Coeficiente acumulado:',{exact:false}).waitFor();
      await state.dialog.getByText('Índices y fuente del cálculo',{exact:true}).click();await state.dialog.getByRole('link',{name:'Consultar fuente oficial'}).waitFor();
      await page.screenshot({path:${JSON.stringify(path.join(out,'rent-ipc-desktop.png'))},fullPage:true});await state.dialog.press('Escape');await state.dialog.waitFor({state:'hidden'});
      if(Math.abs((await state.row.boundingBox()).height-state.height)>1)throw new Error('Se expandió la fila.');
      if(!await state.button.evaluate(el=>el===document.activeElement))throw new Error('No volvió el foco al importe.');
      await page.getByRole('button',{name:'Editar alquiler',exact:true}).click();const edit=page.getByRole('dialog',{name:'Editar alquiler',exact:true});await edit.waitFor();await edit.getByRole('button',{name:'Cancelar',exact:true}).click();
      await period(${JSON.stringify(ipc)},'2026-07');state=await show();await state.dialog.getByText('Importe aplicado por corrección manual',{exact:true}).waitFor();await page.screenshot({path:${JSON.stringify(path.join(out,'rent-manual-override.png'))},fullPage:true});await state.dialog.getByRole('button',{name:'Cerrar',exact:true}).last().click();
      await period(${JSON.stringify(ipc)},'2027-01');state=await show();await state.dialog.getByText('El importe es provisional.',{exact:false}).waitFor();await page.screenshot({path:${JSON.stringify(path.join(out,'rent-provisional.png'))},fullPage:true});await state.dialog.press('Escape');
      await period(${JSON.stringify(legacy)},'2026-04');state=await show();await state.dialog.getByText('Este contrato histórico requiere conciliación.',{exact:false}).waitFor();await state.dialog.press('Escape');
      await period(${JSON.stringify(manual)},'2026-04');state=await show();await state.dialog.getByText('No se aplica el motor IPC',{exact:false}).waitFor();if(await state.dialog.getByText('Coeficiente acumulado:',{exact:false}).count())throw new Error('Inventó un cálculo IPC.');await state.dialog.press('Escape');
      await period(${JSON.stringify(ipc)},'2026-01');state=await show();await state.dialog.getByText('Próximo período de ajuste contractual: abril de 2026.',{exact:false}).waitFor();await state.dialog.press('Escape');
      await page.route('**/api/contracts/*/adjustments',route=>route.fulfill({status:500,contentType:'application/json',body:'{"error":"Fallo de prueba"}'}));
      state=await show();await state.dialog.getByText('No pudimos consultar las versiones del alquiler.',{exact:false}).waitFor();await state.dialog.getByRole('button',{name:'Reintentar consulta'}).waitFor();await state.dialog.press('Escape');await page.unroute('**/api/contracts/*/adjustments');
      await page.setViewportSize({width:390,height:844});await period(${JSON.stringify(ipc)},'2026-04');state=await show();await page.screenshot({path:${JSON.stringify(path.join(out,'rent-ipc-mobile.png'))},fullPage:true});
      if(await state.dialog.evaluate(el=>el.getBoundingClientRect().width>innerWidth))throw new Error('El modal desborda el celular.');await state.dialog.press('Escape');
      if(errors.length||external.length)throw new Error(JSON.stringify({errors,external}));
    }`);
    assert.deepEqual(await snapshot(),before,'consultar importes no cambia obligaciones, pagos ni versiones');
    const c=(await db.query('SELECT adjustment_type,adjustment_value_pct,payment_period_start_day,payment_period_end_day,payment_due_day FROM contracts WHERE id=$1',[manual])).rows[0];assert.equal(c.adjustment_type,'FIXED_PERCENTAGE');assert.equal(c.adjustment_value_pct,'12.500');assert.equal(c.payment_period_start_day,5);assert.equal(c.payment_period_end_day,12);assert.equal(c.payment_due_day,10);
    fs.writeFileSync(path.join(out,'evidence.json'),JSON.stringify({browser,forms:true,keyboard:true,compactTable:true,provisional:true,manual:true,legacy:true,nonIpc:true,failedHistoryHandled:true,externalDataRequests:0,financialSnapshotUnchanged:true},null,2));
  }finally{await run('close').catch(()=>{});await new Promise(r=>app.server.close(r));await db.end();fs.rmSync(fixtureDirectory,{recursive:true,force:true});}
});
