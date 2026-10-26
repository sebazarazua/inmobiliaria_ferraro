const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
process.env.WHATSAPP_APP_SECRET=process.env.WHATSAPP_APP_SECRET||'test-whatsapp-secret';
process.env.WHATSAPP_VERIFY_TOKEN=process.env.WHATSAPP_VERIFY_TOKEN||'test-verify-token';
const {openDatabase,uid}=require('../backend/src/database');
const {extractPdfText,parseContractText,scanImportDirectory,completeImportReview}=require('../backend/src/modules/imports/contract-parser');
const {createApp}=require('../backend/src/app');
const {triggerAutomation,generatePortalToken}=require('../backend/src/modules/whatsapp');
const {processClaimedEvent}=require('../backend/src/modules/whatsapp-gateway');

const sampleCandidates=[
  path.join(__dirname,'..','contratos','CONTRATO VIVIENDA. SOLIS 637 1° G CON SEGURO DNU 2024.pdf'),
  path.join(__dirname,'..','..','CONTRATO VIVIENDA. SOLIS 637 1° G  CON SEGURO DNU  2024.pdf')
];
const sample=sampleCandidates.find(file=>fs.existsSync(file))||sampleCandidates[0];
const count=async(db,table,where='')=>Number((await db.query(`SELECT COUNT(*) total FROM ${table} ${where}`)).rows[0].total);
async function reset(db){await db.query('TRUNCATE whatsapp_automation_events,whatsapp_outbound_jobs,whatsapp_messages,whatsapp_conversations,owner_portal_tokens,whatsapp_webhook_events,audit_log,imports,payments,installments,initial_payments,recurring_charges,contract_tenants,guarantees,contract_owners,documents,contracts,property_owners,incidents,ledger_entries,properties,persons RESTART IDENTITY CASCADE');}
async function insertProperty(db,address,code){const id=uid();await db.query('INSERT INTO properties(id,code,address,normalized_address,property_type,status) VALUES ($1,$2,$3,$4,$5,$6)',[id,code,address,address.toLowerCase(),'Departamento','Alquilada']);return id;}
async function insertContractWithDocument(db,{propertyId,tenantId,code,start,end,months,amount,sha,status='Activo',currency='ARS',deposit=null,installments=true}){
  const contractId=uid(),documentId=uid();
  await db.query('INSERT INTO documents(id,filename,absolute_path,sha256,property_id) VALUES ($1,$2,$3,$4,$5)',[documentId,`${code}.pdf`,path.join(os.tmpdir(),`${code}-${documentId}.pdf`),sha,propertyId]);
  await db.query(`INSERT INTO contracts(id,code,property_id,tenant_id,rental_type,duration_months,start_date,end_date,initial_amount,currency,payment_due_day,management_fee_pct,status,source_document_id,deposit_amount)
    VALUES ($1,$2,$3,$4,'Residencial',$5,$6,$7,$8,$9,10,3,$10,$11,$12)`,[contractId,code,propertyId,tenantId,months,start,end,amount,currency,status,documentId,deposit]);
  await db.query('UPDATE documents SET contract_id=$1 WHERE id=$2',[contractId,documentId]);
  if(installments)for(let index=0;index<months;index++){const [year,month]=start.split('-').map(Number),date=new Date(Date.UTC(year,month-1+index,1)),period=date.toISOString().slice(0,7);await db.query('INSERT INTO installments(id,contract_id,period,due_date,expected_amount,currency) VALUES ($1,$2,$3,$4,$5,$6)',[uid(),contractId,period,`${period}-10`,amount,currency]);}
  return{contractId,documentId};
}
function signedBody(payload){const raw=JSON.stringify(payload);return{raw,signature:`sha256=${crypto.createHmac('sha256',process.env.WHATSAPP_APP_SECRET).update(raw).digest('hex')}`};}

test('extrae correctamente los datos centrales del contrato real',async()=>{
  const parsed=parseContractText(await extractPdfText(sample),path.basename(sample));
  assert.equal(parsed.address,'Solis 637 1° “G”');assert.equal(parsed.durationMonths,12);assert.equal(parsed.startDate,'2026-06-01');assert.equal(parsed.endDate,'2027-05-31');assert.equal(parsed.initialAmount,420000);assert.equal(parsed.adjustmentFrequencyMonths,4);assert.equal(parsed.adjustmentIndex,'IPC');assert.equal(parsed.owners.length,2);assert.equal(parsed.tenant.documentNumber,'95969660');assert.equal(parsed.cbu,'0340010408022000515001');assert.ok(parsed.warnings.some(warning=>warning.includes('2024')));
});

test('PostgreSQL crea relaciones y evita duplicados por hash',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ferraro-import-')),db=await openDatabase();
  t.after(async()=>{await db.query("UPDATE settings SET value=$1 WHERE key='import_directory'",[path.join(__dirname,'..','contratos')]);await db.end();fs.rmSync(directory,{recursive:true,force:true});});await reset(db);
  fs.copyFileSync(sample,path.join(directory,path.basename(sample)));await db.query("UPDATE settings SET value=$1 WHERE key='import_directory'",[directory]);await db.query("UPDATE settings SET value='3' WHERE key='default_management_fee_pct'");
  const first=await scanImportDirectory(db),second=await scanImportDirectory(db);
  assert.equal(first.imported,1);assert.equal(second.imported,0);assert.equal(await count(db,'imports'),1);assert.equal(await count(db,'contracts'),0);
  const importRow=(await db.query('SELECT id,status,result_json FROM imports LIMIT 1')).rows[0];assert.equal(importRow.status,'Revisión');assert.equal(importRow.result_json.kind,'CONTRACT_IMPORT');assert.equal(importRow.result_json.stage,'DRAFT');
  await completeImportReview(db,importRow.id,{});
  assert.equal(await count(db,'contracts'),1);assert.equal(await count(db,'properties'),1);assert.ok(await count(db,'persons')>=3);assert.equal(await count(db,'installments'),12);assert.equal(await count(db,'installments','WHERE expected_amount=420000'),12);
  const contract=(await db.query('SELECT management_fee_pct::float,status FROM contracts')).rows[0];assert.equal(contract.management_fee_pct,3);assert.equal(contract.status,'Revisión');
});

test('upload de contrato guarda el PDF en la carpeta persistente de contratos',async t=>{
  const app=await createApp();await reset(app.db);await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ferraro-upload-'));
  t.after(async()=>{await app.db.query("UPDATE settings SET value=$1 WHERE key='import_directory'",[path.join(__dirname,'..','contratos')]);await new Promise(resolve=>app.server.close(resolve));await app.db.end();fs.rmSync(directory,{recursive:true,force:true});});
  await app.db.query("UPDATE settings SET value=$1 WHERE key='import_directory'",[directory]);
  const form=new FormData();
  form.append('file',new Blob([fs.readFileSync(sample)],{type:'application/pdf'}),'contrato subido.pdf');
  const response=await fetch(`http://127.0.0.1:${app.server.address().port}/api/imports/upload`,{method:'POST',body:form});
  assert.equal(response.status,201);
  const body=await response.json();
  assert.equal(path.dirname(body.storedPath),directory);
  assert.equal(path.basename(body.storedPath),'contrato subido.pdf');
  assert.equal(fs.existsSync(body.storedPath),true);
  const row=(await app.db.query('SELECT absolute_path FROM imports LIMIT 1')).rows[0];
  assert.equal(row.absolute_path,body.storedPath);
});

test('al completar una importación manual limpia faltantes y actualiza el estado',async t=>{
  const db=await openDatabase();
  t.after(async()=>{await db.end();});
  await reset(db);
  await db.query("UPDATE settings SET value='3' WHERE key='default_management_fee_pct'");
  const importId=uid(),sha='1'.repeat(64);
  await db.query(
    'INSERT INTO imports(id,filename,absolute_path,sha256,status,confidence,warnings_json,result_json,error_message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      importId,
      'contrato-test.pdf',
      path.join(os.tmpdir(),'contrato-test.pdf'),
      sha,
      'Revisión',
      0.45,
      JSON.stringify(['Falta dirección del inmueble.']),
      JSON.stringify({
        parsed: { filename: 'contrato-test.pdf', warnings: ['Observación documental'] },
        missing_fields: [{ key: 'address', label: 'Dirección', message: 'Falta dirección del inmueble.' }],
        extracted_text: ''
      }),
      'Faltan completar: Dirección'
    ]
  );
  const response=await completeImportReview(db,importId,{
    address:'Solis 637 1 G',
    property_type:'Departamento',
    rental_type:'Residencial',
    owner_full_name:'Juan Propietario',
    owner_document_number:'20111111112',
    tenant_full_name:'Ana Inquilina',
    tenant_document_number:'30222222223',
    start_date:'2026-06-01',
    end_date:'2027-05-31',
    duration_months:'12',
    initial_amount:'420000',
    deposit_amount:'420000',
    currency:'ARS',
    adjustment_frequency_months:'4',
    adjustment_index:'IPC',
    payment_due_day:'10',
    bank_name:'Banco Patagonia',
    cbu:'0340010408022000515001',
    guarantee_type:'Seguro de caución',
    guarantee_provider:'Respaldar',
    guarantee_provider_detail:'Póliza a confirmar'
  });
  assert.equal(response.status,'Procesado');
  const row=(await db.query('SELECT status,error_message,result_json FROM imports WHERE id=$1',[importId])).rows[0];
  assert.equal(row.status,'Procesado');
  assert.equal(row.error_message,null);
  assert.deepEqual(row.result_json.missing_fields,[]);
  assert.deepEqual(row.result_json.parsed.missingFields,[]);
  assert.equal(await count(db,'contracts'),1);
});

test('descarta y revierte importaciones sin borrar historial contable',async t=>{
  const app=await createApp();await reset(app.db);await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ferraro-revert-'));
  t.after(async()=>{await app.db.query("UPDATE settings SET value=$1 WHERE key='import_directory'",[path.join(__dirname,'..','contratos')]);await new Promise(resolve=>app.server.close(resolve));await app.db.end();fs.rmSync(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  await app.db.query("UPDATE settings SET value='3' WHERE key='default_management_fee_pct'");
  await app.db.query("UPDATE settings SET value=$1 WHERE key='import_directory'",[directory]);

  fs.copyFileSync(sample,path.join(directory,path.basename(sample)));
  await scanImportDirectory(app.db);
  let importRow=(await app.db.query('SELECT id,status FROM imports LIMIT 1')).rows[0];
  const discard=await fetch(`${base}/api/imports/${importRow.id}/discard`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason:'Archivo equivocado'})});
  assert.equal(discard.status,200);
  assert.equal((await app.db.query('SELECT status FROM imports WHERE id=$1',[importRow.id])).rows[0].status,'Descartado');
  assert.equal(await count(app.db,'contracts'),0);
  await scanImportDirectory(app.db);
  assert.equal(await count(app.db,'imports'),1);
  assert.equal((await app.db.query('SELECT status FROM imports WHERE id=$1',[importRow.id])).rows[0].status,'Descartado');

  await reset(app.db);
  await app.db.query("UPDATE settings SET value='3' WHERE key='default_management_fee_pct'");
  await app.db.query("UPDATE settings SET value=$1 WHERE key='import_directory'",[directory]);
  await scanImportDirectory(app.db);
  importRow=(await app.db.query('SELECT id FROM imports LIMIT 1')).rows[0];
  await completeImportReview(app.db,importRow.id,{});
  assert.equal(await count(app.db,'contracts'),1);
  const revert=await fetch(`${base}/api/imports/${importRow.id}/revert`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason:'Subido por error'})});
  assert.equal(revert.status,200);
  assert.equal((await app.db.query('SELECT status FROM imports WHERE id=$1',[importRow.id])).rows[0].status,'Revertido');
  assert.equal(await count(app.db,'contracts'),0);
  assert.equal(await count(app.db,'documents'),0);
  assert.equal(await count(app.db,'installments'),0);
  assert.equal(await count(app.db,'properties'),0);
  assert.equal(await count(app.db,'persons'),0);

  await reset(app.db);
  await app.db.query("UPDATE settings SET value='3' WHERE key='default_management_fee_pct'");
  await app.db.query("UPDATE settings SET value=$1 WHERE key='import_directory'",[directory]);
  await scanImportDirectory(app.db);
  importRow=(await app.db.query('SELECT id FROM imports LIMIT 1')).rows[0];
  await completeImportReview(app.db,importRow.id,{});
  const installmentId=(await app.db.query('SELECT id FROM installments LIMIT 1')).rows[0].id;
  await fetch(`${base}/api/payments/${installmentId}/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:420000,paid_at:'2026-08-22',method:'Transferencia',tax_status:'Declarado'})});
  const blocked=await fetch(`${base}/api/imports/${importRow.id}/revert`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason:'Tiene pagos'})});
  assert.equal(blocked.status,400);
  assert.match((await blocked.json()).error,/cobros registrados/);
});

test('si se elimina el PDF de contratos se elimina la información importada desde ese archivo',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ferraro-delete-file-')),db=await openDatabase();
  t.after(async()=>{await db.query("UPDATE settings SET value=$1 WHERE key='import_directory'",[path.join(__dirname,'..','contratos')]);await db.end();fs.rmSync(directory,{recursive:true,force:true});});
  await reset(db);
  await db.query("UPDATE settings SET value=$1 WHERE key='import_directory'",[directory]);
  await db.query("UPDATE settings SET value='3' WHERE key='default_management_fee_pct'");
  const file=path.join(directory,path.basename(sample));
  fs.copyFileSync(sample,file);
  await scanImportDirectory(db);
  const importRow=(await db.query('SELECT id FROM imports LIMIT 1')).rows[0];
  await completeImportReview(db,importRow.id,{});
  const installmentId=(await db.query('SELECT id FROM installments LIMIT 1')).rows[0].id;
  await db.query('INSERT INTO payments(id,installment_id,amount,paid_at,method) VALUES ($1,$2,$3,$4,$5)',[uid(),installmentId,420000,'2026-08-22','Transferencia']);
  assert.equal(await count(db,'contracts'),1);
  assert.equal(await count(db,'payments'),1);
  fs.unlinkSync(file);
  const scan=await scanImportDirectory(db);
  assert.equal(scan.purged,1);
  assert.equal(await count(db,'imports'),0);
  assert.equal(await count(db,'documents'),0);
  assert.equal(await count(db,'contracts'),0);
  assert.equal(await count(db,'installments'),0);
  assert.equal(await count(db,'payments'),0);
  assert.equal(await count(db,'properties'),0);
  assert.equal(await count(db,'persons'),0);
});

test('crea propiedad con detalles y propietarios existentes',async t=>{
  const app=await createApp();
  await reset(app.db);
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));await app.db.end();});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const ownerA=uid(),ownerB=uid();
  await app.db.query('INSERT INTO persons(id,full_name,document_number) VALUES ($1,$2,$3),($4,$5,$6)',[ownerA,'Dueño Uno','20111111112',ownerB,'Dueño Dos','20222222223']);
  const response=await fetch(`${base}/api/properties`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    country:'Argentina',
    province:'CABA',
    neighborhood:'Palermo',
    address:'Av. Santa Fe 3200 4 A',
    street:'Av. Santa Fe',
    street_number:'3200',
    floor:'4',
    unit_label:'A',
    property_type:'Departamento',
    owner_ids:[ownerA,ownerB],
    size_m2:'72',
    bedrooms:'2',
    bathrooms:'1',
    market_value_usd:'150000',
    status:'Disponible'
  })});
  assert.equal(response.status,201);
  const property=(await app.db.query('SELECT property_type,city,neighborhood,street,street_number,floor,unit_label,size_m2::float,bedrooms,bathrooms,market_value_usd::float FROM properties LIMIT 1')).rows[0];
  assert.equal(property.property_type,'Departamento');
  assert.equal(property.city,null);
  assert.equal(property.neighborhood,'Palermo');
  assert.equal(property.street,'Av. Santa Fe');
  assert.equal(property.street_number,'3200');
  assert.equal(property.floor,'4');
  assert.equal(property.unit_label,'A');
  assert.equal(property.size_m2,72);
  assert.equal(property.bedrooms,2);
  assert.equal(property.bathrooms,1);
  assert.equal(property.market_value_usd,150000);
  assert.equal(await count(app.db,'property_owners'),2);
  assert.equal(Number((await app.db.query('SELECT SUM(ownership_percentage)::float total FROM property_owners')).rows[0].total),100);
  const geoResponse=await fetch(`${base}/api/geo/localities?province=CABA`).then(response=>response.json());
  assert.equal(geoResponse.label,'Barrio');
  assert.ok(geoResponse.localities.includes('Palermo'));
});

test('crea y edita propietario con perfil fiscal, correo y propiedades vinculadas',async t=>{
  const app=await createApp();await reset(app.db);await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));await app.db.end();});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const propertyId=uid();
  await app.db.query('INSERT INTO properties(id,code,address,normalized_address,property_type,status,country,province,city) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[propertyId,'INM-TEST','Calle Falsa 123','calle falsa 123','Departamento','Disponible','Argentina','Buenos Aires','La Plata']);
  const invalidMail=await fetch(`${base}/api/owners`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    first_name:'Sin',
    last_name:'Correo',
    document_number:'20999999999',
    liquidation_email_enabled:true
  })});
  assert.equal(invalidMail.status,400);
  assert.match((await invalidMail.json()).error,/email válido/);
  const response=await fetch(`${base}/api/owners`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    first_name:'Nuevo',
    last_name:'Propietario',
    document_type:'DNI',
    document_number:'20333333334',
    tax_id:'20-33333333-4',
    vat_condition:'Monotributista',
    email:'owner@test.com',
    phone:'1122334455',
    whatsapp:'1199887766',
    liquidation_email_enabled:true,
    address:'Av Siempre Viva 742',
    country:'Argentina',
    province:'Buenos Aires',
    city:'La Plata',
    fiscal_address:'Fiscal 123',
    gross_income_number:'CM 901-123456-7',
    activity_start_date:'2024-01-10',
    person_kind:'PERSON',
    property_ids:[propertyId]
  })});
  assert.equal(response.status,201);
  const owners=await fetch(`${base}/api/owners`).then(response=>response.json());
  assert.equal(owners.length,1);
  assert.equal(owners[0].full_name,'Nuevo Propietario');
  assert.equal(owners[0].email,'owner@test.com');
  assert.equal(owners[0].tax_id,'20-33333333-4');
  assert.equal(owners[0].vat_condition,'Monotributista');
  assert.equal(owners[0].liquidation_email_enabled,true);
  assert.equal(owners[0].properties_count,1);
  assert.deepEqual(owners[0].property_ids,[propertyId]);
  const update=await fetch(`${base}/api/owners/${owners[0].id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    first_name:'Nuevo',
    last_name:'Dueño',
    document_type:'DNI',
    document_number:'20333333334',
    email:'owner2@test.com',
    liquidation_email_enabled:true,
    person_kind:'PERSON',
    property_ids:[]
  })});
  assert.equal(update.status,200);
  const updatedOwners=await fetch(`${base}/api/owners`).then(response=>response.json());
  assert.equal(updatedOwners[0].full_name,'Nuevo Dueño');
  assert.equal(updatedOwners[0].email,'owner2@test.com');
  assert.equal(updatedOwners[0].properties_count,0);
});

test('lista inquilinos y garantes por contrato y protege eliminaciones',async t=>{
  const app=await createApp();await reset(app.db);await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));await app.db.end();});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const propertyId=uid(),tenantId=uid(),contractId=uid(),guaranteeId=uid();
  await app.db.query('INSERT INTO properties(id,code,address,normalized_address,property_type,status,country,province,city) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[propertyId,'INM-TEN','Boyaca 621','boyaca 621','Departamento','Alquilada','Argentina','CABA',null]);
  await app.db.query('INSERT INTO persons(id,full_name,document_type,document_number,email,phone) VALUES ($1,$2,$3,$4,$5,$6)',[tenantId,'Juan Pérez','DNI','30111222','juan@test.com','11112222']);
  await app.db.query(`INSERT INTO contracts(id,code,property_id,tenant_id,rental_type,duration_months,start_date,end_date,initial_amount,currency,adjustment_frequency_months,adjustment_index,payment_due_day,management_fee_pct,status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[contractId,'Contrato de prueba',propertyId,tenantId,'Residencial',24,'2026-01-01','2027-12-31',500000,'ARS',4,'IPC',10,3,'Activo']);
  await app.db.query('INSERT INTO guarantees(id,contract_id,guarantee_type,guarantor_name,guarantor_document,guarantor_email,guarantor_phone,guarantor_address,guaranteed_property) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[guaranteeId,contractId,'Garantía propietaria','María García','27111222','maria.garcia@ejemplo.com','1198765432','Calle Verdadera 456, San Isidro','Av Test 123']);
  const tenants=await fetch(`${base}/api/tenants`).then(response=>response.json());
  assert.equal(tenants.length,1);
  assert.equal(tenants[0].full_name,'Juan Pérez');
  assert.equal(tenants[0].contract_code,'Contrato de prueba');
  assert.equal(tenants[0].guarantors,'María García');
  assert.equal(tenants[0].guarantors_json[0].email,'maria.garcia@ejemplo.com');
  const tenantUpdate=await fetch(`${base}/api/tenants/${tenantId}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({first_name:'Juan',last_name:'Pérez Actualizado',document_number:'30123456',tax_id:'20-30123456-9',nationality:'Argentina',address:'Calle Falsa 123',city:'Vicente López',province:'Buenos Aires',country:'Argentina',phone:'1123456789',whatsapp:'1123456789',email:'juan@example.com',person_kind:'PERSON',vat_condition:'Consumidor final'})});
  assert.equal(tenantUpdate.status,200);
  const updatedTenants=await fetch(`${base}/api/tenants`).then(response=>response.json());
  assert.equal(updatedTenants[0].full_name,'Juan Pérez Actualizado');
  assert.equal(updatedTenants[0].tax_id,'20-30123456-9');
  assert.equal(updatedTenants[0].city,'Vicente López');
  const guarantors=await fetch(`${base}/api/guarantors`).then(response=>response.json());
  assert.equal(guarantors.length,1);
  assert.equal(guarantors[0].full_name,'María García');
  assert.equal(guarantors[0].phone,'1198765432');
  const tenantDelete=await fetch(`${base}/api/tenants/${tenantId}`,{method:'DELETE'});
  assert.equal(tenantDelete.status,400);
  assert.match((await tenantDelete.json()).error,/vinculado a contratos/);
  const guarantorDelete=await fetch(`${base}/api/guarantors/${guaranteeId}`,{method:'DELETE'});
  assert.equal(guarantorDelete.status,200);
  assert.equal((await fetch(`${base}/api/guarantors`).then(response=>response.json())).length,0);
});

test('edita cobros pendientes, registra pago y lo lista como cobro pasado',async t=>{
  const app=await createApp();await reset(app.db);await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));await app.db.end();});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const propertyId=uid(),tenantId=uid(),contractId=uid(),installmentId=uid(),nextInstallmentId=uid();
  await app.db.query('INSERT INTO properties(id,code,address,normalized_address,property_type,status,country,province,city) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[propertyId,'INM-COL','Garay 1900','garay 1900','Departamento','Alquilada','Argentina','Buenos Aires','Mar del Plata']);
  await app.db.query('INSERT INTO persons(id,full_name,document_type,document_number) VALUES ($1,$2,$3,$4)',[tenantId,'Ana Cobros','DNI','32111222']);
  await app.db.query(`INSERT INTO contracts(id,code,property_id,tenant_id,rental_type,duration_months,start_date,end_date,initial_amount,currency,adjustment_frequency_months,adjustment_index,payment_due_day,management_fee_pct,status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[contractId,'Contrato cobro',propertyId,tenantId,'Residencial',12,'2026-01-01','2026-12-31',100000,'ARS',null,null,10,3,'Activo']);
  await app.db.query('INSERT INTO installments(id,contract_id,period,due_date,expected_amount,currency) VALUES ($1,$2,$3,$4,$5,$6)',[installmentId,contractId,'2026-08','2026-08-10',100000,'ARS']);
  await app.db.query('INSERT INTO installments(id,contract_id,period,due_date,expected_amount,currency) VALUES ($1,$2,$3,$4,$5,$6)',[nextInstallmentId,contractId,'2026-09','2026-09-10',100000,'ARS']);
  const pendingBefore=await fetch(`${base}/api/pending-collections`).then(response=>response.json());
  assert.equal(pendingBefore.length,2);
  const repeated=await fetch(`${base}/api/pending-collections/${installmentId}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({expected_amount:110000,declared_amount:90000,repeat_remaining:true})});
  assert.equal(repeated.status,200);
  const afterRepeat=await fetch(`${base}/api/pending-collections`).then(response=>response.json());
  assert.equal(afterRepeat.find(item=>item.id===installmentId).expected_amount,110000);
  assert.equal(afterRepeat.find(item=>item.id===nextInstallmentId).expected_amount,110000);
  assert.equal(afterRepeat.find(item=>item.id===installmentId).declared_amount,90000);
  const update=await fetch(`${base}/api/pending-collections/${installmentId}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({vat_amount:21000,late_fee_amount:1000,discount_amount:2000,discount_details_enabled:true,manual_partial_amount:5000,internal_notes:'Revisado'})});
  assert.equal(update.status,200);
  const pending=await fetch(`${base}/api/pending-collections`).then(response=>response.json());
  const edited=pending.find(item=>item.id===installmentId);
  assert.equal(edited.due_amount,125000);
  assert.equal(edited.paid_amount,5000);
  assert.equal(edited.discount_details_enabled,true);
  assert.equal(edited.internal_notes,'Revisado');
  const payment=await fetch(`${base}/api/payments/${installmentId}/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:125000,paid_at:'2026-08-21',method:'Transferencia',tax_status:'Declarado',payment_type:'Alquiler'})});
  assert.equal(payment.status,201);
  assert.equal((await fetch(`${base}/api/pending-collections`).then(response=>response.json())).length,1);
  const past=await fetch(`${base}/api/collections`).then(response=>response.json());
  assert.equal(past.length,1);
  assert.equal(past[0].amount,125000);
  assert.equal(past[0].status,'Pagado');
});

test('anula un contrato sin borrarlo y deja de mostrar cobros pendientes',async t=>{
  const app=await createApp();await reset(app.db);await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));await app.db.end();});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const propertyId=uid(),tenantId=uid(),contractId=uid(),installmentId=uid();
  await app.db.query('INSERT INTO properties(id,code,address,normalized_address,property_type,status,country,province,city) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[propertyId,'INM-VOID','Av Error 123','av error 123','Departamento','Alquilada','Argentina','CABA',null]);
  await app.db.query('INSERT INTO persons(id,full_name,document_type,document_number) VALUES ($1,$2,$3,$4)',[tenantId,'Inquilino Error','DNI','33111222']);
  await app.db.query(`INSERT INTO contracts(id,code,property_id,tenant_id,rental_type,duration_months,start_date,end_date,initial_amount,currency,adjustment_frequency_months,adjustment_index,payment_due_day,management_fee_pct,status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[contractId,'Contrato anular',propertyId,tenantId,'Residencial',12,'2026-01-01','2026-12-31',100000,'ARS',4,'IPC',10,3,'Activo']);
  await app.db.query('INSERT INTO installments(id,contract_id,period,due_date,expected_amount,currency) VALUES ($1,$2,$3,$4,$5,$6)',[installmentId,contractId,'2026-09','2026-09-10',100000,'ARS']);
  assert.equal((await fetch(`${base}/api/pending-collections`).then(response=>response.json())).length,1);
  const response=await fetch(`${base}/api/contracts/${contractId}/void`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason:'Cargado por error'})});
  assert.equal(response.status,200);
  assert.equal((await app.db.query('SELECT status,void_reason FROM contracts WHERE id=$1',[contractId])).rows[0].status,'Anulado');
  assert.equal((await fetch(`${base}/api/pending-collections`).then(response=>response.json())).length,0);
  assert.equal((await fetch(`${base}/api/contracts`).then(response=>response.json())).length,1);
});

test('acciones operativas de contrato renuevan, rescinden, devuelven depósito, desactivan y eliminan',async t=>{
  const app=await createApp();await reset(app.db);await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));await app.db.end();});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const propertyId=uid(),tenantId=uid(),ownerId=uid(),contractId=uid(),installmentId=uid();
  await app.db.query('INSERT INTO properties(id,code,address,normalized_address,property_type,status,country,province,city) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[propertyId,'INM-ACT','Acciones 123','acciones 123','Departamento','Alquilada','Argentina','CABA',null]);
  await app.db.query('INSERT INTO persons(id,full_name,document_type,document_number) VALUES ($1,$2,$3,$4),($5,$6,$7,$8)',[tenantId,'Tenant Action','DNI','301',ownerId,'Owner Action','DNI','201']);
  await app.db.query(`INSERT INTO contracts(id,code,property_id,tenant_id,rental_type,duration_months,start_date,end_date,initial_amount,currency,adjustment_frequency_months,adjustment_index,payment_due_day,management_fee_pct,deposit_amount,status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,[contractId,'Contrato acciones',propertyId,tenantId,'Residencial',12,'2026-01-01','2026-12-31',100000,'ARS',3,'IPC',10,3,70000,'Activo']);
  await app.db.query('INSERT INTO contract_owners(contract_id,person_id) VALUES ($1,$2)',[contractId,ownerId]);
  await app.db.query('INSERT INTO guarantees(id,contract_id,guarantee_type,provider) VALUES ($1,$2,$3,$4)',[uid(),contractId,'Seguro de caución','Respaldar']);
  await app.db.query('INSERT INTO installments(id,contract_id,period,due_date,expected_amount,currency) VALUES ($1,$2,$3,$4,$5,$6)',[installmentId,contractId,'2026-08','2026-08-10',100000,'ARS']);
  const fileForm=new FormData();
  fileForm.append('file',new Blob([fs.readFileSync(sample)],{type:'application/pdf'}),'adjunto-contrato.pdf');
  const attach=await fetch(`${base}/api/contracts/${contractId}/upload-file`,{method:'POST',body:fileForm});
  assert.equal(attach.status,201);
  assert.equal(await count(app.db,'documents',`WHERE contract_id='${contractId}'`),1);
  assert.equal(await count(app.db,'imports'),0);

  const legacyRenew=await fetch(`${base}/api/contracts/${contractId}/renew`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({start_date:'2027-01-01',initial_amount:120000,duration_months:6,deactivate_previous:true})});
  assert.equal(legacyRenew.status,400);
  assert.match((await legacyRenew.json()).error,/seleccionar el nuevo contrato/);
  assert.equal(await count(app.db,'contracts'),1);
  const nextContract=await insertContractWithDocument(app.db,{propertyId,tenantId,code:'Contrato acciones 2027',start:'2027-01-01',end:'2027-06-30',months:6,amount:120000,deposit:120000,sha:'a'.repeat(64)});
  const renew=await fetch(`${base}/api/contracts/${contractId}/renew`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({new_contract_id:nextContract.contractId})});
  assert.equal(renew.status,201);
  const renewed=await renew.json();
  assert.equal(renewed.id,nextContract.contractId);
  assert.equal(await count(app.db,'contracts'),2);
  assert.equal((await app.db.query('SELECT status FROM contracts WHERE id=$1',[contractId])).rows[0].status,'Renovado');
  assert.equal(await count(app.db,'installments',`WHERE contract_id='${renewed.id}'`),6);
  assert.equal((await app.db.query('SELECT deposit_amount::float FROM contracts WHERE id=$1',[renewed.id])).rows[0].deposit_amount,120000);

  const rescind=await fetch(`${base}/api/contracts/${renewed.id}/rescind`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rescission_date:'2027-03-15',penalty_amount:50000,return_deposit:true})});
  assert.equal(rescind.status,200);
  assert.equal((await app.db.query('SELECT status,rescission_penalty::float,deposit_returned_amount::float FROM contracts WHERE id=$1',[renewed.id])).rows[0].status,'Rescindido');
  assert.equal(await count(app.db,'ledger_entries'),2);

  const deposit=await fetch(`${base}/api/contracts/${contractId}/return-deposit`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:70000,date:'2026-12-31'})});
  assert.equal(deposit.status,200);
  assert.equal((await app.db.query('SELECT deposit_returned_amount::float FROM contracts WHERE id=$1',[contractId])).rows[0].deposit_returned_amount,70000);

  const deactivate=await fetch(`${base}/api/contracts/${contractId}/deactivate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason:'Test'})});
  assert.equal(deactivate.status,200);
  assert.equal((await app.db.query('SELECT status FROM contracts WHERE id=$1',[contractId])).rows[0].status,'Archivado');

  const deletion=await fetch(`${base}/api/contracts/${renewed.id}`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason:'Test delete'})});
  assert.equal(deletion.status,200);
  assert.equal(await count(app.db,'contracts',`WHERE id='${renewed.id}'`),0);
});

test('propietarios listan las propiedades vinculadas por property_owners',async t=>{
  const app=await createApp();await reset(app.db);await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));await app.db.end();});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const solis=await insertProperty(app.db,'Solís 637 1°G','INM-OWN-1'),rivadavia=await insertProperty(app.db,'Rivadavia 3020 5°C','INM-OWN-2'),corrientes=await insertProperty(app.db,'Av. Corrientes 1234 4°B','INM-OWN-3');
  const juan=uid(),maria=uid(),empty=uid();
  await app.db.query('INSERT INTO persons(id,full_name,document_number,is_owner) VALUES ($1,$2,$3,true),($4,$5,$6,true),($7,$8,$9,true)',[juan,'Juan Pérez','20100100100',maria,'María Gómez','27200200200',empty,'Sin Inmuebles','20300300300']);
  await app.db.query('INSERT INTO property_owners(property_id,person_id,ownership_percentage) VALUES ($1,$2,100),($3,$4,100),($5,$4,100)',[corrientes,juan,solis,maria,rivadavia]);
  const owners=await fetch(`${base}/api/owners`).then(response=>response.json());
  const byName=Object.fromEntries(owners.map(owner=>[owner.full_name,owner]));
  assert.equal(owners.length,3);
  assert.equal(byName['Juan Pérez'].properties_count,1);
  assert.deepEqual(byName['Juan Pérez'].properties_list.map(item=>item.address),['Av. Corrientes 1234 4°B']);
  assert.deepEqual(byName['Juan Pérez'].property_ids,[corrientes]);
  assert.equal(byName['María Gómez'].properties_count,2);
  assert.deepEqual(byName['María Gómez'].properties_list.map(item=>item.address),['Rivadavia 3020 5°C','Solís 637 1°G']);
  assert.deepEqual(byName['María Gómez'].properties_list.map(item=>item.id).sort(),[rivadavia,solis].sort());
  assert.deepEqual([...byName['María Gómez'].property_ids].sort(),[rivadavia,solis].sort());
  assert.equal(byName['Sin Inmuebles'].properties_count,0);
  assert.deepEqual(byName['Sin Inmuebles'].properties_list,[]);
});

test('cobros pendientes se filtran por período de cobro de todas las propiedades',async t=>{
  const app=await createApp();await reset(app.db);await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));await app.db.end();});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const {filterByPeriod,formatPeriod}=await import('../frontend/src/utils/periods.mjs');
  const tenantId=uid();
  await app.db.query('INSERT INTO persons(id,full_name,document_number) VALUES ($1,$2,$3)',[tenantId,'Inquilino Períodos','30500500']);
  const propertyA=await insertProperty(app.db,'Propiedad A 100','INM-PA'),propertyB=await insertProperty(app.db,'Propiedad B 200','INM-PB'),propertyC=await insertProperty(app.db,'Propiedad C 300','INM-PC');
  await insertContractWithDocument(app.db,{propertyId:propertyA,tenantId,code:'Contrato A',start:'2027-05-01',end:'2027-05-31',months:1,amount:100000,sha:'1'.repeat(64)});
  await insertContractWithDocument(app.db,{propertyId:propertyB,tenantId,code:'Contrato B',start:'2027-05-01',end:'2027-05-31',months:1,amount:200000,sha:'2'.repeat(64)});
  await insertContractWithDocument(app.db,{propertyId:propertyC,tenantId,code:'Contrato C',start:'2027-06-01',end:'2027-06-30',months:1,amount:300000,sha:'3'.repeat(64)});
  const pending=await fetch(`${base}/api/pending-collections`).then(response=>response.json());
  assert.equal(pending.length,3);
  assert.deepEqual(pending.map(row=>row.period).sort(),['2027-05','2027-05','2027-06']);
  const may=filterByPeriod(pending,'2027-05');
  assert.equal(may.length,2);
  assert.deepEqual(may.map(row=>row.property).sort(),['Propiedad A 100','Propiedad B 200']);
  assert.deepEqual(filterByPeriod(pending,'2027-06').map(row=>row.property),['Propiedad C 300']);
  assert.equal(filterByPeriod(pending,'2027-07').length,0);
  assert.equal(filterByPeriod(pending,'').length,3);
  assert.match(formatPeriod('2027-05'),/^Mayo( de)? 2027$/);
  assert.equal(formatPeriod(''),'Todos los meses');
});

test('renovación vincula un contrato importado desde PDF sin copiar datos del anterior',async t=>{
  const app=await createApp();await reset(app.db);await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));await app.db.end();});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const postJson=(url,body)=>fetch(`${base}${url}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  await app.db.query("UPDATE settings SET value='3' WHERE key='default_management_fee_pct'");
  const ownerId=uid(),tenantId=uid();
  await app.db.query('INSERT INTO persons(id,full_name,document_number,is_owner) VALUES ($1,$2,$3,true),($4,$5,$6,false)',[ownerId,'Dueña Renovación','27111000111',tenantId,'Juan Pérez','30111000111']);
  const propertyId=await insertProperty(app.db,'Solis 637 1 G','INM-REN'),otherPropertyId=await insertProperty(app.db,'Rivadavia 3020 5 C','INM-OTRA');
  await app.db.query('INSERT INTO property_owners(property_id,person_id,ownership_percentage) VALUES ($1,$2,100)',[propertyId,ownerId]);
  const previous=await insertContractWithDocument(app.db,{propertyId,tenantId,code:'CONT-2025-001',start:'2025-07-01',end:'2027-06-30',months:24,amount:400000,sha:'b'.repeat(64)});
  await app.db.query('INSERT INTO contract_owners(contract_id,person_id) VALUES ($1,$2)',[previous.contractId,ownerId]);
  const installmentOf=async(contractId,period)=>(await app.db.query('SELECT id,status FROM installments WHERE contract_id=$1 AND period=$2',[contractId,period])).rows[0];
  assert.equal((await postJson(`/api/payments/${(await installmentOf(previous.contractId,'2026-11')).id}/register`,{amount:400000,paid_at:'2026-11-08'})).status,201);
  assert.equal((await postJson(`/api/payments/${(await installmentOf(previous.contractId,'2027-02')).id}/register`,{amount:100000,paid_at:'2027-02-05'})).status,201);

  const importId=uid();
  await app.db.query('INSERT INTO imports(id,filename,absolute_path,sha256,status,confidence,warnings_json,result_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',[importId,'contrato-renovacion.pdf',path.join(os.tmpdir(),'contrato-renovacion.pdf'),'c'.repeat(64),'Revisión',0.9,'[]',JSON.stringify({parsed:{warnings:['Revisar cláusula de ajuste']},extracted_text:'Contrato de renovación'})]);
  const completed=await completeImportReview(app.db,importId,{property_id:propertyId,address:'Solis 637 1 G',rental_type:'Residencial',owner_full_name:'Dueña Renovación',owner_document_number:'27111000111',tenant_full_name:'Laura Nueva',tenant_document_number:'30999000999',start_date:'2027-01-01',end_date:'2028-12-31',duration_months:'24',initial_amount:'650000',currency:'ARS',adjustment_type:'MANUAL',adjustment_frequency_months:'4',payment_due_day:'10',guarantee_type:'Seguro de caución',guarantee_provider:'Respaldar'});
  const newContractId=completed.contractId;
  const other=await insertContractWithDocument(app.db,{propertyId:otherPropertyId,tenantId,code:'CONT-OTRA',start:'2027-01-01',end:'2028-12-31',months:24,amount:500000,sha:'d'.repeat(64),installments:false});
  const voided=await insertContractWithDocument(app.db,{propertyId,tenantId,code:'CONT-ANULADO',start:'2027-02-01',end:'2029-01-31',months:24,amount:500000,sha:'e'.repeat(64),status:'Anulado',installments:false});
  const contractRow=async id=>(await app.db.query('SELECT id,code,status,property_id,tenant_id,previous_contract_id,source_document_id,initial_amount::float,duration_months,start_date::text,end_date::text FROM contracts WHERE id=$1',[id])).rows[0];
  const newBefore=await contractRow(newContractId),previousBefore=await contractRow(previous.contractId);
  assert.equal(newBefore.status,'Revisión');
  assert.equal(newBefore.property_id,propertyId);

  const candidates=await fetch(`${base}/api/contracts/${previous.contractId}/renewal-candidates`).then(response=>response.json());
  assert.equal(candidates.renewable,true);
  assert.deepEqual(candidates.candidates.map(item=>item.id),[newContractId]);
  assert.equal(candidates.candidates[0].tenant_changed,true);
  assert.equal(candidates.candidates[0].overlaps_previous,true);
  assert.equal(candidates.candidates[0].document_filename,'contrato-renovacion.pdf');
  assert.equal(candidates.candidates[0].initial_amount,650000);

  let rejected=await postJson(`/api/contracts/${previous.contractId}/renew`,{new_contract_id:previous.contractId});
  assert.equal(rejected.status,400);assert.match((await rejected.json()).error,/consigo mismo/);
  rejected=await postJson(`/api/contracts/${previous.contractId}/renew`,{new_contract_id:other.contractId});
  assert.equal(rejected.status,400);assert.match((await rejected.json()).error,/misma propiedad/);
  rejected=await postJson(`/api/contracts/${previous.contractId}/renew`,{new_contract_id:voided.contractId});
  assert.equal(rejected.status,400);assert.match((await rejected.json()).error,/estado Anulado/);
  rejected=await postJson(`/api/contracts/${previous.contractId}/renew`,{start_date:'2027-01-01',initial_amount:999});
  assert.equal(rejected.status,400);
  assert.equal(await count(app.db,'contracts'),4);
  assert.equal((await contractRow(previous.contractId)).status,'Activo');

  const response=await postJson(`/api/contracts/${previous.contractId}/renew`,{new_contract_id:newContractId});
  assert.equal(response.status,201);
  const result=await response.json();
  assert.deepEqual(result.substituted_installments,['2027-01','2027-03','2027-04','2027-05','2027-06']);
  assert.deepEqual(result.kept_overlapping_installments,[{period:'2027-02',status:'Parcial'}]);

  const newAfter=await contractRow(newContractId),previousAfter=await contractRow(previous.contractId);
  assert.equal(newAfter.previous_contract_id,previous.contractId);
  assert.equal(newAfter.property_id,previousAfter.property_id);
  assert.equal(previousAfter.status,'Renovado');
  assert.equal(newAfter.status,'Activo');
  assert.deepEqual({...newAfter,status:newBefore.status,previous_contract_id:null},newBefore);
  assert.equal(newAfter.initial_amount,650000);
  assert.notEqual(newAfter.tenant_id,tenantId);
  assert.deepEqual(previousAfter,{...previousBefore,status:'Renovado'});
  assert.notEqual(newAfter.source_document_id,previousAfter.source_document_id);
  assert.equal(previousAfter.source_document_id,previous.documentId);
  assert.equal(await count(app.db,'documents',`WHERE contract_id='${previous.contractId}'`),1);
  assert.equal(await count(app.db,'documents',`WHERE contract_id='${newContractId}'`),1);
  assert.equal(await count(app.db,'contracts'),4);

  assert.equal(await count(app.db,'payments'),2);
  assert.equal((await installmentOf(previous.contractId,'2026-11')).status,'Pagado');
  assert.equal((await installmentOf(previous.contractId,'2027-01')).status,'Sustituido');
  assert.equal(await count(app.db,'installments',`WHERE contract_id='${previous.contractId}'`),24);
  assert.equal(await count(app.db,'installments',`WHERE contract_id='${newContractId}'`),24);

  const pending=await fetch(`${base}/api/pending-collections`).then(response=>response.json());
  const previousPending=pending.filter(row=>row.contract_id===previous.contractId);
  assert.ok(previousPending.some(row=>row.period==='2026-12'),'la deuda histórica del contrato anterior sigue pendiente');
  assert.deepEqual(previousPending.filter(row=>row.period>='2027-01').map(row=>row.period),['2027-02']);
  assert.equal(pending.filter(row=>row.contract_id===newContractId).length,24);
  assert.equal(pending.filter(row=>row.period==='2027-01').length,1);

  const substitutedPayment=await postJson(`/api/payments/${(await installmentOf(previous.contractId,'2027-03')).id}/register`,{amount:1000});
  assert.equal(substitutedPayment.status,400);assert.match((await substitutedPayment.json()).error,/sustituida/);

  const audit=(await app.db.query("SELECT entity_id,details_json FROM audit_log WHERE action='contract_renewal_linked'")).rows;
  assert.deepEqual(audit.map(row=>row.entity_id).sort(),[newContractId,previous.contractId].sort());
  assert.equal(audit[0].details_json.previous_contract_id,previous.contractId);
  assert.equal(audit[0].details_json.new_contract_id,newContractId);
  assert.equal(audit[0].details_json.property_id,propertyId);
  assert.ok(audit[0].details_json.linked_at);

  rejected=await postJson(`/api/contracts/${previous.contractId}/renew`,{new_contract_id:newContractId});
  assert.equal(rejected.status,400);
  assert.equal((await fetch(`${base}/api/contracts/${previous.contractId}/renewal-candidates`).then(response=>response.json())).renewable,false);
  const contracts=await fetch(`${base}/api/contracts`).then(response=>response.json());
  assert.equal(contracts.find(row=>row.id===newContractId).previous_contract_code,'CONT-2025-001');
  assert.equal(contracts.find(row=>row.id===previous.contractId).next_contract_code,newAfter.code);
});

test('renovación rechaza ciclos en el historial y contratos sin PDF propio',async t=>{
  const app=await createApp();await reset(app.db);await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));await app.db.end();});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const postJson=(url,body)=>fetch(`${base}${url}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const tenantId=uid();
  await app.db.query('INSERT INTO persons(id,full_name,document_number) VALUES ($1,$2,$3)',[tenantId,'Inquilino Ciclo','30777000']);
  const propertyId=await insertProperty(app.db,'Ciclo 123','INM-CICLO');
  const later=await insertContractWithDocument(app.db,{propertyId,tenantId,code:'CONT-LATER',start:'2027-01-01',end:'2027-12-31',months:12,amount:100000,sha:'f'.repeat(64),installments:false});
  const earlier=await insertContractWithDocument(app.db,{propertyId,tenantId,code:'CONT-EARLIER',start:'2026-01-01',end:'2026-12-31',months:12,amount:90000,sha:'9'.repeat(64),installments:false});
  await app.db.query('UPDATE contracts SET previous_contract_id=$1 WHERE id=$2',[later.contractId,earlier.contractId]);
  const loop=await postJson(`/api/contracts/${earlier.contractId}/renew`,{new_contract_id:later.contractId});
  assert.equal(loop.status,400);assert.match((await loop.json()).error,/ciclo/);
  assert.deepEqual((await fetch(`${base}/api/contracts/${earlier.contractId}/renewal-candidates`).then(response=>response.json())).candidates,[]);

  await app.db.query('UPDATE contracts SET previous_contract_id=NULL WHERE id=$1',[earlier.contractId]);
  await app.db.query('UPDATE contracts SET source_document_id=NULL WHERE id=$1',[later.contractId]);
  await app.db.query('UPDATE documents SET contract_id=NULL WHERE id=$1',[later.documentId]);
  const withoutPdf=await postJson(`/api/contracts/${earlier.contractId}/renew`,{new_contract_id:later.contractId});
  assert.equal(withoutPdf.status,400);assert.match((await withoutPdf.json()).error,/PDF/);
  assert.equal((await app.db.query('SELECT status FROM contracts WHERE id=$1',[earlier.contractId])).rows[0].status,'Activo');
});

test('la API usa PostgreSQL y valida honorarios',async t=>{
  const app=await createApp();await reset(app.db);await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));await app.db.end();});
  const base=`http://127.0.0.1:${app.server.address().port}`,health=await fetch(`${base}/api/health`).then(response=>response.json());assert.equal(health.database,'postgresql');
  const response=await fetch(`${base}/api/settings`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({default_management_fee_pct:7})});assert.equal(response.status,400);assert.match((await response.json()).error,/entre 2% y 5%/);
});

test('WhatsApp verifica webhook y rechaza firmas inválidas',async t=>{
  const app=await createApp();await reset(app.db);await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));await app.db.end();});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const ok=await fetch(`${base}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=abc123`);
  assert.equal(ok.status,200);
  assert.equal(await ok.text(),'abc123');
  const bad=await fetch(`${base}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123`);
  assert.equal(bad.status,403);
  const payload={entry:[{changes:[{value:{messages:[]}}]}]};
  const rejected=await fetch(`${base}/api/whatsapp/webhook`,{method:'POST',headers:{'Content-Type':'application/json','X-Hub-Signature-256':'sha256=bad'},body:JSON.stringify(payload)});
  assert.equal(rejected.status,401);
});

test('WhatsApp inbound identifica propietario, evita duplicados y autentica DNI/CUIT',async t=>{
  const app=await createApp();await reset(app.db);await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));await app.db.end();});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const ownerId=uid();
  await app.db.query(`INSERT INTO persons(id,full_name,document_type,document_number,tax_id,whatsapp,whatsapp_normalized,is_owner)
    VALUES ($1,$2,$3,$4,$5,$6,$7,true)`,[ownerId,'Dueño WhatsApp','DNI','20333333334','20-33333333-4','1199887766','+541199887766']);
  const makePayload=(id,text,from='5491199887766')=>({entry:[{changes:[{value:{contacts:[{wa_id:from,profile:{name:'Dueño'}}],messages:[{from,id,type:'text',text:{body:text}}]}}]}]});
  let signed=signedBody(makePayload('wamid.hola','Hola'));
  let response=await fetch(`${base}/api/whatsapp/webhook`,{method:'POST',headers:{'Content-Type':'application/json','X-Hub-Signature-256':signed.signature},body:signed.raw});
  assert.equal(response.status,200);
  assert.equal(await count(app.db,'whatsapp_messages',"WHERE direction='INBOUND'"),1);
  assert.match((await app.db.query("SELECT body FROM whatsapp_messages WHERE direction='OUTBOUND' ORDER BY created_at DESC LIMIT 1")).rows[0].body,/DNI|CUIT/);
  response=await fetch(`${base}/api/whatsapp/webhook`,{method:'POST',headers:{'Content-Type':'application/json','X-Hub-Signature-256':signed.signature},body:signed.raw});
  assert.equal(response.status,200);
  assert.equal(await count(app.db,'whatsapp_messages',"WHERE direction='INBOUND'"),1);
  signed=signedBody(makePayload('wamid.bad-dni','99999999'));
  await fetch(`${base}/api/whatsapp/webhook`,{method:'POST',headers:{'Content-Type':'application/json','X-Hub-Signature-256':signed.signature},body:signed.raw});
  assert.equal((await app.db.query('SELECT failed_auth_attempts FROM whatsapp_conversations LIMIT 1')).rows[0].failed_auth_attempts,1);
  signed=signedBody(makePayload('wamid.good-dni','20-33333333-4'));
  await fetch(`${base}/api/whatsapp/webhook`,{method:'POST',headers:{'Content-Type':'application/json','X-Hub-Signature-256':signed.signature},body:signed.raw});
  assert.equal((await app.db.query('SELECT status FROM whatsapp_conversations LIMIT 1')).rows[0].status,'VERIFIED');
});

test('WhatsApp no enumera DNI de propietarios inexistentes',async t=>{
  const app=await createApp();await reset(app.db);await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));await app.db.end();});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const payload={entry:[{changes:[{value:{contacts:[{wa_id:'5491155555555',profile:{name:'Desconocido'}}],messages:[{from:'5491155555555',id:'wamid.unknown',type:'text',text:{body:'20333333334'}}]}}]}]};
  const signed=signedBody(payload);
  const response=await fetch(`${base}/api/whatsapp/webhook`,{method:'POST',headers:{'Content-Type':'application/json','X-Hub-Signature-256':signed.signature},body:signed.raw});
  assert.equal(response.status,200);
  const body=(await app.db.query("SELECT body FROM whatsapp_messages WHERE direction='OUTBOUND' LIMIT 1")).rows[0].body;
  assert.match(body,/no está asociado/);
  assert.doesNotMatch(body,/20333333334|33333333/);
});

test('WhatsApp consulta última liquidación, propiedades, portal, handoff y opt-out',async t=>{
  const app=await createApp();await reset(app.db);await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));await app.db.end();});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const ownerId=uid(),tenantId=uid(),propertyId=uid(),contractId=uid(),installmentId=uid();
  await app.db.query('INSERT INTO persons(id,full_name,document_type,document_number,whatsapp,whatsapp_normalized,is_owner) VALUES ($1,$2,$3,$4,$5,$6,true),($7,$8,$9,$10,$11,$12,false)',[ownerId,'Owner Bot','DNI','20111222','1191112222','+541191112222',tenantId,'Tenant Bot','DNI','30111222',null,null]);
  await app.db.query('INSERT INTO properties(id,code,address,normalized_address,property_type,status) VALUES ($1,$2,$3,$4,$5,$6)',[propertyId,'BOT-1','Av Bot 123','av bot 123','Departamento','Alquilada']);
  await app.db.query(`INSERT INTO contracts(id,code,property_id,tenant_id,rental_type,duration_months,start_date,end_date,initial_amount,currency,adjustment_frequency_months,adjustment_index,payment_due_day,management_fee_pct,status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[contractId,'Contrato Bot',propertyId,tenantId,'Residencial',12,'2026-08-01','2027-07-31',200000,'ARS',4,'IPC',10,3,'Activo']);
  await app.db.query('INSERT INTO property_owners(property_id,person_id,ownership_percentage) VALUES ($1,$2,100)',[propertyId,ownerId]);
  await app.db.query('INSERT INTO contract_owners(contract_id,person_id) VALUES ($1,$2)',[contractId,ownerId]);
  await app.db.query('INSERT INTO installments(id,contract_id,period,due_date,expected_amount,currency) VALUES ($1,$2,$3,$4,$5,$6)',[installmentId,contractId,'2026-08','2026-08-10',200000,'ARS']);
  await app.db.query('INSERT INTO payments(id,installment_id,amount,paid_at,method,tax_status) VALUES ($1,$2,$3,$4,$5,$6)',[uid(),installmentId,200000,'2026-08-22','Transferencia','Declarado']);
  await app.db.query("INSERT INTO whatsapp_conversations(id,owner_id,phone_e164,status,session_verified_at,session_expires_at) VALUES ($1,$2,$3,'VERIFIED',now(),now()+interval '30 days')",[uid(),ownerId,'+541191112222']);
  const send=async(id,text)=>{const payload={entry:[{changes:[{value:{contacts:[{wa_id:'5491191112222'}],messages:[{from:'5491191112222',id,type:'text',text:{body:text}}]}}]}]};const signed=signedBody(payload);return fetch(`${base}/api/whatsapp/webhook`,{method:'POST',headers:{'Content-Type':'application/json','X-Hub-Signature-256':signed.signature},body:signed.raw});};
  await send('wamid.liq','liquidacion');
  assert.match((await app.db.query("SELECT body FROM whatsapp_messages WHERE direction='OUTBOUND' ORDER BY created_at DESC LIMIT 1")).rows[0].body,/2026-08|Av Bot 123/);
  await send('wamid.props','propiedades');
  assert.match((await app.db.query("SELECT body FROM whatsapp_messages WHERE direction='OUTBOUND' ORDER BY created_at DESC LIMIT 1")).rows[0].body,/Av Bot 123/);
  await send('wamid.portal','portal');
  const portalBody=(await app.db.query("SELECT body FROM whatsapp_messages WHERE direction='OUTBOUND' ORDER BY created_at DESC LIMIT 1")).rows[0].body;
  assert.match(portalBody,/#owner-portal\?token=/);
  assert.equal(await count(app.db,'owner_portal_tokens'),1);
  await send('wamid.human','asesor');
  assert.equal((await app.db.query('SELECT status FROM whatsapp_conversations LIMIT 1')).rows[0].status,'HUMAN_HANDOFF');
  await app.db.query("UPDATE whatsapp_conversations SET status='VERIFIED' WHERE owner_id=$1",[ownerId]);
  await send('wamid.stop','BAJA');
  assert.equal((await app.db.query('SELECT whatsapp_opt_in FROM persons WHERE id=$1',[ownerId])).rows[0].whatsapp_opt_in,false);
});

test('WhatsApp portal token, estados y automatización idempotente',async t=>{
  const app=await createApp();await reset(app.db);await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));await app.db.end();});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const ownerId=uid();
  await app.db.query(`INSERT INTO persons(id,full_name,document_type,document_number,whatsapp,whatsapp_normalized,is_owner,whatsapp_opt_in)
    VALUES ($1,$2,$3,$4,$5,$6,true,true)`,[ownerId,'Owner Automation','DNI','201','1192223333','+541192223333']);
  const token=await generatePortalToken(app.db,ownerId);
  const verified=await fetch(`${base}/api/owner-portal/verify?token=${encodeURIComponent(token)}`);
  assert.equal(verified.status,200);
  assert.equal((await verified.json()).owner_id,ownerId);
  await app.db.query("INSERT INTO whatsapp_messages(id,direction,whatsapp_message_id,phone_e164,message_type,status) VALUES ($1,'OUTBOUND',$2,$3,'text','sent')",[uid(),'wamid.out.1','+541192223333']);
  const statusPayload={entry:[{changes:[{value:{statuses:[{id:'wamid.out.1',recipient_id:'5491192223333',status:'read',timestamp:'1787411182'}]}}]}]};
  const signed=signedBody(statusPayload);
  const statusResponse=await fetch(`${base}/api/whatsapp/webhook`,{method:'POST',headers:{'Content-Type':'application/json','X-Hub-Signature-256':signed.signature},body:signed.raw});
  assert.equal(statusResponse.status,200);
  assert.equal((await app.db.query("SELECT status FROM whatsapp_messages WHERE whatsapp_message_id='wamid.out.1'")).rows[0].status,'read');
  await triggerAutomation(app.db,'DOCUMENT_AVAILABLE',{ownerId,relatedEntityType:'documents',relatedEntityId:null,parameters:['Owner Automation'],idempotencyKey:'doc-owner-1'});
  await triggerAutomation(app.db,'DOCUMENT_AVAILABLE',{ownerId,relatedEntityType:'documents',relatedEntityId:null,parameters:['Owner Automation'],idempotencyKey:'doc-owner-1'});
  assert.equal(await count(app.db,'whatsapp_outbound_jobs'),1);
});

test('worker local procesa payload reclamado del gateway y confirma ack',async t=>{
  const app=await createApp();await reset(app.db);
  t.after(async()=>{await app.db.end();});
  const ownerId=uid();
  await app.db.query(`INSERT INTO persons(id,full_name,document_type,document_number,tax_id,whatsapp,whatsapp_normalized,is_owner)
    VALUES ($1,$2,$3,$4,$5,$6,$7,true)`,[ownerId,'DueÃ±o Gateway','DNI','20333333334','20-33333333-4','1199887766','+541199887766']);
  const payload={entry:[{changes:[{value:{contacts:[{wa_id:'5491199887766',profile:{name:'DueÃ±o'}}],messages:[{from:'5491199887766',id:'wamid.gateway.1',type:'text',text:{body:'Hola'}}]}}]}]};
  const calls=[];
  const client={
    ack:async(id,leaseToken)=>calls.push(['ack',id,leaseToken]),
    nack:async(id,leaseToken,error)=>calls.push(['nack',id,leaseToken,error])
  };
  const result=await processClaimedEvent(app.db,client,{id:'message:wamid.gateway.1',leaseToken:'lease-1',payload});
  assert.equal(result.ok,true);
  assert.deepEqual(calls,[['ack','message:wamid.gateway.1','lease-1']]);
  assert.equal(await count(app.db,'whatsapp_messages',"WHERE direction='INBOUND'"),1);
});
