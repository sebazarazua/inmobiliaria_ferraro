require('./require-isolated');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const {createApp}=require('../backend/src/app'),{uid}=require('../backend/src/database');
const {expenseOperation}=require('../backend/src/modules/services/expenses');
for(const browser of (process.env.UX_BROWSERS||'chrome').split(','))test(`Estabilización ${browser}: gastos por responsable, una sola obligación y sin desbordes`,async()=>{
  const app=await createApp(),db=app.db,cwd=process.env.FERRARO_TEST_IMPORT_DIRECTORY,out=path.join(__dirname,'../tmp/stabilization-verification',browser);fs.mkdirSync(out,{recursive:true});
  await db.query('TRUNCATE persons,properties,contracts,installments,payments,documents,ledger_entries,audit_log,expense_operations,service_operations RESTART IDENTITY CASCADE');
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`,person=uid(),property=uid();
  await db.query("INSERT INTO persons(id,full_name) VALUES($1,'Inquilina Sintética Estabilización')",[person]);
  await db.query("INSERT INTO properties(id,code,address,normalized_address) VALUES($1,'UI-ESTAB','Propiedad Sintética 789, dirección extensa para verificar distribución en pantalla','propiedad sintetica 789')",[property]);
  const r=await fetch(base+'/api/contracts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:'UI-ESTAB',property_id:property,tenant_id:person,rental_type:'Residencial',duration_months:12,start_date:'2025-01-01',initial_amount:100000,currency:'ARS',management_fee_pct:3,adjustment_index:'IPC',adjustment_type:'IPC',adjustment_frequency_months:24,payment_due_day:10,late_fee_type:'NONE'})});assert.equal(r.status,201);
  const contract=(await r.json()).id,installment=(await db.query("SELECT id FROM installments WHERE contract_id=$1 AND period='2025-09'",[contract])).rows[0].id;
  const expense=async patch=>{const input={request_id:uid(),operation:'create',entry_date:'2025-09-05',category:'Servicio',amount:'20000',currency:'ARS',property_id:property,contract_id:contract,installment_id:installment,reason:'Comprobante sintético',...patch};const preview=await expenseOperation(db,input);return expenseOperation(db,{...input,token:preview.token,confirm:true},{apply:true});};
  await expense({description:'Luz del propietario sintética',responsibility:'owner'});
  await expense({description:'Agua trasladada sintética',responsibility:'tenant',responsibility_confirmed:true,responsibility_reference:'Cláusula sintética de servicios'});
  const cli=process.env.PLAYWRIGHT_CLI;assert.ok(cli&&fs.existsSync(cli),'Indicá PLAYWRIGHT_CLI.');const session='stabilization-'+browser+'-'+process.pid;
  const run=async(...args)=>{const result=await promisify(execFile)(process.execPath,[cli,'-s='+session,...args],{cwd,timeout:120000,maxBuffer:2000000}).catch(e=>{throw new Error(`playwright-cli ${args[0]} falló:\n${String(e.stdout||'').slice(-3000)}\n${String(e.stderr||'').slice(-1000)}`);});assert.doesNotMatch(result.stdout,/### Error/,result.stdout);return result.stdout;};
  const script=path.join(cwd,session+'.js');
  try{
    await run('open',base+'/#services','--browser='+browser);
    fs.writeFileSync(script,`async page=>{
      const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.emulateMedia({reducedMotion:'reduce'});
      const noHorizontalScroll=async label=>{const o=await page.evaluate(()=>({doc:document.documentElement.scrollWidth,view:window.innerWidth}));if(o.doc>o.view+1)throw Error(label+': scroll horizontal de página '+JSON.stringify(o));};
      await page.setViewportSize({width:1366,height:768});await page.goto(${JSON.stringify(base+'/#services')});
      const owner=page.locator('[data-service-expense]',{hasText:'Luz del propietario sintética'}),tenant=page.locator('[data-service-expense]',{hasText:'Agua trasladada sintética'});
      await owner.first().waitFor();
      if(!(await owner.innerText()).includes('Propietario')||!(await owner.innerText()).includes('No genera deuda del inquilino'))throw Error('El gasto del propietario no muestra su responsable real.');
      const t=await tenant.first().innerText();if(!t.includes('Inquilino')||!/una sola obligación/i.test(t))throw Error('El gasto trasladado no explica su vínculo con el cargo: '+t);
      if(await page.getByRole('heading',{name:'Gastos de servicios del propietario o inmobiliaria'}).count())throw Error('Persiste el título engañoso.');
      await page.getByRole('heading',{name:'Cargos exigibles al inquilino'}).waitFor();await page.getByRole('heading',{name:'Gastos contables de servicios'}).waitFor();
      if(await page.locator('[data-registry-service]').count()!==1)throw Error('El gasto trasladado generó más de un cargo visible.');
      await page.getByRole('combobox',{name:'Filtrar gastos por responsable'}).selectOption('owner');
      if(await tenant.count())throw Error('El filtro por responsable no excluye al inquilino.');
      await page.getByRole('combobox',{name:'Filtrar gastos por responsable'}).selectOption('');
      await noHorizontalScroll('1366x768');await page.screenshot({path:${JSON.stringify(path.join(out,'services-1366.png'))},fullPage:true});
      await page.setViewportSize({width:390,height:844});await noHorizontalScroll('móvil');await page.screenshot({path:${JSON.stringify(path.join(out,'services-mobile.png'))},fullPage:true});
      if(errors.length)throw Error(errors.join('; '));
    }`);
    const output=await run('run-code','--filename='+script);fs.writeFileSync(path.join(out,'services.txt'),output);
  }finally{await run('close').catch(()=>{});fs.rmSync(script,{force:true});await new Promise(r=>app.server.close(r));await db.end();}
});
