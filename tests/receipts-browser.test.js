require('./require-isolated');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const {uid}=require('../backend/src/database'),{createApp}=require('../backend/src/app');
const {choosePeriodSource}=require('./support/month-picker');

for(const browser of (process.env.UX_BROWSERS||'chrome').split(','))test(`Recibos ${browser}: pago, PDF, descarga e historial`,async t=>{
  const cli=process.env.PLAYWRIGHT_CLI;assert.ok(cli&&fs.existsSync(cli),'Indicá PLAYWRIGHT_CLI.');
  const cwd=process.env.FERRARO_TEST_IMPORT_DIRECTORY,out=path.join(__dirname,'..','tmp','receipts-verification',browser);fs.mkdirSync(out,{recursive:true});
  const app=await createApp(),db=app.db;
  await db.query('TRUNCATE persons,properties,contracts,installments,payments,documents,imports,audit_log,payment_requests RESTART IDENTITY CASCADE');
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const post=async(route,input)=>{const r=await fetch(`${base}/api/${route}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});const body=await r.json();assert.equal(r.status,201,JSON.stringify(body));return body;};
  const tenant=uid(),property=uid();await db.query("INSERT INTO persons(id,full_name) VALUES($1,'Inquilino de prueba recibo')",[tenant]);
  await db.query("INSERT INTO properties(id,code,address,normalized_address,property_type) VALUES($1,'R-BROWSER','Calle de prueba 120','calle de prueba 120','Departamento')",[property]);
  const start=new Date().toISOString().slice(0,7)+'-01';
  const contract=(await post('contracts',{code:'R-BROWSER',property_id:property,tenant_id:tenant,rental_type:'Residencial',duration_months:12,start_date:start,initial_amount:100000,currency:'ARS',management_fee_pct:3,payment_due_day:10})).id;
  const installment=(await db.query('SELECT id,period FROM installments WHERE contract_id=$1 ORDER BY period LIMIT 1',[contract])).rows[0];
  const run=async(...args)=>{const r=await promisify(execFile)(process.execPath,[cli,`-s=ferraro-receipts-${browser}`,...args],{cwd,timeout:90000,maxBuffer:4000000}).catch(e=>{throw new Error([e.message,e.stdout,e.stderr].join('\n'));});assert.doesNotMatch(r.stdout,/### Error/,r.stdout);return r.stdout;};
  const filename=path.join(cwd,`receipts-${browser}-flow.js`);
  try{
    await run('open',base+'/#pending-collections',`--browser=${browser}`);
    fs.writeFileSync(filename,`async page=>{
      ${choosePeriodSource}
      await page.setViewportSize({width:1440,height:1000});await page.emulateMedia({reducedMotion:'reduce'});
      const errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.goto(${JSON.stringify(base+'/#pending-collections')});await choosePeriod(page,${JSON.stringify(installment.period)});
      const row=page.locator('[data-installment-id="'+${JSON.stringify(installment.id)}+'"]');await row.getByRole('button',{name:'Cobrar',exact:true}).click();
      const pay=page.getByRole('dialog',{name:'Nuevo cobro',exact:true});await pay.getByRole('radio',{name:'Pago parcial',exact:true}).check();await pay.getByLabel('Importe *',{exact:true}).fill('25000.25');
      await pay.getByRole('button',{name:'Guardar',exact:true}).click();
      const success=page.getByRole('dialog',{name:'Cobro registrado'});await success.getByText('Comprobante N°',{exact:false}).waitFor();
      const href=await success.getByRole('link',{name:'Ver PDF'}).getAttribute('href');const pdf=await page.request.get(new URL(href,page.url()).href);
      if(pdf.status()!==200||!(await pdf.body()).subarray(0,5).equals(Buffer.from('%PDF-')))throw new Error('El enlace no devolvió un PDF válido.');
      const downloadPromise=page.waitForEvent('download');await success.getByRole('link',{name:'Descargar'}).click();const download=await downloadPromise;
      if(!download.suggestedFilename().endsWith('.pdf'))throw new Error('La descarga no es PDF.');
      await download.saveAs(${JSON.stringify(path.join(out,'recibo-descargado.pdf'))});
      await page.screenshot({path:${JSON.stringify(path.join(out,'recibo-despues-del-cobro.png'))},fullPage:true});
      await success.getByRole('button',{name:'Cerrar',exact:true}).last().click();
      await page.goto(${JSON.stringify(base+'/#collections')});const detail=page.getByRole('button',{name:'Detalle',exact:true}).first();await detail.click();
      const modal=page.getByRole('dialog',{name:'Detalle del cobro'});await modal.getByRole('link',{name:'Ver PDF'}).waitFor();
      const historyHref=await modal.getByRole('link',{name:'Ver PDF'}).getAttribute('href');if(historyHref!==href)throw new Error('El historial no recuperó el mismo recibo.');
      await page.screenshot({path:${JSON.stringify(path.join(out,'recibo-historial.png'))},fullPage:true});
      await page.setViewportSize({width:390,height:844});await modal.getByRole('link',{name:'Ver PDF'}).scrollIntoViewIfNeeded();await page.screenshot({path:${JSON.stringify(path.join(out,'recibo-movil.png'))},fullPage:true});
      if(errors.length)throw new Error(errors.join('; '));
    }`);
    try{await run('run-code','--filename='+filename);}catch(error){fs.writeFileSync(path.join(out,'failure-snapshot.txt'),await run('snapshot').catch(e=>e.message));await run('screenshot','--filename='+path.join(out,'failure.png')).catch(()=>{});throw error;}
    const n=await db.query('SELECT (SELECT COUNT(*)::int FROM payments) payments,(SELECT COUNT(*)::int FROM payment_receipts) receipts');assert.deepEqual(n.rows[0],{payments:1,receipts:1});
  }finally{fs.rmSync(filename,{force:true});await run('close').catch(()=>{});await new Promise(r=>app.server.close(r));await db.end();}
});
