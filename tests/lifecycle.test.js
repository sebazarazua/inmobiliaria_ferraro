require('./require-isolated');
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {uid}=require('../backend/src/database');
const {scanImportDirectory,completeImportReview}=require('../backend/src/modules/imports/contract-parser');
const {collectEntries}=require('../backend/src/modules/imports/document-admin');
const {createApp}=require('../backend/src/app');

const sampleCandidates=[
  path.join(__dirname,'..','contratos','CONTRATO VIVIENDA. SOLIS 637 1 G CON SEGURO DNU 2024.pdf'),
  path.join(__dirname,'..','contratos','CONTRATO VIVIENDA. SOLIS 637 1° G CON SEGURO DNU 2024.pdf')
];
const sample=sampleCandidates.find(file=>fs.existsSync(file))||sampleCandidates[0];
const sampleSha=crypto.createHash('sha256').update(fs.readFileSync(sample)).digest('hex');
const count=async(db,table,where='',params=[])=>Number((await db.query(`SELECT COUNT(*) total FROM ${table} ${where}`,params)).rows[0].total);
async function reset(db){await db.query('TRUNCATE import_exclusions,rent_adjustment_history,whatsapp_automation_events,whatsapp_outbound_jobs,whatsapp_messages,whatsapp_conversations,owner_portal_tokens,whatsapp_webhook_events,audit_log,imports,payments,installments,initial_payments,recurring_charges,contract_tenants,guarantees,contract_owners,documents,contracts,property_owners,incidents,ledger_entries,properties,persons RESTART IDENTITY CASCADE');await db.query("UPDATE settings SET value='3' WHERE key='default_management_fee_pct'");}

// Cada test usa su propia carpeta de contratos dentro del directorio temporal y la base aislada del runner.
async function setup(t){
  const app=await createApp();await reset(app.db);await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ferraro-lifecycle-'));
  await app.db.query("UPDATE settings SET value=$1 WHERE key='import_directory'",[directory]);
  t.after(async()=>{await app.db.query("UPDATE settings SET value=$1 WHERE key='import_directory'",[process.env.FERRARO_TEST_IMPORT_DIRECTORY]);await new Promise(resolve=>app.server.close(resolve));await app.db.end();fs.rmSync(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}/api/`;
  const call=async(method,url,body)=>{const response=await fetch(base+url,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return{status:response.status,body:await response.json().catch(()=>null)};};
  const upload=async(name='contrato.pdf')=>{const form=new FormData();form.append('file',new Blob([fs.readFileSync(sample)],{type:'application/pdf'}),name);const response=await fetch(base+'imports/upload',{method:'POST',body:form});return{status:response.status,body:await response.json()};};
  return{app,db:app.db,directory,call,upload};
}
async function person(db,name,doc,isOwner=false){const id=uid();await db.query('INSERT INTO persons(id,full_name,document_type,document_number,is_owner) VALUES ($1,$2,$3,$4,$5)',[id,name,'DNI',doc,isOwner]);return id;}
async function property(db,address){const id=uid();await db.query('INSERT INTO properties(id,code,address,normalized_address,property_type,status) VALUES ($1,$2,$3,$4,$5,$6)',[id,`INM-${id.slice(0,6)}`,address,address.toLowerCase(),'Departamento','Alquilada']);return id;}
async function contract(db,{code,propertyId,tenantId,ownerId=null,status='Activo',start='2026-01-01',months=12,amount=100000,documentPath=null,sha=null}){
  const id=uid(),[year,month]=start.split('-').map(Number),end=new Date(Date.UTC(year,month-1+months,0)).toISOString().slice(0,10);
  let documentId=null;
  if(documentPath){documentId=uid();await db.query('INSERT INTO documents(id,filename,absolute_path,sha256,property_id) VALUES ($1,$2,$3,$4,$5)',[documentId,path.basename(documentPath),documentPath,sha||crypto.randomBytes(32).toString('hex'),propertyId]);}
  await db.query(`INSERT INTO contracts(id,code,property_id,tenant_id,rental_type,duration_months,start_date,end_date,initial_amount,currency,payment_due_day,management_fee_pct,status,source_document_id)
    VALUES ($1,$2,$3,$4,'Residencial',$5,$6,$7,$8,'ARS',10,3,$9,$10)`,[id,code,propertyId,tenantId,months,start,end,amount,status,documentId]);
  if(documentId)await db.query('UPDATE documents SET contract_id=$1 WHERE id=$2',[id,documentId]);
  if(ownerId){await db.query('INSERT INTO contract_owners(contract_id,person_id) VALUES ($1,$2)',[id,ownerId]);await db.query('INSERT INTO property_owners(property_id,person_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',[propertyId,ownerId]);}
  await db.query('INSERT INTO guarantees(id,contract_id,guarantee_type) VALUES ($1,$2,$3)',[uid(),id,'Sin garantía']);
  for(let index=0;index<months;index++){const period=new Date(Date.UTC(year,month-1+index,1)).toISOString().slice(0,7);await db.query('INSERT INTO installments(id,contract_id,period,due_date,expected_amount,currency) VALUES ($1,$2,$3,$4,$5,$6)',[uid(),id,period,`${period}-10`,amount,'ARS']);}
  return{id,documentId,end};
}
const installmentsSnapshot=async(db,contractId)=>(await db.query(`SELECT id,period,status,expected_amount::text,adjustment_pending,ipc_managed,calculation_hash,calculation_json,manual_partial_amount::text FROM installments WHERE contract_id=$1 ORDER BY period`,[contractId])).rows;
const financialSnapshot=async db=>({
  payments:(await db.query('SELECT id,installment_id,amount::text,paid_at::text FROM payments ORDER BY id')).rows,
  ledger:(await db.query('SELECT id,amount::text,contract_id FROM ledger_entries ORDER BY id')).rows,
  ipc:(await db.query('SELECT id,installment_id,version,new_amount::text,calculation_hash FROM rent_adjustment_history ORDER BY id')).rows
});

test('1. desactivar y reactivar conserva el contrato, sus cuotas y su historial',async t=>{
  const {db,call}=await setup(t);
  const propertyId=await property(db,'Ciclo 100'),tenantId=await person(db,'Ana Ciclo','40111222');
  const c=await contract(db,{code:'CICLO-1',propertyId,tenantId,start:'2026-06-01',months:12});
  const first=(await db.query('SELECT id FROM installments WHERE contract_id=$1 ORDER BY period LIMIT 1',[c.id])).rows[0].id;
  assert.equal((await call('POST',`payments/${first}/register`,{amount:40000,paid_at:'2026-06-05'})).status,201);
  const before=await installmentsSnapshot(db,c.id);
  assert.equal(before[0].status,'Parcial');
  const pendingBefore=(await call('GET','pending-collections')).body.length;

  const deactivated=await call('POST',`contracts/${c.id}/deactivate`,{reason:'Inquilino de viaje'});
  assert.equal(deactivated.status,200);assert.equal(deactivated.body.status,'Desactivado');
  assert.deepEqual(await installmentsSnapshot(db,c.id),before,'desactivar no modifica cuotas');
  assert.equal((await call('GET','pending-collections')).body.length,0);
  const repeated=await call('POST',`contracts/${c.id}/deactivate`,{});
  assert.equal(repeated.status,200);assert.equal(repeated.body.unchanged,true);
  const lifecycle=(await call('GET',`contracts/${c.id}/lifecycle`)).body;
  assert.equal(lifecycle.actions.reactivate.allowed,true);assert.equal(lifecycle.actions.deactivate.allowed,false);

  const reactivated=await call('POST',`contracts/${c.id}/reactivate`,{});
  assert.equal(reactivated.status,200);assert.equal(reactivated.body.status,'Activo');
  assert.deepEqual(await installmentsSnapshot(db,c.id),before,'reactivar no duplica ni recalcula cuotas');
  assert.equal(await count(db,'contracts'),1);
  assert.equal((await call('GET','pending-collections')).body.length,pendingBefore);
  const actions=(await db.query(`SELECT action FROM audit_log WHERE entity_type='contract' AND entity_id=$1 ORDER BY created_at`,[c.id])).rows.map(row=>row.action);
  assert.deepEqual(actions,['deactivated','reactivated']);

  await call('POST',`contracts/${c.id}/void`,{reason:'Error de carga'});
  const blocked=await call('POST',`contracts/${c.id}/reactivate`,{});
  assert.equal(blocked.status,400);assert.match(blocked.body.error,/anulados no se reactivan/);
});

test('1b. no reactiva si la propiedad ya tiene otro contrato vigente en esas fechas',async t=>{
  const {db,call}=await setup(t);
  const propertyId=await property(db,'Superpuesto 1'),tenantId=await person(db,'Inq Super','40999000');
  const a=await contract(db,{code:'SUP-A',propertyId,tenantId,start:'2026-06-01'});
  await call('POST',`contracts/${a.id}/deactivate`,{});
  await contract(db,{code:'SUP-B',propertyId,tenantId,start:'2026-09-01'});
  const blocked=await call('POST',`contracts/${a.id}/reactivate`,{});
  assert.equal(blocked.status,400);assert.match(blocked.body.error,/otro contrato vigente.*SUP-B/);
  assert.equal((await db.query('SELECT status FROM contracts WHERE id=$1',[a.id])).rows[0].status,'Desactivado');
});

test('1c. finalizar exige vigencia cumplida y ninguna cuota sin cobrar',async t=>{
  const {db,call}=await setup(t);
  const propertyId=await property(db,'Final 1'),tenantId=await person(db,'Inq Final','40123123');
  const current=await contract(db,{code:'FIN-VIG',propertyId,tenantId,start:'2026-06-01'});
  const lifecycle=(await call('GET',`contracts/${current.id}/lifecycle`)).body;
  assert.equal(lifecycle.actions.finalize.allowed,false);assert.match(lifecycle.actions.finalize.reason,/sigue vigente/);
  assert.equal((await call('POST',`contracts/${current.id}/finalize`,{})).status,400);
  const ended=await contract(db,{code:'FIN-OLD',propertyId:await property(db,'Final 2'),tenantId,start:'2024-01-01'});
  const withDebt=await call('POST',`contracts/${ended.id}/finalize`,{});
  assert.equal(withDebt.status,400);assert.match(withDebt.body.error,/12 cuotas sin cobrar/);
  await db.query("UPDATE installments SET status='Pagado' WHERE contract_id=$1",[ended.id]);
  const finalized=await call('POST',`contracts/${ended.id}/finalize`,{});
  assert.equal(finalized.status,200);assert.equal(finalized.body.status,'Finalizado');
  assert.equal((await call('POST',`contracts/${ended.id}/archive`,{})).body.status,'Archivado');
  assert.equal((await call('POST',`contracts/${ended.id}/restore`,{})).body.status,'Finalizado');
});

test('2. archivar y restaurar devuelve el estado original; los archivados antiguos no se reactivan solos',async t=>{
  const {db,call}=await setup(t);
  const propertyId=await property(db,'Archivo 200'),tenantId=await person(db,'Beto Archivo','40222333');
  const active=await contract(db,{code:'ARCH-ACT',propertyId,tenantId,start:'2026-06-01'});
  const archiveActive=await call('POST',`contracts/${active.id}/archive`,{});
  assert.equal(archiveActive.status,400);assert.match(archiveActive.body.error,/vigente no se archiva/);

  assert.equal((await call('POST',`contracts/${active.id}/rescind`,{rescission_date:'2026-08-31'})).status,200);
  assert.equal((await call('POST',`contracts/${active.id}/archive`,{reason:'Cerrado'})).body.status,'Archivado');
  assert.equal((await db.query('SELECT archived_from_status FROM contracts WHERE id=$1',[active.id])).rows[0].archived_from_status,'Rescindido');
  const restored=await call('POST',`contracts/${active.id}/restore`,{});
  assert.equal(restored.body.status,'Rescindido');

  // Archivado con la lógica anterior: sin estado previo y con cuotas forzadas a Vencido.
  const legacy=await contract(db,{code:'ARCH-OLD',propertyId:await property(db,'Archivo 201'),tenantId,start:'2026-06-01'});
  const legacyFirst=(await db.query('SELECT id FROM installments WHERE contract_id=$1 ORDER BY period LIMIT 1',[legacy.id])).rows[0].id;
  await db.query('INSERT INTO payments(id,installment_id,amount,paid_at) VALUES ($1,$2,$3,$4)',[uid(),legacyFirst,30000,'2026-06-02']);
  await db.query("UPDATE contracts SET status='Archivado',deactivated_at=now() WHERE id=$1",[legacy.id]);
  await db.query("UPDATE installments SET status='Vencido' WHERE contract_id=$1",[legacy.id]);
  const legacyRestore=await call('POST',`contracts/${legacy.id}/restore`,{});
  assert.equal(legacyRestore.body.status,'Desactivado');
  assert.match(legacyRestore.body.warnings[0],/Volver a activar/);
  assert.equal((await call('POST',`contracts/${legacy.id}/reactivate`,{})).body.status,'Activo');
  const statuses=(await installmentsSnapshot(db,legacy.id)).map(row=>row.status);
  assert.equal(statuses[0],'Parcial');assert.ok(statuses.slice(1).every(status=>status==='Pendiente'));

  // El estado ya no se puede cambiar editando el contrato.
  const edit=await call('PATCH',`contracts/${legacy.id}`,{status:'Anulado',notes:'x'});
  assert.equal(edit.status,400);assert.match(edit.body.error,/desde sus acciones/);
});

test('3. un contrato con cuotas pagadas no se elimina: se anula o archiva conservando los cobros',async t=>{
  const {db,call}=await setup(t);
  const propertyId=await property(db,'Pagos 300'),tenantId=await person(db,'Caro Pagos','40333444');
  const c=await contract(db,{code:'PAG-1',propertyId,tenantId,start:'2026-06-01'});
  const first=(await db.query('SELECT id FROM installments WHERE contract_id=$1 ORDER BY period LIMIT 1',[c.id])).rows[0].id;
  await call('POST',`payments/${first}/register`,{amount:100000,paid_at:'2026-06-05'});
  const impact=(await call('GET',`contracts/${c.id}/impact`)).body;
  assert.equal(impact.can_delete,false);assert.match(impact.blockers[0],/cobros registrados/);
  assert.ok(impact.alternatives.includes('void'));
  const deletion=await call('DELETE',`contracts/${c.id}`,{confirm:true});
  assert.equal(deletion.status,400);
  assert.equal(await count(db,'payments'),1);assert.equal(await count(db,'installments'),12);
  assert.equal((await call('POST',`contracts/${c.id}/void`,{reason:'Duplicado'})).body.status,'Anulado');
  assert.equal((await call('POST',`contracts/${c.id}/archive`,{})).body.status,'Archivado');
  assert.equal(await count(db,'payments'),1);
  assert.equal((await db.query('SELECT status FROM installments WHERE id=$1',[first])).rows[0].status,'Pagado');
});

test('4. un contrato renovado conserva la cadena y vuelve a su estado al reactivarse',async t=>{
  const {db,call}=await setup(t);
  const propertyId=await property(db,'Renueva 400'),tenantId=await person(db,'Dani Renueva','40444555');
  const old=await contract(db,{code:'REN-OLD',propertyId,tenantId,start:'2025-06-01',documentPath:path.join(os.tmpdir(),'ren-old.pdf')});
  const next=await contract(db,{code:'REN-NEW',propertyId,tenantId,start:'2026-03-01',documentPath:path.join(os.tmpdir(),'ren-new.pdf')});
  assert.equal((await call('POST',`contracts/${old.id}/renew`,{new_contract_id:next.id})).status,201);
  const oldInstallments=await installmentsSnapshot(db,old.id);
  assert.ok(oldInstallments.some(row=>row.status==='Sustituido'));
  const deleteOld=await call('DELETE',`contracts/${old.id}`,{confirm:true});
  assert.equal(deleteOld.status,400);assert.match(deleteOld.body.error,/renovado por REN-NEW/);
  const deleteNew=await call('DELETE',`contracts/${next.id}`,{confirm:true});
  assert.equal(deleteNew.status,400);assert.match(deleteNew.body.error,/renovación de REN-OLD/);
  assert.equal((await call('POST',`contracts/${old.id}/deactivate`,{})).body.status,'Desactivado');
  assert.equal((await call('POST',`contracts/${old.id}/reactivate`,{})).body.status,'Renovado');
  assert.deepEqual(await installmentsSnapshot(db,old.id),oldInstallments);
  assert.equal((await db.query('SELECT previous_contract_id FROM contracts WHERE id=$1',[next.id])).rows[0].previous_contract_id,old.id);
});

test('5. eliminar un contrato conserva propiedad, personas y documento, y lo informa antes',async t=>{
  const {db,call,directory}=await setup(t);
  const propertyId=await property(db,'Borra 500'),tenantId=await person(db,'Eva Borra','40555666'),ownerId=await person(db,'Oscar Dueño','20555666',true);
  const pdf=path.join(directory,'contrato-borra.pdf');fs.copyFileSync(sample,pdf);
  const c=await contract(db,{code:'DEL-1',propertyId,tenantId,ownerId,start:'2026-06-01',documentPath:pdf,sha:sampleSha});
  await db.query('INSERT INTO recurring_charges(id,contract_id,charge_type) VALUES ($1,$2,$3)',[uid(),c.id,'EXPENSAS']);
  const incidentId=uid();await db.query('INSERT INTO incidents(id,property_id,contract_id,title,opened_at) VALUES ($1,$2,$3,$4,$5)',[incidentId,propertyId,c.id,'Humedad','2026-07-01']);

  const impact=(await call('GET',`contracts/${c.id}/impact`)).body;
  assert.equal(impact.can_delete,true);
  assert.ok(impact.remove.some(item=>/Cuotas/.test(item.label)&&item.count===12));
  assert.ok(impact.remove.some(item=>/Servicios y cargos recurrentes/.test(item.label)&&item.count===1));
  assert.ok(impact.unlink.some(item=>/Incidencias/.test(item.label)));
  assert.ok(impact.unlink.some(item=>/Documentos PDF/.test(item.label)));
  assert.deepEqual(impact.keep.filter(item=>item.type!=='history').map(item=>item.id).sort(),[propertyId,tenantId,ownerId].sort());
  assert.ok(impact.irreversible.length>0);

  const unconfirmed=await call('DELETE',`contracts/${c.id}`,{});
  assert.equal(unconfirmed.status,400);assert.equal(await count(db,'contracts'),1);
  const deleted=await call('DELETE',`contracts/${c.id}`,{confirm:true,reason:'Cargado por error'});
  assert.equal(deleted.status,200);
  assert.equal(await count(db,'contracts'),0);assert.equal(await count(db,'installments'),0);assert.equal(await count(db,'recurring_charges'),0);
  assert.equal(await count(db,'properties'),1);assert.equal(await count(db,'persons'),2);
  assert.equal(await count(db,'property_owners'),1,'la titularidad de la propiedad no depende del contrato');
  assert.equal((await db.query('SELECT contract_id FROM documents WHERE id=$1',[c.documentId])).rows[0].contract_id,null);
  assert.equal((await db.query('SELECT contract_id,property_id FROM incidents WHERE id=$1',[incidentId])).rows[0].contract_id,null);
  assert.equal(fs.existsSync(pdf),true,'el PDF físico nunca se borra al eliminar un contrato');
  assert.equal(await count(db,'audit_log',`WHERE entity_type='contract' AND action='deleted'`),1);
  const again=await call('DELETE',`contracts/${c.id}`,{confirm:true});
  assert.equal(again.status,200);assert.equal(again.body.alreadyDeleted,true);
  const tenants=(await call('GET','tenants')).body;
  assert.ok(tenants.some(row=>row.id===tenantId&&!row.contract_id),'el inquilino sin contratos sigue siendo administrable');
});

test('6. un propietario con varios inmuebles se conserva al eliminar el contrato de uno',async t=>{
  const {db,call}=await setup(t);
  const ownerId=await person(db,'Paula Multi','20666777',true),tenantId=await person(db,'Inq Multi','40666777');
  const properties=[await property(db,'Multi 1'),await property(db,'Multi 2'),await property(db,'Multi 3')];
  for(const propertyId of properties)await db.query('INSERT INTO property_owners(property_id,person_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',[propertyId,ownerId]);
  const c=await contract(db,{code:'MULTI-1',propertyId:properties[0],tenantId,ownerId,start:'2026-06-01'});
  const keep=(await call('GET',`contracts/${c.id}/impact`)).body.keep.find(item=>item.id===ownerId);
  assert.match(keep.detail,/Conserva 3 propiedades/);
  assert.equal((await call('DELETE',`contracts/${c.id}`,{confirm:true})).status,200);
  assert.equal(await count(db,'persons','WHERE id=$1',[ownerId]),1);
  assert.equal(await count(db,'property_owners','WHERE person_id=$1',[ownerId]),3);
  const owners=(await call('GET','owners')).body;
  assert.equal(owners.find(row=>row.id===ownerId).properties_count,3);
  const ownerImpact=(await call('GET',`owners/${ownerId}/impact`)).body;
  assert.equal(ownerImpact.can_delete,true);
  assert.equal(ownerImpact.keep.length,3);
  assert.ok(ownerImpact.remove.some(item=>/Vínculos con propiedades/.test(item.label)&&item.count===3));
});

test('7. una propiedad con contratos históricos no se borra; se archiva cuando no tiene contratos vigentes',async t=>{
  const {db,call}=await setup(t);
  const propertyId=await property(db,'Historia 700'),tenantId=await person(db,'Inq Historia','40777888');
  await contract(db,{code:'HIST-2024',propertyId,tenantId,start:'2024-01-01',status:'Finalizado'});
  const current=await contract(db,{code:'HIST-2026',propertyId,tenantId,start:'2026-06-01'});
  const deletion=await call('DELETE',`properties/${propertyId}`,{confirm:true});
  assert.equal(deletion.status,400);assert.match(deletion.body.error,/2 contratos/);
  const archiveBlocked=await call('POST',`properties/${propertyId}/archive`,{});
  assert.equal(archiveBlocked.status,400);assert.match(archiveBlocked.body.error,/contrato vigente/);
  assert.equal((await call('DELETE',`contracts/${current.id}`,{confirm:true})).status,200);
  assert.equal((await call('DELETE',`properties/${propertyId}`,{confirm:true})).status,400,'el contrato histórico sigue protegiendo la propiedad');
  assert.equal((await call('POST',`properties/${propertyId}/archive`,{})).status,200);
  assert.ok((await call('GET','properties')).body.find(row=>row.id===propertyId).archived_at);
  assert.equal((await call('POST',`properties/${propertyId}/archive`,{})).body.unchanged,true);
  assert.equal((await call('POST',`properties/${propertyId}/restore`,{})).body.archived,false);
  assert.equal(await count(db,'contracts','WHERE property_id=$1',[propertyId]),1);
});

test('8. un registro sin dependencias se puede eliminar explícitamente',async t=>{
  const {db,call}=await setup(t);
  const propertyId=await property(db,'Libre 800'),ownerId=await person(db,'Dueño Libre','20888999',true),loose=await person(db,'Persona Suelta','40888999');
  await db.query('INSERT INTO property_owners(property_id,person_id) VALUES ($1,$2)',[propertyId,ownerId]);
  const impact=(await call('GET',`properties/${propertyId}/impact`)).body;
  assert.equal(impact.can_delete,true);assert.equal(impact.keep[0].id,ownerId);
  assert.equal((await call('DELETE',`properties/${propertyId}`,{})).status,400,'requiere confirmación');
  assert.equal((await call('DELETE',`properties/${propertyId}`,{confirm:true})).status,200);
  assert.equal(await count(db,'properties'),0);
  assert.equal(await count(db,'persons','WHERE id=$1',[ownerId]),1,'el propietario no se borra junto con la propiedad');
  assert.equal((await call('DELETE',`tenants/${loose}`,{confirm:true})).status,200);
  assert.equal(await count(db,'persons','WHERE id=$1',[loose]),0);
  assert.equal(await count(db,'audit_log',`WHERE action='deleted'`),2);
});

test('9. un PDF cuyo contrato fue eliminado se puede volver a importar sin duplicar archivos ni documentos',async t=>{
  const {db,call,upload,directory}=await setup(t);
  const first=await upload('contrato-reimport.pdf');
  assert.equal(first.status,201);assert.equal(first.body.status,'Revisión');
  const done=await completeImportReview(db,first.body.id,{});
  assert.equal((await call('DELETE',`contracts/${done.contractId}`,{confirm:true})).status,200);
  assert.equal((await db.query('SELECT status FROM imports WHERE id=$1',[first.body.id])).rows[0].status,'Revertido');
  assert.equal(await count(db,'documents','WHERE contract_id IS NULL'),1);

  const scan=await scanImportDirectory(db);
  assert.equal(scan.imported,0,'la carpeta monitoreada no reimporta sola un contrato eliminado');
  const entry=(await collectEntries(db)).entries.find(item=>item.import_ids.includes(first.body.id));
  assert.equal(entry.state,'contract_deleted');assert.ok(entry.actions.includes('reprocess'));

  const again=await upload('contrato-reimport.pdf');
  assert.equal(again.status,201);assert.equal(again.body.status,'Revisión');
  assert.equal((await db.query('SELECT previous_import_id FROM imports WHERE id=$1',[again.body.id])).rows[0].previous_import_id,first.body.id);
  const redone=await completeImportReview(db,again.body.id,{});
  assert.ok(redone.contractId&&redone.contractId!==done.contractId);
  assert.equal(await count(db,'documents'),1,'reutiliza el documento conservado');
  assert.equal(await count(db,'imports'),2,'cada intento queda registrado');
  assert.deepEqual(fs.readdirSync(directory),['contrato-reimport.pdf'],'no crea copias -2.pdf');
});

test('10. un PDF duplicado de un contrato vigente sigue bloqueado y explica el motivo',async t=>{
  const {db,call,upload,directory}=await setup(t);
  const first=await upload('vigente.pdf');await completeImportReview(db,first.body.id,{});
  const again=await upload('otro-nombre.pdf');
  assert.equal(again.status,200);assert.equal(again.body.status,'Omitido');assert.equal(again.body.reasonCode,'linked');
  assert.match(again.body.reason,/Ya existe un contrato asociado a este documento/);
  fs.copyFileSync(sample,path.join(directory,'copia-vigente.pdf'));
  assert.equal((await scanImportDirectory(db)).imported,0);
  assert.equal(await count(db,'contracts'),1);
  const entries=(await call('GET','document-admin')).body.entries;
  const original=entries.find(item=>item.filename==='vigente.pdf'),copy=entries.find(item=>item.filename==='copia-vigente.pdf');
  assert.equal(original.state,'imported');assert.ok(!original.actions.includes('delete_file'));assert.match(original.blocked.delete_file,/respaldo del contrato/);
  assert.equal(copy.state,'duplicate');assert.match(copy.reason,/copia de «vigente.pdf»/);
  assert.ok(copy.actions.includes('delete_file'));assert.ok(!copy.actions.includes('reprocess'));
  const blockedDelete=await call('POST','document-admin/delete-file',{ref:original.ref,confirm:true});
  assert.equal(blockedDelete.status,400);assert.equal(fs.existsSync(path.join(directory,'vigente.pdf')),true);
});

test('11. una importación fallida se reintenta como un intento nuevo y trazable',async t=>{
  const {db,call,directory}=await setup(t);
  const file=path.join(directory,'fallido.pdf');fs.copyFileSync(sample,file);
  const failedId=uid();
  await db.query('INSERT INTO imports(id,filename,absolute_path,sha256,status,error_message) VALUES ($1,$2,$3,$4,$5,$6)',[failedId,'fallido.pdf',file,sampleSha,'Error','PDF dañado']);
  assert.equal((await scanImportDirectory(db)).imported,0,'el scanner no reintenta solo');
  const entry=(await call('GET','document-admin')).body.entries.find(item=>item.filename==='fallido.pdf');
  assert.equal(entry.state,'failed');assert.match(entry.reason,/PDF dañado/);
  const retried=await call('POST','document-admin/reprocess',{ref:entry.ref});
  assert.equal(retried.status,200);assert.equal(retried.body.status,'Revisión');
  const rows=(await db.query('SELECT id,status,previous_import_id FROM imports ORDER BY created_at')).rows;
  assert.deepEqual(rows.map(row=>row.status),['Error','Revisión']);
  assert.equal(rows[1].previous_import_id,failedId);
  const repeated=await call('POST','document-admin/reprocess',{ref:entry.ref});
  assert.equal(repeated.status,400,'no crea un segundo intento mientras hay uno en revisión');
  assert.equal(await count(db,'imports'),2);
  assert.equal((await call('GET','document-admin')).body.entries.find(item=>item.filename==='fallido.pdf').history.length,2);
});

test('12. excluir un PDF impide su importación automática hasta quitar la exclusión',async t=>{
  const {db,call,upload,directory}=await setup(t);
  fs.copyFileSync(sample,path.join(directory,'nuevo.pdf'));
  const entry=(await call('GET','document-admin')).body.entries.find(item=>item.filename==='nuevo.pdf');
  assert.equal(entry.state,'pending');assert.deepEqual(entry.ref,{file:'nuevo.pdf'});
  assert.equal((await call('POST','document-admin/exclude',{ref:entry.ref,reason:'Borrador sin firmar'})).status,200);
  assert.equal((await scanImportDirectory(db)).imported,0);
  const excluded=(await call('GET','document-admin')).body.entries.find(item=>item.filename==='nuevo.pdf');
  assert.equal(excluded.state,'excluded');assert.match(excluded.reason,/Borrador sin firmar/);
  const blockedUpload=await upload('nuevo.pdf');
  assert.equal(blockedUpload.body.status,'Omitido');assert.equal(blockedUpload.body.reasonCode,'excluded');
  assert.deepEqual(fs.readdirSync(directory),['nuevo.pdf'],'la subida reutiliza el archivo existente');
  assert.equal((await call('POST','document-admin/unexclude',{ref:excluded.ref})).status,200);
  assert.equal((await scanImportDirectory(db)).imported,1);
  assert.equal(await count(db,'audit_log',`WHERE entity_type='document_file' AND action IN ('excluded','unexcluded')`),2);
});

test('13. eliminar un PDF del equipo requiere confirmación, conserva el registro y es idempotente',async t=>{
  const {db,call,directory}=await setup(t);
  const file=path.join(directory,'descartar.pdf');fs.copyFileSync(sample,file);
  await scanImportDirectory(db);
  const importId=(await db.query('SELECT id FROM imports LIMIT 1')).rows[0].id;
  assert.equal((await call('POST',`imports/${importId}/discard`,{reason:'Equivocado'})).status,200);
  const entry=(await call('GET','document-admin')).body.entries[0];
  assert.equal(entry.state,'discarded');assert.ok(entry.actions.includes('delete_file'));
  assert.equal((await call('POST','document-admin/delete-file',{ref:entry.ref})).status,400);
  assert.equal(fs.existsSync(file),true);
  const deleted=await call('POST','document-admin/delete-file',{ref:entry.ref,confirm:true,reason:'Copia equivocada'});
  assert.equal(deleted.status,200);assert.equal(fs.existsSync(file),false);
  assert.equal(await count(db,'imports'),1,'"Eliminar PDF del equipo" no quita el registro');
  assert.equal(await count(db,'audit_log',`WHERE entity_type='document_file' AND action='file_deleted'`),1);
  const again=await call('POST','document-admin/delete-file',{ref:entry.ref,confirm:true});
  assert.equal(again.status,200);assert.equal(again.body.alreadyDeleted,true);
  const removed=await call('POST','document-admin/delete-record',{ref:entry.ref,confirm:true});
  assert.equal(removed.status,200);assert.equal(removed.body.excluded,false);
  assert.equal(await count(db,'imports'),0);
});

test('14. no se borran archivos fuera de la carpeta administrada, enlaces simbólicos ni rutas con ../',async t=>{
  const {db,call,directory}=await setup(t);
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'ferraro-outside-'));t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  const victim=path.join(outside,'ajeno.pdf');fs.copyFileSync(sample,victim);
  const outsideId=uid();
  await db.query('INSERT INTO imports(id,filename,absolute_path,sha256,status) VALUES ($1,$2,$3,$4,$5)',[outsideId,'ajeno.pdf',victim,sampleSha,'Descartado']);
  const traversalId=uid(),traversal=path.join(directory,'..',path.basename(outside),'ajeno.pdf');
  await db.query('INSERT INTO imports(id,filename,absolute_path,sha256,status) VALUES ($1,$2,$3,$4,$5)',[traversalId,'ajeno.pdf',traversal,'b'.repeat(64),'Descartado']);
  const link=path.join(directory,'enlace.pdf');fs.symlinkSync(victim,link);
  const linkId=uid();
  await db.query('INSERT INTO imports(id,filename,absolute_path,sha256,status) VALUES ($1,$2,$3,$4,$5)',[linkId,'enlace.pdf',link,'c'.repeat(64),'Descartado']);

  const outsideTry=await call('POST','document-admin/delete-file',{ref:{import_id:outsideId},confirm:true});
  assert.equal(outsideTry.status,400);assert.match(outsideTry.body.error,/fuera de la carpeta/);
  const traversalTry=await call('POST','document-admin/delete-file',{ref:{import_id:traversalId},confirm:true});
  assert.equal(traversalTry.status,400);assert.match(traversalTry.body.error,/fuera de la carpeta/);
  const linkTry=await call('POST','document-admin/delete-file',{ref:{import_id:linkId},confirm:true});
  assert.equal(linkTry.status,400);assert.match(linkTry.body.error,/enlace simbólico/);
  const nameTry=await call('POST','document-admin/delete-file',{ref:{file:`../${path.basename(outside)}/ajeno.pdf`},confirm:true});
  assert.equal(nameTry.status,400);assert.match(nameTry.body.error,/Referencia de archivo inválida/);
  const pathTry=await call('POST','document-admin/delete-file',{ref:{absolute_path:victim},confirm:true});
  assert.equal(pathTry.status,400);
  const viewTry=await call('GET',`document-admin/file?import_id=${outsideId}`);
  assert.equal(viewTry.status,400);
  assert.equal(fs.existsSync(victim),true);assert.equal(fs.existsSync(link),true);
});

test('15. un fallo dentro de una operación revierte todas sus escrituras',async t=>{
  const {db,call,directory}=await setup(t);
  const cleanup=async()=>{await db.query('DROP TRIGGER IF EXISTS ferraro_test_fail ON contracts');await db.query('DROP TRIGGER IF EXISTS ferraro_test_fail_audit ON audit_log');await db.query('DROP FUNCTION IF EXISTS ferraro_test_fail()');};
  try{
  const propertyId=await property(db,'Rollback 1500'),tenantId=await person(db,'Inq Rollback','41500000');
  const pdf=path.join(directory,'rollback.pdf');fs.copyFileSync(sample,pdf);
  const c=await contract(db,{code:'ROLLBACK',propertyId,tenantId,start:'2026-06-01',documentPath:pdf,sha:sampleSha});
  const importId=uid();
  await db.query(`INSERT INTO imports(id,filename,absolute_path,sha256,status,result_json) VALUES ($1,$2,$3,$4,'Procesado',$5)`,[importId,'rollback.pdf',pdf,sampleSha,JSON.stringify({completion_result:{contractId:c.id,documentId:c.documentId}})]);
  await db.query(`CREATE FUNCTION ferraro_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fallo simulado'; END$$`);
  await db.query(`CREATE TRIGGER ferraro_test_fail BEFORE DELETE ON contracts FOR EACH ROW WHEN (OLD.code='ROLLBACK') EXECUTE FUNCTION ferraro_test_fail()`);
  const deletion=await call('DELETE',`contracts/${c.id}`,{confirm:true});
  assert.equal(deletion.status,400);assert.match(deletion.body.error,/fallo simulado/);
  assert.equal(await count(db,'installments','WHERE contract_id=$1',[c.id]),12);
  assert.equal(await count(db,'guarantees','WHERE contract_id=$1',[c.id]),1);
  assert.equal((await db.query('SELECT contract_id FROM documents WHERE id=$1',[c.documentId])).rows[0].contract_id,c.id);
  assert.equal((await db.query('SELECT status FROM imports WHERE id=$1',[importId])).rows[0].status,'Procesado');
  await db.query('DROP TRIGGER ferraro_test_fail ON contracts');

  await db.query(`CREATE TRIGGER ferraro_test_fail_audit BEFORE INSERT ON audit_log FOR EACH ROW WHEN (NEW.action='deactivated') EXECUTE FUNCTION ferraro_test_fail()`);
  assert.equal((await call('POST',`contracts/${c.id}/deactivate`,{})).status,400);
  const row=(await db.query('SELECT status,deactivated_from_status,deactivated_at FROM contracts WHERE id=$1',[c.id])).rows[0];
  assert.deepEqual(row,{status:'Activo',deactivated_from_status:null,deactivated_at:null});
  }finally{await cleanup();}
});

test('16. pagos, cuotas y versiones IPC quedan intactos después de las operaciones',async t=>{
  const {db,call,upload}=await setup(t);
  const uploaded=await upload('ipc-integridad.pdf');
  const {contractId}=await completeImportReview(db,uploaded.body.id,{});
  const first=(await db.query('SELECT id FROM installments WHERE contract_id=$1 ORDER BY period LIMIT 1',[contractId])).rows[0].id;
  const paid=await call('POST',`payments/${first}/register`,{amount:420000,paid_at:'2026-06-05'});
  assert.equal(paid.status,201,JSON.stringify(paid.body));
  const installments=await installmentsSnapshot(db,contractId),finance=await financialSnapshot(db);
  assert.ok(installments.some(row=>row.ipc_managed&&row.calculation_hash),'el contrato importado usa el motor IPC');

  const deactivated=await call('POST',`contracts/${contractId}/deactivate`,{});
  assert.equal(deactivated.status,200,JSON.stringify(deactivated.body));
  const reactivated=await call('POST',`contracts/${contractId}/reactivate`,{});
  assert.equal(reactivated.status,200,JSON.stringify(reactivated.body));
  assert.equal((await call('POST',`contracts/${contractId}/archive`,{})).status,400);
  assert.equal((await call('DELETE',`contracts/${contractId}`,{confirm:true})).status,400);
  const impact=await call('GET',`contracts/${contractId}/impact`);
  assert.equal(impact.status,200,JSON.stringify(impact.body));
  const document=(await call('GET','document-admin')).body.entries.find(item=>item.contract?.id===contractId);
  assert.equal((await call('POST','document-admin/delete-file',{ref:document.ref,confirm:true})).status,400);
  assert.equal((await call('POST','document-admin/delete-record',{ref:document.ref,confirm:true})).status,400);
  await scanImportDirectory(db);

  assert.deepEqual(await installmentsSnapshot(db,contractId),installments);
  assert.deepEqual(await financialSnapshot(db),finance);
  assert.equal(await count(db,'contracts'),1);
});
