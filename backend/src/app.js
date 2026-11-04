const {serviceDetails,serviceOperation}=require('./modules/services');
const {assertAdministrativeChange}=require('./modules/contracts/protection');
const {protection:contractProtection,rectify:rectifyContract}=require('./modules/contracts/rectification');
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {openDatabase,allSettings,uid,normalizeAddress}=require('./database');
const {scanImportDirectory,importPdf,completeImportReview,withImportLock}=require('./modules/imports/contract-parser');
const {latestIpcSummary,loadStoredSeries}=require('./modules/ipc/store');
const {generateInstallments,reconcileOnClient,reconcileInstallments,applyReconciliationBatch,simulateContractChanges,refreshAndUpdate}=require('./modules/rent');
const {addMonths:calendarAddMonths,dateKey}=require('./lib/calendar');
const {balance,scaled,decimal,paymentStatus}=require('./lib/money');
const {handleWhatsAppApi,triggerAutomation,normalizePhone}=require('./modules/whatsapp');
const {createWhatsAppGatewayWorker}=require('./modules/whatsapp-gateway');
const geo=require('./modules/geo');
const {handleDocumentAdminApi}=require('./modules/imports/document-admin');
const PUBLIC_DIR=path.resolve(__dirname,'..','..','frontend','dist');

function json(res,status,payload){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(payload));}
function text(res,status,payload){res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});res.end(String(payload));}
async function readRawBody(req){const chunks=[];let size=0;for await(const chunk of req){chunks.push(chunk);size+=chunk.length;if(size>5_000_000)throw new Error('La solicitud supera el límite permitido.');}return Buffer.concat(chunks);}
async function readBody(req){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>2_000_000)throw new Error('La solicitud supera el límite permitido.');}return raw?JSON.parse(raw):{};}
async function readMultipart(req){
  return new Promise((resolve,reject)=>{
    try{
      const contentType=req.headers['content-type']||'';
      const boundaryMatch=contentType.match(/boundary=([^;\s]+)/);
      if(!boundaryMatch)return reject(new Error('No boundary encontrado en Content-Type'));
      const boundary=boundaryMatch[1];
      const chunks=[];
      req.on('data',chunk=>chunks.push(chunk));
      req.on('error',reject);
      req.on('end',()=>{
        try{
          const buffer=Buffer.concat(chunks);
          const bufStr=buffer.toString('binary');
          const boundary_str='--'+boundary;
          const parts=bufStr.split(boundary_str);
          const files={},fields={};
          for(let i=1;i<parts.length-1;i++){
            const part=parts[i];
            const headerEnd=part.indexOf('\r\n\r\n');
            if(headerEnd===-1)continue;
            const headerStr=part.substring(0,headerEnd);
            const bodyEnd=part.lastIndexOf('\r\n');
            const body=part.substring(headerEnd+4,bodyEnd);
            const nameMatch=headerStr.match(/name="([^"]+)"/);
            if(!nameMatch)continue;
            const name=nameMatch[1];
            const filenameMatch=headerStr.match(/filename="([^"]+)"/);
            if(filenameMatch){
              const filename=filenameMatch[1];
              files[name]={filename,data:Buffer.from(body,'binary')};
            }else{
              fields[name]=body;
            }
          }
          resolve({files,fields});
        }catch(err){reject(err);}
      });
    }catch(err){reject(err);}
  });
}
function safeUploadName(filename='contrato.pdf'){
  const parsed=path.parse(filename);
  const base=(parsed.name||'contrato').replace(/[^a-z0-9áéíóúñü _.-]/gi,' ').replace(/\s+/g,' ').trim().slice(0,120)||'contrato';
  return `${base}.pdf`;
}
function uniquePath(directory,filename){
  const parsed=path.parse(filename);
  let candidate=path.join(directory,filename),index=2;
  while(fs.existsSync(candidate)){
    candidate=path.join(directory,`${parsed.name}-${index}${parsed.ext}`);
    index+=1;
  }
  return candidate;
}
async function persistUploadedContract(db,file){
  if(path.extname(file.filename||'').toLowerCase()!=='.pdf')throw new Error('Solo se aceptan archivos PDF');
  const sha256=crypto.createHash('sha256').update(file.data).digest('hex');
  return withImportLock(db,`upload:${sha256}`,async db=>{
  // Reusa la copia ya registrada con el mismo contenido para no acumular "-2.pdf" en la carpeta.
  const known=(await db.query(`SELECT absolute_path FROM documents WHERE sha256=$1 UNION SELECT absolute_path FROM imports WHERE sha256=$1 UNION SELECT absolute_path FROM import_exclusions WHERE sha256=$1 AND absolute_path IS NOT NULL ORDER BY absolute_path`,[sha256])).rows.map(row=>row.absolute_path);
  const existing=known.find(candidate=>{try{return fs.statSync(candidate).isFile()&&crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex')===sha256;}catch{return false;}});
  if(existing)return{path:existing,sha256,alreadyStored:true};
  const settings=await allSettings(db),directory=path.resolve(settings.import_directory);
  fs.mkdirSync(directory,{recursive:true});
  const diskCopy=fs.readdirSync(directory,{withFileTypes:true}).filter(entry=>entry.isFile()&&/\.pdf$/i.test(entry.name)).map(entry=>path.join(directory,entry.name)).find(candidate=>crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex')===sha256);
  if(diskCopy)return{path:diskCopy,sha256,alreadyStored:true};
  const destination=uniquePath(directory,safeUploadName(file.filename));
  fs.writeFileSync(destination,file.data);
  return{path:destination,sha256,alreadyStored:false};
  });
}
const rows=async(db,sql,params=[])=>(await db.query(sql,params)).rows;
const one=async(db,sql,params=[])=>rows(db,sql,params).then(result=>result[0]);

async function enrichInstallmentsWithIpc(db,installments){
  return installments.map(row=>({...row,expected_amount:Number(row.expected_amount),ipc_applied:Boolean(row.calculation_json?.applied),ipc_pending_official_data:Boolean(row.adjustment_pending),ipc_source_period:row.calculation_json?.sourcePeriod||null,ipc_requires_reconciliation:row.adjustment_index==='IPC'&&!row.ipc_managed}));
}
function withCollectionTotals(row){
  const signed=Number(balance(row)),total=Number(balance(row,0));
  return {...row,vat_amount:Number(row.vat_amount||0),late_fee_amount:Number(row.late_fee_amount||0),discount_amount:Number(row.discount_amount||0),manual_partial_amount:Number(row.manual_partial_amount||0),paid_amount:Number(row.paid_amount||0),due_amount:Math.max(0,signed),balance:signed,overpayment_amount:Math.max(0,-signed),total_amount:total};
}

// Cuotas que todavía se pueden cobrar: contratos vigentes y deudas no sustituidas de contratos renovados.
const COLLECTIBLE_INSTALLMENT_SQL=`i.status<>'Sustituido' AND (i.status<>'Pagado' OR i.adjustment_pending) AND c.status IN ('Activo','Revisión','Renovado')`;

async function dashboard(db){
  const today=new Date().toISOString().slice(0,10),month=today.slice(0,7);
  const baseKpis=await one(db,`SELECT
    (SELECT COUNT(*)::int FROM properties) properties,
    (SELECT COUNT(*)::int FROM contracts WHERE status IN ('Activo','Revisión')) active_contracts,
    (SELECT COUNT(*)::int FROM installments i JOIN contracts c ON c.id=i.contract_id WHERE ${COLLECTIBLE_INSTALLMENT_SQL} AND i.due_date<$1::date) overdue_count,
    (SELECT COALESCE(SUM(amount),0)::float FROM payments WHERE to_char(paid_at,'YYYY-MM')=$2) collected_month,
    (SELECT COUNT(*)::int FROM imports WHERE status='Revisión') reviews,
    (SELECT COUNT(*)::int FROM incidents WHERE status NOT IN ('Resuelta','Cerrada')) open_incidents`,[today,month]);
  const dueRaw=await rows(db,`SELECT i.*,(COALESCE((SELECT SUM(amount) FROM payments WHERE installment_id=i.id),0)+i.manual_partial_amount)::text paid_amount,c.adjustment_index,c.adjustment_frequency_months,c.initial_amount::float,c.start_date,p.address property,pe.full_name tenant
    FROM installments i JOIN contracts c ON c.id=i.contract_id JOIN properties p ON p.id=c.property_id JOIN persons pe ON pe.id=c.tenant_id
    WHERE ${COLLECTIBLE_INSTALLMENT_SQL} ORDER BY i.due_date LIMIT 8`);
  const due=(await enrichInstallmentsWithIpc(db,dueRaw)).map(withCollectionTotals);
  const monthInstallments=await rows(db,`SELECT i.*,(COALESCE((SELECT SUM(amount) FROM payments WHERE installment_id=i.id),0)+i.manual_partial_amount)::text paid_amount,c.adjustment_index,c.adjustment_frequency_months,c.initial_amount::float,c.start_date
    FROM installments i JOIN contracts c ON c.id=i.contract_id WHERE i.period=$1 AND c.status IN ('Activo','Revisión')`,[month]);
  const enrichedMonth=(await enrichInstallmentsWithIpc(db,monthInstallments)).map(withCollectionTotals);
  const expectedByCurrency={};for(const row of enrichedMonth)expectedByCurrency[row.currency]=decimal(scaled(expectedByCurrency[row.currency])+scaled(row.total_amount));
  const collectedByCurrency=Object.fromEntries((await rows(db,`SELECT i.currency,SUM(p.amount)::text total FROM payments p JOIN installments i ON i.id=p.installment_id WHERE to_char(p.paid_at,'YYYY-MM')=$1 GROUP BY i.currency`,[month])).map(row=>[row.currency,row.total]));
  const movement=await rows(db,`SELECT to_char(pay.paid_at,'YYYY-MM') period,SUM(pay.amount)::float total FROM payments pay JOIN installments i ON i.id=pay.installment_id WHERE i.currency='ARS' AND pay.paid_at>=current_date-interval '5 months' GROUP BY 1 ORDER BY 1`);
  const ipc=await latestIpcSummary(db).catch(()=>null);
  return{kpis:{...baseKpis,expected_month:Number(expectedByCurrency.ARS||0),collected_month:Number(collectedByCurrency.ARS||0),expected_month_by_currency:expectedByCurrency,collected_month_by_currency:collectedByCurrency},due,movement,today,ipc};
}

const queries={
  properties:`SELECT p.*,string_agg(DISTINCT pe.full_name,' / ') owners,(SELECT COUNT(*)::int FROM contracts c WHERE c.property_id=p.id AND c.status IN ('Activo','Revisión')) active_contracts,(SELECT c.code FROM contracts c WHERE c.property_id=p.id AND c.status IN ('Activo','Revisión') ORDER BY c.start_date DESC LIMIT 1) active_contract_code,(SELECT c.alias FROM contracts c WHERE c.property_id=p.id AND c.status IN ('Activo','Revisión') ORDER BY c.start_date DESC LIMIT 1) active_contract_alias,(SELECT tenant.full_name FROM contracts c JOIN persons tenant ON tenant.id=c.tenant_id WHERE c.property_id=p.id AND c.status IN ('Activo','Revisión') ORDER BY c.start_date DESC LIMIT 1) active_tenant FROM properties p LEFT JOIN property_owners po ON po.property_id=p.id LEFT JOIN persons pe ON pe.id=po.person_id GROUP BY p.id ORDER BY p.address`,
  owners:`SELECT pe.id,pe.full_name,pe.person_kind,pe.first_name,pe.last_name,pe.document_type,pe.document_number,pe.tax_id,pe.vat_condition,pe.email,pe.phone,pe.whatsapp,pe.whatsapp_normalized,pe.whatsapp_opt_in,pe.whatsapp_preferences_json,pe.address,pe.country,pe.province,pe.city,pe.neighborhood,pe.liquidation_email_enabled,pe.fiscal_address,pe.gross_income_number,pe.activity_start_date,pe.archived_at,COUNT(DISTINCT po.property_id)::int properties_count,string_agg(DISTINCT p.address,' / ') properties,COALESCE(json_agg(DISTINCT po.property_id) FILTER (WHERE po.property_id IS NOT NULL),'[]'::json)::json property_ids,COALESCE((SELECT json_agg(json_build_object('id',op.id,'code',op.code,'address',op.address) ORDER BY op.address) FROM property_owners opo JOIN properties op ON op.id=opo.property_id WHERE opo.person_id=pe.id),'[]'::json) properties_list FROM persons pe LEFT JOIN property_owners po ON po.person_id=pe.id LEFT JOIN properties p ON p.id=po.property_id WHERE pe.is_owner=true OR po.person_id IS NOT NULL GROUP BY pe.id ORDER BY pe.full_name`,
  people:`SELECT pe.*,CASE WHEN COUNT(po.person_id)>0 THEN 'Propietario' END owner_role,CASE WHEN COUNT(c.id)+COUNT(ct.contract_id)>0 THEN 'Inquilino' END tenant_role FROM persons pe LEFT JOIN property_owners po ON po.person_id=pe.id LEFT JOIN contracts c ON c.tenant_id=pe.id LEFT JOIN contract_tenants ct ON ct.person_id=pe.id GROUP BY pe.id ORDER BY pe.full_name`,
  tenants:`WITH tenant_links AS (SELECT tenant_id person_id,id contract_id FROM contracts UNION SELECT person_id,contract_id FROM contract_tenants) SELECT pe.id,pe.full_name,pe.archived_at,pe.person_kind,pe.first_name,pe.last_name,pe.document_type,pe.document_number,pe.tax_id,pe.vat_condition,pe.nationality,pe.email,pe.phone,pe.whatsapp,pe.address,pe.country,pe.province,pe.city,pe.neighborhood,c.id contract_id,c.code contract_code,c.alias contract_alias,c.status contract_status,c.start_date,c.end_date,p.address property,COALESCE(g.gu_count,0)::int guarantors_count,g.names guarantors,COALESCE(g.items,'[]'::json)::json guarantors_json FROM persons pe LEFT JOIN tenant_links tl ON tl.person_id=pe.id LEFT JOIN contracts c ON c.id=tl.contract_id LEFT JOIN properties p ON p.id=c.property_id LEFT JOIN LATERAL (SELECT COUNT(*) gu_count,string_agg(COALESCE(gg.guarantor_name,gg.provider_detail,gg.provider), ' / ' ORDER BY COALESCE(gg.guarantor_name,gg.provider_detail,gg.provider)) names,json_agg(json_build_object('id',gg.id,'full_name',COALESCE(gg.guarantor_name,gg.provider_detail,gg.provider,gg.guarantee_type),'document_number',gg.guarantor_document,'email',gg.guarantor_email,'phone',gg.guarantor_phone,'address',COALESCE(gg.guarantor_address,gg.guaranteed_property),'guarantee_type',gg.guarantee_type,'provider',gg.provider,'provider_detail',gg.provider_detail,'contract_id',gg.contract_id)) items FROM guarantees gg WHERE gg.contract_id=c.id AND COALESCE(gg.guarantor_name,gg.provider_detail,gg.provider,gg.guarantee_type) IS NOT NULL) g ON true WHERE tl.person_id IS NOT NULL OR (NOT pe.is_owner AND NOT EXISTS (SELECT 1 FROM property_owners po WHERE po.person_id=pe.id)) ORDER BY pe.full_name,c.start_date DESC NULLS LAST`,
  guarantors:`SELECT g.id,g.contract_id,COALESCE(g.guarantor_name,g.provider_detail,g.provider,g.guarantee_type) full_name,g.guarantor_document document_number,g.guarantor_email email,g.guarantor_phone phone,g.guarantor_address address,g.guarantee_type,g.provider,g.provider_detail,g.guaranteed_property,g.policy_number,g.expiry_date,g.notes,c.code contract_code,c.alias contract_alias,c.status contract_status,p.address property,pe.full_name tenant FROM guarantees g JOIN contracts c ON c.id=g.contract_id JOIN properties p ON p.id=c.property_id JOIN persons pe ON pe.id=c.tenant_id WHERE COALESCE(g.guarantor_name,g.provider_detail,g.provider,g.guarantee_type) IS NOT NULL ORDER BY full_name`,
  contracts:`SELECT c.*,c.initial_amount::float,c.deposit_amount::float,c.management_fee_pct::float,c.adjustment_value_pct::float,c.vat_percentage::float,c.rescission_penalty::float,c.deposit_returned_amount::float,p.address property,pe.id tenant_id,pe.full_name tenant,g.id guarantee_id,g.guarantee_type,g.provider,g.provider_detail,g.guarantor_name,g.guarantor_document,g.guaranteed_property,string_agg(DISTINCT own.full_name,', ') owners,string_agg(DISTINCT own.id::text,',') owner_ids,d.absolute_path document_path,d.filename document_filename,(SELECT prev.code FROM contracts prev WHERE prev.id=c.previous_contract_id) previous_contract_code,(SELECT nxt.code FROM contracts nxt WHERE nxt.previous_contract_id=c.id ORDER BY nxt.start_date DESC LIMIT 1) next_contract_code FROM contracts c JOIN properties p ON p.id=c.property_id JOIN persons pe ON pe.id=c.tenant_id LEFT JOIN guarantees g ON g.contract_id=c.id LEFT JOIN contract_owners co ON co.contract_id=c.id LEFT JOIN persons own ON own.id=co.person_id LEFT JOIN documents d ON d.id=c.source_document_id GROUP BY c.id,p.address,pe.id,pe.full_name,g.id,g.guarantee_type,g.provider,g.provider_detail,g.guarantor_name,g.guarantor_document,g.guaranteed_property,d.absolute_path,d.filename ORDER BY c.start_date DESC`,
  collections:`SELECT pay.id,pay.installment_id,pay.amount::float,pay.paid_at,pay.method,pay.bank_name,pay.reference,pay.notes,pay.payment_type,pay.account_name,pay.tax_status,pay.is_split,pay.created_at,i.period,i.currency,c.id contract_id,c.code contract_code,c.alias contract_alias,p.address property,pe.full_name tenant,('Alquiler de ' || to_char(i.due_date,'TMMonth YYYY')) description,'Pagado' status FROM payments pay JOIN installments i ON i.id=pay.installment_id JOIN contracts c ON c.id=i.contract_id JOIN properties p ON p.id=c.property_id JOIN persons pe ON pe.id=c.tenant_id ORDER BY pay.paid_at DESC,pay.created_at DESC`,
  'pending-collections':`SELECT i.*,i.expected_amount::text,i.vat_amount::text,i.late_fee_amount::text,i.discount_amount::text,i.declared_amount::float,i.manual_partial_amount::text,i.discount_percentage::float,(COALESCE((SELECT SUM(pay.amount) FROM payments pay WHERE pay.installment_id=i.id),0)+i.manual_partial_amount)::text paid_amount,p.address property,pe.full_name tenant,c.id contract_id,c.code contract_code,c.alias contract_alias,c.adjustment_type,c.adjustment_value_pct,c.ipc_lag_months,c.end_date,c.notes,c.adjustment_index,c.adjustment_frequency_months,c.initial_amount::float,c.start_date,c.payment_due_day,c.late_fee_json,c.bank_name,c.cbu FROM installments i JOIN contracts c ON c.id=i.contract_id JOIN properties p ON p.id=c.property_id JOIN persons pe ON pe.id=c.tenant_id WHERE ${COLLECTIBLE_INSTALLMENT_SQL} ORDER BY i.due_date`,
  incidents:`SELECT i.*,p.address property FROM incidents i LEFT JOIN properties p ON p.id=i.property_id ORDER BY i.opened_at DESC`,
  ledger:`SELECT l.*,l.amount::float,p.address property FROM ledger_entries l LEFT JOIN properties p ON p.id=l.property_id ORDER BY l.entry_date DESC,l.created_at DESC`,
  expenses:`SELECT l.*,l.amount::float,p.address property FROM ledger_entries l LEFT JOIN properties p ON p.id=l.property_id WHERE l.kind='Gasto' AND l.category<>'Servicio' ORDER BY l.entry_date DESC,l.created_at DESC`,
  services:`SELECT l.*,l.amount::float,p.address property FROM ledger_entries l LEFT JOIN properties p ON p.id=l.property_id WHERE l.kind='Gasto' AND l.category='Servicio' ORDER BY l.entry_date DESC,l.created_at DESC`,
  'other-income':`SELECT l.*,l.amount::float,p.address property FROM ledger_entries l LEFT JOIN properties p ON p.id=l.property_id WHERE l.kind='Ingreso' ORDER BY l.entry_date DESC,l.created_at DESC`,
  documents:`SELECT d.id,d.filename,d.absolute_path,d.imported_at,p.address property,c.code contract_code FROM documents d LEFT JOIN properties p ON p.id=d.property_id LEFT JOIN contracts c ON c.id=d.contract_id ORDER BY d.imported_at DESC`,
  imports:`SELECT id,filename,absolute_path,sha256,status,confidence::float,warnings_json warnings,result_json,error_message,created_at FROM imports ORDER BY created_at DESC LIMIT 100`
};
function validateFee(value){const fee=Number(value);if(fee<2||fee>5)throw new Error('El honorario de administración debe estar entre 2% y 5%.');return fee;}
function addMonths(dateString,count){return calendarAddMonths(dateString,count);}
function endDate(start,duration){const d=new Date(`${addMonths(start,duration)}T00:00:00Z`);d.setUTCDate(d.getUTCDate()-1);return d.toISOString().slice(0,10);}
function parseManualAddress(address=''){const match=String(address).trim().match(/^(.+?)\s+(\d{1,6})(?:\s+(?:(\d{1,2})\s*°?|PB|P\.?\s*B\.?))?(?:\s*(?:depto\.?|departamento|unidad|of\.?|oficina)?\s*([A-Z0-9]+))?$/i);return{street:match?.[1]||null,street_number:match?.[2]||null,floor:match?.[3]||(/\bPB\b/i.test(address)?'PB':null),unit_label:match?.[4]||null};}
function booleanInput(value){return value===true||value==='true'||value==='on'||value==='1'||value===1;}
function cleanNullable(value){const text=String(value??'').trim();return text||null;}
function validateEmail(value){
  const email=cleanNullable(value);
  if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('El email no tiene un formato válido.');
  return email;
}
function normalizeOwnerInput(input={}){
  const personKind=input.person_kind||'PERSON';
  const firstName=cleanNullable(input.first_name);
  const lastName=cleanNullable(input.last_name);
  const fullName=cleanNullable(input.full_name)||[firstName,lastName].filter(Boolean).join(' ').trim();
  if(!fullName)throw new Error('Nombre y apellido son obligatorios.');
  const email=validateEmail(input.email);
  const liquidationEmailEnabled=booleanInput(input.liquidation_email_enabled);
  if(liquidationEmailEnabled&&!email)throw new Error('Para activar el aviso por correo tenés que cargar un email válido.');
  return{
    person_kind:personKind,
    first_name:firstName,
    last_name:lastName,
    full_name:fullName,
    document_type:input.document_type||'DNI',
    document_number:cleanNullable(input.document_number),
    tax_id:cleanNullable(input.tax_id),
    vat_condition:cleanNullable(input.vat_condition),
    email,
    phone:cleanNullable(input.phone),
    whatsapp:cleanNullable(input.whatsapp),
    whatsapp_normalized:cleanNullable(input.whatsapp)?normalizePhone(input.whatsapp):null,
    whatsapp_opt_in:input.whatsapp_opt_in===undefined?true:booleanInput(input.whatsapp_opt_in),
    whatsapp_preferences_json:input.whatsapp_preferences_json||{
      liquidations:input.whatsapp_pref_liquidations===undefined?true:booleanInput(input.whatsapp_pref_liquidations),
      payments:input.whatsapp_pref_payments===undefined?true:booleanInput(input.whatsapp_pref_payments),
      adjustments:input.whatsapp_pref_adjustments===undefined?true:booleanInput(input.whatsapp_pref_adjustments),
      expirations:input.whatsapp_pref_expirations===undefined?true:booleanInput(input.whatsapp_pref_expirations),
      documents:input.whatsapp_pref_documents===undefined?true:booleanInput(input.whatsapp_pref_documents)
    },
    address:cleanNullable(input.address),
    country:cleanNullable(input.country)||'Argentina',
    province:cleanNullable(input.province)||'CABA',
    city:cleanNullable(input.city),
    neighborhood:cleanNullable(input.neighborhood),
    liquidation_email_enabled:liquidationEmailEnabled,
    fiscal_address:cleanNullable(input.fiscal_address),
    gross_income_number:cleanNullable(input.gross_income_number),
    activity_start_date:cleanNullable(input.activity_start_date)
  };
}
function normalizeTenantInput(input={}){
  const firstName=cleanNullable(input.first_name);
  const lastName=cleanNullable(input.last_name);
  const fullName=cleanNullable(input.full_name)||[firstName,lastName].filter(Boolean).join(' ').trim();
  if(!firstName&&!fullName)throw new Error('El nombre es obligatorio.');
  if(!lastName&&String(input.person_kind||'PERSON')==='PERSON')throw new Error('El apellido es obligatorio.');
  if(!cleanNullable(input.document_number))throw new Error('El DNI es obligatorio.');
  if(!cleanNullable(input.tax_id))throw new Error('El CUIT es obligatorio.');
  return{
    full_name:fullName,
    first_name:firstName,
    last_name:lastName,
    document_type:input.document_type||'DNI',
    document_number:cleanNullable(input.document_number),
    tax_id:cleanNullable(input.tax_id),
    nationality:cleanNullable(input.nationality)||'Argentina',
    address:cleanNullable(input.address),
    city:cleanNullable(input.city),
    province:cleanNullable(input.province)||'CABA',
    country:cleanNullable(input.country)||'Argentina',
    phone:cleanNullable(input.phone),
    whatsapp:cleanNullable(input.whatsapp),
    email:validateEmail(input.email),
    person_kind:input.person_kind||'PERSON',
    vat_condition:cleanNullable(input.vat_condition)||'Consumidor final'
  };
}
async function saveOwnerPropertyLinks(client,personId,propertyIds=[]){
  const uniqueIds=[...new Set((Array.isArray(propertyIds)?propertyIds:[]).filter(Boolean))];
  await client.query('DELETE FROM property_owners WHERE person_id=$1',[personId]);
  const ownership=Number((100/Math.max(uniqueIds.length,1)).toFixed(2));
  for(let index=0;index<uniqueIds.length;index++){
    const percentage=index===uniqueIds.length-1?Number((100-ownership*(uniqueIds.length-1)).toFixed(2)):ownership;
    await client.query('INSERT INTO property_owners(property_id,person_id,ownership_percentage) VALUES ($1,$2,$3) ON CONFLICT(property_id,person_id) DO UPDATE SET ownership_percentage=excluded.ownership_percentage',[uniqueIds[index],personId,percentage]);
  }
}

async function createRecord(db,resource,input){
  const id=uid();
  if(resource==='properties'){
    if(!input.address)throw new Error('La dirección es obligatoria.');
    const province=geo.normalizeProvinceName(input.province||'CABA'),caba=geo.isCaba(province),addressParts=parseManualAddress(input.address);
    const next=Number((await one(db,'SELECT COUNT(*) total FROM properties')).total)+1;
    const client=await db.connect();
    try{await client.query('BEGIN');
      await client.query(`INSERT INTO properties(id,code,address,normalized_address,property_type,status,unit,notes,country,province,city,neighborhood,street,street_number,floor,unit_label,size_m2,bedrooms,bathrooms,market_value_usd)
        VALUES (${Array.from({length:20},(_,i)=>'$'+(i+1)).join(',')})`,[id,input.code||`INM-${String(next).padStart(3,'0')}`,input.address,normalizeAddress(input.address),input.property_type||'Departamento',input.status||'Disponible',addressParts.unit_label||null,input.notes||null,input.country||'Argentina',province,caba?null:(input.city||null),caba?(input.neighborhood||null):null,addressParts.street,addressParts.street_number,addressParts.floor,addressParts.unit_label,input.size_m2?Number(input.size_m2):null,input.bedrooms?Number(input.bedrooms):null,input.bathrooms?Number(input.bathrooms):null,input.market_value_usd?Number(input.market_value_usd):null]);
      const ownerIds=Array.isArray(input.owner_ids)?input.owner_ids.filter(Boolean):(input.owner_id?[input.owner_id]:[]);
      const ownership=Number((100/Math.max(ownerIds.length,1)).toFixed(2));
      for(let index=0;index<ownerIds.length;index++){const percentage=index===ownerIds.length-1?Number((100-ownership*(ownerIds.length-1)).toFixed(2)):ownership;await client.query('INSERT INTO property_owners(property_id,person_id,ownership_percentage) VALUES ($1,$2,$3) ON CONFLICT(property_id,person_id) DO UPDATE SET ownership_percentage=excluded.ownership_percentage',[id,ownerIds[index],percentage]);await client.query('UPDATE persons SET is_owner=true,updated_at=now() WHERE id=$1',[ownerIds[index]]);}
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }else if(resource==='people'||resource==='owners'){
    if(resource==='people'&&!input.full_name)throw new Error('El nombre es obligatorio.');
    if(resource==='owners'){
      const owner=normalizeOwnerInput(input),client=await db.connect();
      try{await client.query('BEGIN');
        await client.query(`INSERT INTO persons(id,full_name,document_type,document_number,email,phone,address,notes,person_kind,first_name,last_name,nationality,whatsapp,country,province,city,neighborhood,is_owner,tax_id,vat_condition,liquidation_email_enabled,fiscal_address,gross_income_number,activity_start_date,whatsapp_normalized,whatsapp_opt_in,whatsapp_preferences_json)
          VALUES (${Array.from({length:27},(_,i)=>'$'+(i+1)).join(',')})`,[id,owner.full_name,owner.document_type,owner.document_number,owner.email,owner.phone,owner.address,input.notes||null,owner.person_kind,owner.first_name,owner.last_name,input.nationality||null,owner.whatsapp,owner.country,owner.province,owner.city,owner.neighborhood,true,owner.tax_id,owner.vat_condition,owner.liquidation_email_enabled,owner.fiscal_address,owner.gross_income_number,owner.activity_start_date,owner.whatsapp_normalized,owner.whatsapp_opt_in,JSON.stringify(owner.whatsapp_preferences_json)]);
        await saveOwnerPropertyLinks(client,id,input.property_ids);
        await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    }else{
      await db.query(`INSERT INTO persons(id,full_name,document_type,document_number,email,phone,address,notes,person_kind,first_name,last_name,nationality,whatsapp,country,province,city,neighborhood,is_owner)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,[id,input.full_name,input.document_type||'DNI',input.document_number||null,input.email||null,input.phone||null,input.address||null,input.notes||null,input.person_kind||'PERSON',input.first_name||null,input.last_name||null,input.nationality||null,input.whatsapp||null,input.country||'Argentina',input.province||'CABA',input.city||null,input.neighborhood||null,false]);
    }
  }else if(resource==='incidents'){
    if(!input.title)throw new Error('El título es obligatorio.');
    await db.query('INSERT INTO incidents(id,property_id,contract_id,title,description,priority,status,opened_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',[id,input.property_id||null,input.contract_id||null,input.title,input.description||null,input.priority||'Media',input.status||'Abierta',input.opened_at||new Date().toISOString().slice(0,10)]);
  }else if(['ledger','expenses','services','other-income'].includes(resource)){
    if(!input.description||!input.amount)throw new Error('Descripción e importe son obligatorios.');
    const kind=resource==='other-income'?'Ingreso':'Gasto',category=resource==='services'?'Servicio':(resource==='expenses'?'General':(input.category||'General'));
    await db.query('INSERT INTO ledger_entries(id,entry_date,kind,category,description,amount,currency,property_id,contract_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,input.entry_date||new Date().toISOString().slice(0,10),input.kind||kind,input.category||category,input.description,Number(input.amount),input.currency||'ARS',input.property_id||null,input.contract_id||null]);
  }else if(resource==='contracts'){
    const fee=validateFee(input.management_fee_pct),client=await db.connect();
    try{await client.query('BEGIN');
      await client.query(`INSERT INTO contracts(id,code,property_id,tenant_id,rental_type,duration_months,start_date,end_date,initial_amount,currency,adjustment_frequency_months,adjustment_index,payment_due_day,management_fee_pct,bank_name,cbu,status,ipc_lag_months,ipc_clause_text,ipc_clause_review_required,adjustment_type,adjustment_value_pct,payment_period_start_day,payment_period_end_day,notes) VALUES (${Array.from({length:25},(_,i)=>'$'+(i+1)).join(',')})`,[id,input.code,input.property_id,input.tenant_id,input.rental_type,Number(input.duration_months),input.start_date,input.end_date||endDate(input.start_date,Number(input.duration_months)),Number(input.initial_amount),input.currency||'ARS',Number(input.adjustment_frequency_months)||null,input.adjustment_index||null,Number(input.payment_due_day)||10,fee,input.bank_name||null,input.cbu||null,input.status||'Activo',Number(input.ipc_lag_months||0),input.ipc_clause_text||null,false,input.adjustment_type??null,input.adjustment_value_pct===''?null:input.adjustment_value_pct??null,input.payment_period_start_day||null,input.payment_period_end_day||null,input.notes??null]);
      if(input.owner_id){await client.query('INSERT INTO contract_owners(contract_id,person_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',[id,input.owner_id]);await client.query('INSERT INTO property_owners(property_id,person_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',[input.property_id,input.owner_id]);await client.query('UPDATE persons SET is_owner=true,updated_at=now() WHERE id=$1',[input.owner_id]);}
      await client.query('INSERT INTO guarantees(id,contract_id,guarantee_type,provider,provider_detail) VALUES ($1,$2,$3,$4,$5)',[uid(),id,input.guarantee_type||'Sin garantía',input.guarantee_provider||null,input.guarantee_provider_detail||null]);
      await generateInstallments(client,await one(client,'SELECT * FROM contracts WHERE id=$1',[id]));
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }else throw new Error('No se puede crear ese recurso.');
  await db.query('INSERT INTO audit_log(id,entity_type,entity_id,action,details_json) VALUES ($1,$2,$3,$4,$5)',[uid(),resource,id,'created',input]);
  return{id};
}

async function updateRecord(db,resource,id,input){
  if(resource==='contracts'){
    return inTransaction(db,async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['ferraro:ipc:write']);
      const contract=await lockContract(client,id);assertAdministrativeChange(contract,input);
      if(input.alias===undefined&&input.administrative_note===undefined)throw new Error('No hay datos administrativos para guardar.');
      if(input.alias!==undefined)await client.query('UPDATE contracts SET alias=$1,updated_at=now() WHERE id=$2',[String(input.alias||'').trim()||null,id]);
      const previous=(await client.query("SELECT details_json->>'administrative_note' note FROM audit_log WHERE entity_type='contract' AND entity_id=$1 AND action='administrative_updated' ORDER BY created_at DESC,id DESC LIMIT 1",[id])).rows[0];
      await audit(client,'contract',id,'administrative_updated',{actor:{id:'local-operator',label:'Operador local; sin sesión autenticada'},before_alias:contract.alias,alias:input.alias===undefined?contract.alias:input.alias,administrative_note:input.administrative_note===undefined?previous?.note||'':String(input.administrative_note)});
      return{id};
    });
  }
  else if(resource==='pending-collections'){
    const numericFields=['expected_amount','declared_amount','vat_amount','late_fee_amount','discount_amount','manual_partial_amount','discount_percentage'];
    const booleanFields=['rent_forgiven','vat_forgiven','late_fee_forgiven','discount_is_percentage','discount_details_enabled'];
    const normalized={...input};
    if(booleanInput(input.rent_forgiven)&&normalized.expected_amount===undefined)normalized.expected_amount=0;
    if(booleanInput(input.vat_forgiven)&&normalized.vat_amount===undefined)normalized.vat_amount=0;
    if(booleanInput(input.late_fee_forgiven)&&normalized.late_fee_amount===undefined)normalized.late_fee_amount=0;
    const assignments=[],values=[];
    for(const field of numericFields){
      if(normalized[field]!==undefined){
        const value=normalized[field]===null||normalized[field]===''?null:Number(normalized[field]);
        if(value!==null&&(!Number.isFinite(value)||value<0))throw new Error('Los importes deben ser números positivos o cero.');
        values.push(value);
        assignments.push(`${field}=$${values.length}`);
      }
    }
    for(const field of booleanFields){
      if(normalized[field]!==undefined){
        values.push(booleanInput(normalized[field]));
        assignments.push(`${field}=$${values.length}`);
      }
    }
    if(normalized.internal_notes!==undefined){
      values.push(String(normalized.internal_notes));
      assignments.push(`internal_notes=$${values.length}`);
    }
    if(!assignments.length)throw new Error('No hay cambios para guardar.');
    if(normalized.expected_amount!==undefined){values.push(normalized.expected_amount===null?null:Number(normalized.expected_amount));assignments.push(`rent_override_amount=$${values.length}`);}
    let where;
    if(booleanInput(input.repeat_remaining)){
      const current=await one(db,'SELECT contract_id,due_date FROM installments WHERE id=$1',[id]);
      if(!current)throw new Error('Cobro pendiente no encontrado.');
      values.push(current.contract_id);
      const contractIndex=values.length;
      values.push(current.due_date);
      const dueIndex=values.length;
      where=`contract_id=$${contractIndex} AND due_date>=$${dueIndex} AND status NOT IN ('Pagado','Sustituido')`;
    }else{
      values.push(id);
      where=`id=$${values.length} AND status NOT IN ('Pagado','Sustituido')`;
    }
    const client=await db.connect();
    try{
      await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['ferraro:ipc:write']);
      const link=await one(client,'SELECT contract_id FROM installments WHERE id=$1',[id]);
      if(!link)throw new Error('Cobro pendiente no encontrado.');
      await client.query('SELECT id FROM contracts WHERE id=$1 FOR UPDATE',[link.contract_id]);
      const before=await rows(client,'SELECT * FROM installments WHERE contract_id=$1 ORDER BY period FOR UPDATE',[link.contract_id]);
      if(before.some(row=>row.financial_closed_at&&(row.id===id||(booleanInput(input.repeat_remaining)&&String(row.due_date)>=String(before.find(i=>i.id===id)?.due_date)))))throw new Error('El período está cerrado. No se modificaron los importes.');
      const result=await client.query(`UPDATE installments SET ${assignments.join(', ')},original_expected_amount=COALESCE(original_expected_amount,expected_amount) WHERE ${where} RETURNING id`,values);
      if(!result.rowCount)throw new Error('Cobro pendiente no encontrado o ya pagado.');
      const changedIds=result.rows.map(row=>row.id);
      if(normalized.expected_amount!==undefined)await client.query("UPDATE installments i SET adjustment_pending=false FROM contracts c WHERE i.contract_id=c.id AND i.id=ANY($1::uuid[]) AND c.adjustment_index IS DISTINCT FROM 'IPC'",[changedIds]);
      await reconcileOnClient(client,{contractId:link.contract_id,managedOnly:true,apply:true,reason:'manual_collection_edit',previousRows:new Map(before.filter(row=>changedIds.includes(row.id)).map(row=>[row.id,row]))});
      const affected=await rows(client,`SELECT i.*,(COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.installment_id=i.id),0)+i.manual_partial_amount)::text paid_total FROM installments i WHERE i.id=ANY($1::uuid[])`,[changedIds]);
      for(const row of affected)await client.query('UPDATE installments SET status=$1 WHERE id=$2',[paymentStatus(row,row.paid_total),row.id]);
      await client.query('INSERT INTO audit_log(id,entity_type,entity_id,action,details_json) VALUES($1,$2,$3,$4,$5)',[uid(),resource,id,'updated',{before:before.filter(row=>changedIds.includes(row.id)),changes:input}]);
      await client.query('COMMIT');return {id,updated:true};
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  else if(resource==='owners'){
    const owner=normalizeOwnerInput(input),client=await db.connect();
    try{await client.query('BEGIN');
      const result=await client.query(`UPDATE persons SET
        full_name=$1,
        document_type=$2,
        document_number=$3,
        email=$4,
        phone=$5,
        address=$6,
        person_kind=$7,
        first_name=$8,
        last_name=$9,
        whatsapp=$10,
        country=$11,
        province=$12,
        city=$13,
        neighborhood=$14,
        is_owner=true,
        tax_id=$15,
        vat_condition=$16,
        liquidation_email_enabled=$17,
        fiscal_address=$18,
        gross_income_number=$19,
        activity_start_date=$20,
        whatsapp_normalized=$21,
        whatsapp_opt_in=$22,
        whatsapp_preferences_json=$23,
        updated_at=now()
        WHERE id=$24`,[owner.full_name,owner.document_type,owner.document_number,owner.email,owner.phone,owner.address,owner.person_kind,owner.first_name,owner.last_name,owner.whatsapp,owner.country,owner.province,owner.city,owner.neighborhood,owner.tax_id,owner.vat_condition,owner.liquidation_email_enabled,owner.fiscal_address,owner.gross_income_number,owner.activity_start_date,owner.whatsapp_normalized,owner.whatsapp_opt_in,JSON.stringify(owner.whatsapp_preferences_json),id]);
      if(!result.rowCount)throw new Error('Propietario no encontrado.');
      await saveOwnerPropertyLinks(client,id,input.property_ids);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  else if(resource==='tenants'){
    const tenant=normalizeTenantInput(input);
    const result=await db.query(`UPDATE persons SET
      full_name=$1,
      first_name=$2,
      last_name=$3,
      document_type=$4,
      document_number=$5,
      tax_id=$6,
      nationality=$7,
      address=$8,
      city=$9,
      province=$10,
      country=$11,
      phone=$12,
      whatsapp=$13,
      email=$14,
      person_kind=$15,
      vat_condition=$16,
      updated_at=now()
      WHERE id=$17 RETURNING id`,[tenant.full_name,tenant.first_name,tenant.last_name,tenant.document_type,tenant.document_number,tenant.tax_id,tenant.nationality,tenant.address,tenant.city,tenant.province,tenant.country,tenant.phone,tenant.whatsapp,tenant.email,tenant.person_kind,tenant.vat_condition,id]);
    if(!result.rowCount)throw new Error('Inquilino no encontrado.');
  }
  else if(resource==='incidents')await db.query(`UPDATE incidents SET title=COALESCE($1,title),description=COALESCE($2,description),priority=COALESCE($3,priority),status=COALESCE($4,status),resolved_at=CASE WHEN $4 IN ('Resuelta','Cerrada') THEN current_date ELSE resolved_at END WHERE id=$5`,[input.title||null,input.description||null,input.priority||null,input.status||null,id]);
  else throw new Error('Actualización no disponible para ese recurso.');
  await db.query('INSERT INTO audit_log(id,entity_type,entity_id,action,details_json) VALUES ($1,$2,$3,$4,$5)',[uid(),resource,id,'updated',input]);return{id,updated:true};
}

const audit=(client,entityType,entityId,action,details={})=>client.query('INSERT INTO audit_log(id,entity_type,entity_id,action,details_json) VALUES ($1,$2,$3,$4,$5)',[uid(),entityType,entityId,action,details]);
async function inTransaction(db,work){const client=await db.connect();try{await client.query('BEGIN');const result=await work(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
const plural=(count,singular,pluralForm=`${singular}s`)=>`${count} ${count===1?singular:pluralForm}`;
const listItems=items=>items.filter(item=>item.count>0);
const IN_FORCE_CONTRACT_STATUSES=['Activo','Revisión','Desactivado'];

// Vista previa de lo que pasa al eliminar una propiedad. Lo compartido (propietarios) siempre se conserva.
async function propertyImpact(client,propertyId,{lock=false}={}){
  const property=await one(client,`SELECT * FROM properties WHERE id=$1${lock?' FOR UPDATE':''}`,[propertyId]);
  if(!property)throw new Error('Propiedad no encontrada.');
  const contracts=await rows(client,'SELECT id,code,alias,status FROM contracts WHERE property_id=$1 ORDER BY start_date DESC',[propertyId]);
  const counts=await one(client,`SELECT (SELECT COUNT(*)::int FROM incidents WHERE property_id=$1) incidents,(SELECT COUNT(*)::int FROM ledger_entries WHERE property_id=$1) ledger,(SELECT COUNT(*)::int FROM documents WHERE property_id=$1 AND contract_id IS NULL) loose_documents`,[propertyId]);
  const owners=await rows(client,`SELECT pe.id,pe.full_name,(SELECT COUNT(*)::int FROM property_owners x WHERE x.person_id=pe.id AND x.property_id<>$1) other_properties FROM property_owners po JOIN persons pe ON pe.id=po.person_id WHERE po.property_id=$1 ORDER BY pe.full_name`,[propertyId]);
  const blockers=[];
  if(contracts.length)blockers.push(`Tiene ${plural(contracts.length,'contrato')} (${contracts.map(c=>`${c.alias||c.code}: ${c.status}`).join(', ')}). El historial contractual se conserva: archivá la propiedad para ocultarla.`);
  if(counts.incidents)blockers.push(`Tiene ${plural(counts.incidents,'incidencia registrada','incidencias registradas')}.`);
  if(counts.ledger)blockers.push(`Tiene ${plural(counts.ledger,'movimiento contable','movimientos contables')} (gastos, servicios o ingresos) que deben conservarse.`);
  const inForce=contracts.find(c=>IN_FORCE_CONTRACT_STATUSES.includes(c.status));
  return{entity:{type:'property',id:property.id,label:property.address,detail:property.code,archived_at:property.archived_at},
    can_delete:!blockers.length,blockers,
    remove:listItems([{label:'Vínculos con propietarios (las personas se conservan)',count:owners.length}]),
    unlink:listItems([{label:'Documentos PDF sin contrato (el archivo y su registro se conservan)',count:counts.loose_documents}]),
    keep:owners.map(owner=>({type:'person',role:'Propietario',id:owner.id,label:owner.full_name,detail:owner.other_properties?`Conserva ${plural(owner.other_properties,'propiedad más','propiedades más')}.`:'Queda sin propiedades: podés archivarlo o eliminarlo desde Propietarios.',manage:'owners'})),
    irreversible:['La ficha de la propiedad se borra definitivamente.'],
    archive_blocker:inForce?`Tiene un contrato vigente (${inForce.alias||inForce.code}: ${inForce.status}). Finalizalo, rescindilo o archivalo antes de archivar la propiedad.`:null};
}

// Vista previa para propietarios, inquilinos y personas: nunca se borra alguien que figure en un contrato.
async function personImpact(client,personId,{lock=false}={}){
  const person=await one(client,`SELECT * FROM persons WHERE id=$1${lock?' FOR UPDATE':''}`,[personId]);
  if(!person)throw new Error('Persona no encontrada.');
  const contracts=await rows(client,`SELECT DISTINCT c.id,c.code,c.alias,c.status,c.start_date FROM contracts c LEFT JOIN contract_tenants ct ON ct.contract_id=c.id LEFT JOIN contract_owners co ON co.contract_id=c.id WHERE c.tenant_id=$1 OR ct.person_id=$1 OR co.person_id=$1 ORDER BY c.start_date DESC`,[personId]);
  const properties=await rows(client,`SELECT p.id,p.address,(SELECT COUNT(*)::int FROM property_owners x WHERE x.property_id=p.id AND x.person_id<>$1) other_owners FROM property_owners po JOIN properties p ON p.id=po.property_id WHERE po.person_id=$1 ORDER BY p.address`,[personId]);
  const counts=await one(client,`SELECT (SELECT COUNT(*)::int FROM whatsapp_conversations WHERE owner_id=$1) conversations,(SELECT COUNT(*)::int FROM owner_portal_tokens WHERE owner_id=$1) portal_tokens`,[personId]);
  const blockers=contracts.length?[`Está vinculado a contratos (${contracts.map(c=>`${c.alias||c.code}: ${c.status}`).join(', ')}). El historial contractual se conserva: archivalo para ocultarlo.`]:[];
  const inForce=contracts.find(c=>IN_FORCE_CONTRACT_STATUSES.includes(c.status));
  return{entity:{type:'person',id:person.id,label:person.full_name,detail:[person.document_type,person.document_number].filter(Boolean).join(' '),archived_at:person.archived_at},
    can_delete:!blockers.length,blockers,
    remove:listItems([{label:'Vínculos con propiedades (las propiedades se conservan)',count:properties.length},{label:'Accesos al portal de propietarios',count:counts.portal_tokens}]),
    unlink:listItems([{label:'Conversaciones de WhatsApp (el historial se conserva sin el vínculo)',count:counts.conversations}]),
    keep:properties.map(property=>({type:'property',role:'Propiedad',id:property.id,label:property.address,detail:property.other_owners?`Conserva ${plural(property.other_owners,'propietario más','propietarios más')}.`:'Queda sin propietario asignado.',manage:'properties'})),
    irreversible:['La ficha de la persona se borra definitivamente.'],
    archive_blocker:inForce?`Figura en un contrato vigente (${inForce.alias||inForce.code}: ${inForce.status}). Finalizalo o archivalo antes de archivar a esta persona.`:null};
}

const ENTITY_RESOURCES={properties:{table:'properties',impact:propertyImpact,audit:'property'},owners:{table:'persons',impact:personImpact,audit:'person'},tenants:{table:'persons',impact:personImpact,audit:'person'},people:{table:'persons',impact:personImpact,audit:'person'}};
async function entityImpact(db,resource,id){
  const spec=ENTITY_RESOURCES[resource];
  if(!spec)throw new Error('Vista previa no disponible para ese recurso.');
  if(!UUID_PATTERN.test(String(id)))throw new Error('Registro no encontrado.');
  return spec.impact(db,id);
}
async function setEntityArchived(db,resource,id,archived,input={}){
  const spec=ENTITY_RESOURCES[resource];
  if(!spec)throw new Error('Archivado no disponible para ese recurso.');
  if(!UUID_PATTERN.test(String(id)))throw new Error('Registro no encontrado.');
  return inTransaction(db,async client=>{
    const impact=await spec.impact(client,id,{lock:true});
    if(Boolean(impact.entity.archived_at)===archived)return{id,archived,unchanged:true};
    if(archived&&impact.archive_blocker)throw new Error(impact.archive_blocker);
    await client.query(`UPDATE ${spec.table} SET archived_at=${archived?'now()':'NULL'},updated_at=now() WHERE id=$1`,[id]);
    await audit(client,spec.audit,id,archived?'archived':'restored',{reason:cleanNullable(input.reason),label:impact.entity.label});
    return{id,archived};
  });
}

async function deleteRecord(db,resource,id,input={}){
  if(resource==='guarantors'){
    const result=await db.query('DELETE FROM guarantees WHERE id=$1 RETURNING *',[id]);
    if(!result.rowCount)throw new Error('Garante no encontrado.');
    await audit(db,resource,id,'deleted',{snapshot:result.rows[0]});
    return{id,deleted:true};
  }
  const spec=ENTITY_RESOURCES[resource];
  if(!spec)throw new Error('Eliminación no disponible para ese recurso.');
  if(!UUID_PATTERN.test(String(id)))throw new Error('Registro no encontrado.');
  return inTransaction(db,async client=>{
    const exists=await one(client,`SELECT id FROM ${spec.table} WHERE id=$1`,[id]);
    if(!exists){if(await one(client,`SELECT 1 FROM audit_log WHERE entity_id=$1 AND action='deleted'`,[id]))return{id,deleted:true,alreadyDeleted:true};throw new Error('Registro no encontrado.');}
    const impact=await spec.impact(client,id,{lock:true});
    if(!impact.can_delete){const error=new Error(impact.blockers.join(' '));error.details=impact;throw error;}
    if(!booleanInput(input.confirm))throw new Error('Confirmá la eliminación después de revisar la vista previa.');
    const snapshot=await one(client,`SELECT * FROM ${spec.table} WHERE id=$1`,[id]),summary={};
    if(spec.table==='properties'){
      summary.owner_links=(await client.query('DELETE FROM property_owners WHERE property_id=$1',[id])).rowCount;
      summary.unlinked_documents=(await client.query('UPDATE documents SET property_id=NULL WHERE property_id=$1 AND contract_id IS NULL',[id])).rowCount;
    }else{
      summary.property_links=(await client.query('DELETE FROM property_owners WHERE person_id=$1',[id])).rowCount;
      await client.query('DELETE FROM contract_tenants WHERE person_id=$1',[id]);
    }
    await client.query(`DELETE FROM ${spec.table} WHERE id=$1`,[id]);
    await audit(client,spec.audit,id,'deleted',{...summary,snapshot,reason:cleanNullable(input.reason)});
    return{id,deleted:true,summary,kept:impact.keep};
  });
}

function mergeJson(base={},patch={}){return JSON.stringify({...base,...patch});}
function completionResult(row={}){return row.result_json?.completion_result||row.result_json?.completionResult||{};}
function createdIds(result={},key){return Array.isArray(result.created?.[key])?result.created[key].filter(Boolean):[];}

async function discardImport(db,importId,input={}){
  const row=await one(db,'SELECT id,status,result_json FROM imports WHERE id=$1',[importId]);
  if(!row)throw new Error('La importación no existe.');
  if(row.status==='Procesado')throw new Error('La importación ya creó un contrato. Usá Revertir importación.');
  if(row.status==='Revertido')throw new Error('La importación ya fue revertida.');
  await db.query(`UPDATE imports SET status='Descartado',error_message=NULL,result_json=$1 WHERE id=$2`,[
    mergeJson(row.result_json||{},{discarded_at:new Date().toISOString(),discard_reason:input.reason||'Descartada manualmente'}),
    importId
  ]);
  await db.query('INSERT INTO audit_log(id,entity_type,entity_id,action,details_json) VALUES ($1,$2,$3,$4,$5)',[uid(),'import',importId,'discarded',{reason:input.reason||null}]);
  return{id:importId,status:'Descartado'};
}

async function canDeleteProperty(client,propertyId){
  const refs=await one(client,`SELECT
    (SELECT COUNT(*)::int FROM contracts WHERE property_id=$1) contracts,
    (SELECT COUNT(*)::int FROM documents WHERE property_id=$1) documents,
    (SELECT COUNT(*)::int FROM incidents WHERE property_id=$1) incidents,
    (SELECT COUNT(*)::int FROM ledger_entries WHERE property_id=$1) ledger`,[propertyId]);
  return !refs.contracts&&!refs.documents&&!refs.incidents&&!refs.ledger;
}

async function canDeletePerson(client,personId){
  const refs=await one(client,`SELECT
    (SELECT COUNT(*)::int FROM contracts WHERE tenant_id=$1) tenant_contracts,
    (SELECT COUNT(*)::int FROM contract_tenants WHERE person_id=$1) contract_tenants,
    (SELECT COUNT(*)::int FROM contract_owners WHERE person_id=$1) contract_owners,
    (SELECT COUNT(*)::int FROM property_owners WHERE person_id=$1) property_owners`,[personId]);
  return !refs.tenant_contracts&&!refs.contract_tenants&&!refs.contract_owners&&!refs.property_owners;
}

async function revertImport(db,importId,input={}){
  const row=await one(db,'SELECT * FROM imports WHERE id=$1',[importId]);
  if(!row)throw new Error('La importación no existe.');
  if(['Revisión','Error','Omitido','Descartado'].includes(row.status))return discardImport(db,importId,input);
  if(row.status==='Revertido')throw new Error('La importación ya fue revertida.');
  if(row.status!=='Procesado')throw new Error('Solo se pueden revertir importaciones procesadas.');
  const result=completionResult(row),contractId=result.contractId,documentId=result.documentId;
  if(!contractId)throw new Error('Esta importación no tiene contrato asociado para revertir.');
  const paymentCount=Number((await one(db,`SELECT COUNT(*) total FROM payments pay JOIN installments i ON i.id=pay.installment_id WHERE i.contract_id=$1`,[contractId])).total||0);
  if(paymentCount>0)throw new Error('No se puede revertir porque el contrato ya tiene cobros registrados. Anulá el contrato para conservar el historial contable.');

  const client=await db.connect(),summary={contractId,documentId,deleted:{contracts:0,documents:0,properties:0,persons:0},kept:{properties:[],persons:[]},mode:result.created?'tracked':'legacy-safe'};
  try{
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['ferraro:ipc:write']);
    const contract=await one(client,'SELECT * FROM contracts WHERE id=$1 FOR UPDATE',[contractId]);
    if(contract){
      const impact=await contractImpact(client,contractId);
      if(!impact.can_delete)throw new Error(impact.blockers.join(' '));
      const removed=await removeContractOnClient(client,contract,{reason:input.reason||'Importación revertida',deleteDocuments:true});
      summary.deleted.contracts=removed.contracts;summary.deleted.documents=removed.documents;
    }
    await client.query('DELETE FROM documents WHERE id=$1 AND contract_id IS NULL',[documentId]).then(res=>{summary.deleted.documents+=res.rowCount;});

    for(const propertyId of createdIds(result,'propertyIds')){
      if(await canDeleteProperty(client,propertyId)){
        await client.query('DELETE FROM property_owners WHERE property_id=$1',[propertyId]);
        await client.query('DELETE FROM properties WHERE id=$1',[propertyId]).then(res=>{summary.deleted.properties+=res.rowCount;});
      }else summary.kept.properties.push(propertyId);
    }
    for(const personId of createdIds(result,'personIds')){
      if(await canDeletePerson(client,personId)){
        await client.query('DELETE FROM property_owners WHERE person_id=$1',[personId]);
        await client.query('DELETE FROM persons WHERE id=$1',[personId]).then(res=>{summary.deleted.persons+=res.rowCount;});
      }else summary.kept.persons.push(personId);
    }
    await client.query(`UPDATE imports SET status='Revertido',error_message=NULL,result_json=$1 WHERE id=$2`,[
      mergeJson(row.result_json||{},{reverted_at:new Date().toISOString(),revert_reason:input.reason||'Revertida manualmente',revert_summary:summary}),
      importId
    ]);
    await client.query('INSERT INTO audit_log(id,entity_type,entity_id,action,details_json) VALUES ($1,$2,$3,$4,$5)',[uid(),'import',importId,'reverted',summary]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  return{id:importId,status:'Revertido',summary};
}

// Ciclo de vida del contrato. Cada acción declara desde qué estados se permite. Desactivar y archivar guardan
// el estado previo para que "Volver a activar" y "Restaurar" lo devuelvan sin tocar cuotas, pagos ni cálculos IPC.
const CONTRACT_ACTIONS={
  deactivate:{label:'Desactivar temporalmente',from:['Activo','Revisión','Renovado'],to:'Desactivado',audit:'deactivated'},
  reactivate:{label:'Volver a activar',from:['Desactivado'],audit:'reactivated'},
  finalize:{label:'Finalizar',from:['Activo','Revisión','Vencido','Desactivado'],to:'Finalizado',audit:'finalized'},
  rescind:{label:'Rescindir',from:['Activo','Revisión','Vencido','Desactivado'],to:'Rescindido',audit:'rescinded'},
  void:{label:'Anular',from:['Borrador','Activo','Revisión','Vencido','Desactivado','Finalizado'],to:'Anulado',audit:'voided'},
  archive:{label:'Archivar',from:['Finalizado','Vencido','Rescindido','Anulado','Renovado','Desactivado'],to:'Archivado',audit:'archived'},
  restore:{label:'Restaurar',from:['Archivado'],audit:'restored'}
};
const CONTRACT_STATUS_HINTS={
  Archivado:'Está archivado: primero restauralo.',
  Anulado:'Los contratos anulados no se reactivan; si corresponde, cargá un contrato nuevo.',
  Rescindido:'Los contratos rescindidos no se reactivan; si corresponde, cargá un contrato nuevo.',
  Renovado:'Fue reemplazado por su renovación: gestioná el contrato vigente.',
  Finalizado:'Ya terminó su vigencia.',
  Desactivado:'Está desactivado: primero volvé a activarlo.'
};
// Las cuotas que todavía se pueden cobrar (mismo criterio que cobros pendientes).
const OPEN_INSTALLMENT_SQL=`status<>'Sustituido' AND (status<>'Pagado' OR adjustment_pending)`;
function contractActionError(contract,action){
  const rule=CONTRACT_ACTIONS[action];
  if(action==='finalize'&&rule.from.includes(contract.status)&&contract.end_date&&dateKey(contract.end_date)>dateKey(new Date()))return`El contrato sigue vigente hasta el ${dateKey(contract.end_date)}. Si termina antes, usá Rescindir.`;
  if(rule.from.includes(contract.status))return null;
  if(action==='archive'&&['Activo','Revisión','Borrador'].includes(contract.status))return'Un contrato vigente no se archiva: primero finalizalo, rescindilo o desactivalo.';
  return`No se puede ${rule.label.toLowerCase()} un contrato en estado ${contract.status}. ${CONTRACT_STATUS_HINTS[contract.status]||''}`.trim();
}
async function lockContract(client,contractId){
  if(!UUID_PATTERN.test(String(contractId)))throw new Error('Contrato no encontrado.');
  const contract=await one(client,'SELECT * FROM contracts WHERE id=$1 FOR UPDATE',[contractId]);
  if(!contract)throw new Error('Contrato no encontrado.');
  return contract;
}
// Las solicitudes repetidas son idempotentes: si el contrato ya está en el estado destino no se vuelve a escribir.
async function transitionContract(db,contractId,action,input,apply){
  return inTransaction(db,async client=>{
    const contract=await lockContract(client,contractId),rule=CONTRACT_ACTIONS[action];
    if(rule.to&&contract.status===rule.to)return{id:contractId,status:contract.status,unchanged:true,warnings:[]};
    const blocked=contractActionError(contract,action);
    if(blocked)throw new Error(blocked);
    const result=await apply(client,contract);
    await audit(client,'contract',contractId,rule.audit,{from:contract.status,to:result.status,reason:cleanNullable(input.reason),...(result.details||{})});
    return{id:contractId,status:result.status,previous_status:contract.status,warnings:result.warnings||[]};
  });
}
async function contractOpenInstallments(client,contractId){return Number((await one(client,`SELECT COUNT(*)::int total FROM installments WHERE contract_id=$1 AND ${OPEN_INSTALLMENT_SQL}`,[contractId])).total);}

async function voidContract(db,contractId,input={}){
  const reason=cleanNullable(input.reason)||'Anulado manualmente';
  return transitionContract(db,contractId,'void',input,async(client,contract)=>{
    await client.query(`UPDATE contracts SET status='Anulado',voided_at=now(),void_reason=$1,updated_at=now() WHERE id=$2`,[reason,contract.id]);
    await client.query("UPDATE installments SET status='Vencido' WHERE contract_id=$1 AND status NOT IN ('Pagado','Sustituido','Parcial')",[contract.id]);
    return{status:'Anulado',details:{reason}};
  });
}

async function deactivateContract(db,contractId,input={}){
  const reason=cleanNullable(input.reason)||'';
  return transitionContract(db,contractId,'deactivate',input,async(client,contract)=>{
    // Las cuotas no se modifican: dejan de listarse como cobrables por el estado del contrato.
    await client.query(`UPDATE contracts SET status='Desactivado',deactivated_from_status=$1,deactivated_at=now(),updated_at=now(),notes=COALESCE(notes,'') || CASE WHEN $2::text<>'' THEN E'\nDesactivado: ' || $2::text ELSE '' END WHERE id=$3`,[contract.status,reason,contract.id]);
    return{status:'Desactivado'};
  });
}

// Sin una captura previa por cuota no hay evidencia para distinguir un vencimiento real
// de una marca antigua de desactivación. Se conserva todo y se informa la revisión.
async function restoreLegacyOverdueInstallments(client,contract){
  if(contract.deactivated_from_status)return [];
  return (await rows(client,"SELECT period FROM installments WHERE contract_id=$1 AND status='Vencido' ORDER BY period",[contract.id])).map(row=>row.period);
}

async function reactivateContract(db,contractId,input={}){
  return transitionContract(db,contractId,'reactivate',input,async(client,contract)=>{
    const target=['Activo','Revisión','Renovado'].includes(contract.deactivated_from_status)?contract.deactivated_from_status:'Activo';
    if(target!=='Renovado'){
      const overlapping=await one(client,`SELECT code,alias FROM contracts WHERE property_id=$1 AND id<>$2 AND status IN ('Activo','Revisión') AND start_date<=$4::date AND end_date>=$3::date LIMIT 1`,[contract.property_id,contract.id,dateKey(contract.start_date),dateKey(contract.end_date)]);
      if(overlapping)throw new Error(`La propiedad ya tiene otro contrato vigente en esas fechas (${overlapping.alias||overlapping.code}). Resolvelo antes de volver a activar este contrato.`);
    }
    await client.query('UPDATE contracts SET status=$1,deactivated_from_status=NULL,deactivated_at=NULL,updated_at=now() WHERE id=$2',[target,contract.id]);
    const review=await restoreLegacyOverdueInstallments(client,contract);
    const warnings=dateKey(contract.end_date)<dateKey(new Date())?[`La vigencia terminó el ${dateKey(contract.end_date)}. Si ya no corresponde cobrarlo, finalizalo.`]:[];
    if(review.length)warnings.push(`${review.length} cuotas conservan su estado Vencido: no hay evidencia de su estado anterior a la desactivación. Requieren revisión.`);
    return{status:target,warnings,details:{installment_status_review:review}};
  });
}

async function finalizeContract(db,contractId,input={}){
  return transitionContract(db,contractId,'finalize',input,async(client,contract)=>{
    const open=await contractOpenInstallments(client,contract.id);
    if(open)throw new Error(`Tiene ${plural(open,'cuota sin cobrar','cuotas sin cobrar')}. Registrá o ajustá esos cobros antes de finalizarlo para no perder el seguimiento de la deuda.`);
    await client.query(`UPDATE contracts SET status='Finalizado',finalized_at=now(),deactivated_from_status=NULL,updated_at=now() WHERE id=$1`,[contract.id]);
    return{status:'Finalizado'};
  });
}

async function archiveContract(db,contractId,input={}){
  return transitionContract(db,contractId,'archive',input,async(client,contract)=>{
    if(['Renovado','Desactivado','Vencido'].includes(contract.status)){
      const open=await contractOpenInstallments(client,contract.id);
      if(open)throw new Error(`Tiene ${plural(open,'cuota sin cobrar','cuotas sin cobrar')}: no se archiva para no perder el seguimiento de la deuda.`);
    }
    await client.query(`UPDATE contracts SET status='Archivado',archived_from_status=$1,archived_at=now(),updated_at=now() WHERE id=$2`,[contract.status,contract.id]);
    return{status:'Archivado'};
  });
}

async function restoreContract(db,contractId,input={}){
  return transitionContract(db,contractId,'restore',input,async(client,contract)=>{
    let target=contract.archived_from_status,deactivatedFrom=contract.deactivated_from_status;
    // Archivados antes de la migración 014: se deduce el estado sin reactivarlos automáticamente.
    if(!target){
      if(contract.voided_at)target='Anulado';
      else if(contract.rescinded_at)target='Rescindido';
      else if(await one(client,'SELECT 1 FROM contracts WHERE previous_contract_id=$1',[contract.id]))target='Renovado';
      else{target='Desactivado';}
    }
    await client.query('UPDATE contracts SET status=$1,deactivated_from_status=$2,archived_from_status=NULL,archived_at=NULL,updated_at=now() WHERE id=$3',[target,deactivatedFrom,contract.id]);
    return{status:target,warnings:target==='Desactivado'?['Quedó desactivado: revisalo y usá "Volver a activar" si corresponde.']:[]};
  });
}

async function contractLifecycle(db,contractId){
  if(!UUID_PATTERN.test(String(contractId)))throw new Error('Contrato no encontrado.');
  const contract=await one(db,'SELECT id,code,alias,status,end_date,deactivated_from_status,archived_from_status FROM contracts WHERE id=$1',[contractId]);
  if(!contract)throw new Error('Contrato no encontrado.');
  const actions=Object.fromEntries(Object.entries(CONTRACT_ACTIONS).map(([key,rule])=>{const reason=contractActionError(contract,key);return[key,{label:rule.label,allowed:!reason,reason}];}));
  const history=await rows(db,`SELECT action,details_json,created_at FROM audit_log WHERE entity_type='contract' AND entity_id=$1 ORDER BY created_at DESC LIMIT 30`,[contractId]);
  return{...contract,actions,history};
}

// Una renovación vincula un contrato nuevo, importado desde su propio PDF, con el contrato anterior.
// Nunca copia datos del contrato viejo: el contrato nuevo conserva lo que surgió de su importación.
const RENEWABLE_FROM_STATUSES=['Activo','Revisión','Vencido','Finalizado'];
const RENEWAL_CANDIDATE_STATUSES=['Activo','Revisión'];
const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const contractDocumentIds=async(client,contract)=>[...new Set([contract.source_document_id,...(await rows(client,'SELECT id FROM documents WHERE contract_id=$1',[contract.id])).map(row=>row.id)].filter(Boolean))];
const contractAncestorIds=async(client,contractId)=>(await rows(client,`WITH RECURSIVE chain AS (
    SELECT id,previous_contract_id,1 depth FROM contracts WHERE id=$1
    UNION ALL SELECT c.id,c.previous_contract_id,chain.depth+1 FROM contracts c JOIN chain ON c.id=chain.previous_contract_id WHERE chain.depth<100
  ) SELECT id FROM chain WHERE id<>$1`,[contractId])).map(row=>row.id);

function renewableFromError(contract){
  if(!RENEWABLE_FROM_STATUSES.includes(contract.status))return`No se puede renovar un contrato en estado ${contract.status}.`;
  return null;
}

async function renewalCandidates(db,contractId){
  const current=await one(db,`SELECT c.id,c.code,c.alias,c.status,c.property_id,c.tenant_id,c.start_date::text start_date,c.end_date::text end_date,c.initial_amount::float,c.currency,p.address property,pe.full_name tenant FROM contracts c JOIN properties p ON p.id=c.property_id JOIN persons pe ON pe.id=c.tenant_id WHERE c.id=$1`,[contractId]);
  if(!current)throw new Error('Contrato no encontrado.');
  const successor=await one(db,'SELECT id,code FROM contracts WHERE previous_contract_id=$1 LIMIT 1',[contractId]);
  const blocked=renewableFromError(current)||(successor?`Este contrato ya fue renovado por ${successor.code}.`:null);
  if(blocked)return{contract:current,renewable:false,reason:blocked,candidates:[]};
  const ancestors=await contractAncestorIds(db,contractId);
  const candidates=await rows(db,`SELECT c.id,c.code,c.alias,c.status,c.property_id,c.tenant_id,c.start_date::text start_date,c.end_date::text end_date,c.duration_months,c.initial_amount::float,c.currency,c.adjustment_type,c.adjustment_index,c.adjustment_frequency_months,p.address property,pe.full_name tenant,
      COALESCE(sd.id,od.id) document_id,COALESCE(sd.filename,od.filename) document_filename,
      (c.tenant_id<>cur.tenant_id) tenant_changed,(c.start_date<=cur.end_date) overlaps_previous
    FROM contracts cur JOIN contracts c ON c.property_id=cur.property_id AND c.id<>cur.id AND c.start_date>cur.start_date
    JOIN properties p ON p.id=c.property_id JOIN persons pe ON pe.id=c.tenant_id
    LEFT JOIN documents sd ON sd.id=c.source_document_id
    LEFT JOIN LATERAL (SELECT d.id,d.filename FROM documents d WHERE d.contract_id=c.id ORDER BY d.imported_at DESC LIMIT 1) od ON true
    WHERE cur.id=$1 AND c.status=ANY($2::text[]) AND c.previous_contract_id IS NULL
      AND COALESCE(sd.id,od.id) IS NOT NULL AND NOT (c.id=ANY($3::uuid[]))
      AND COALESCE(sd.id,od.id) IS DISTINCT FROM cur.source_document_id
    ORDER BY c.start_date DESC`,[contractId,RENEWAL_CANDIDATE_STATUSES,ancestors]);
  return{contract:current,renewable:true,reason:null,candidates};
}

async function linkContractRenewal(db,contractId,input={}){
  const newContractId=cleanNullable(input.new_contract_id);
  if(!newContractId)throw new Error('Para renovar tenés que seleccionar el nuevo contrato importado desde su PDF.');
  if(newContractId===contractId)throw new Error('Un contrato no puede renovarse consigo mismo.');
  if(!UUID_PATTERN.test(newContractId))throw new Error('El nuevo contrato no existe.');
  const client=await db.connect();
  try{await client.query('BEGIN');
    const locked=await rows(client,'SELECT * FROM contracts WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[[contractId,newContractId]]);
    const previous=locked.find(row=>row.id===contractId),next=locked.find(row=>row.id===newContractId);
    if(!previous)throw new Error('Contrato anterior no encontrado.');
    if(!next)throw new Error('El nuevo contrato no existe.');
    const blocked=renewableFromError(previous);
    if(blocked)throw new Error(blocked);
    const successor=await one(client,'SELECT code FROM contracts WHERE previous_contract_id=$1 LIMIT 1',[contractId]);
    if(successor)throw new Error(`Este contrato ya fue renovado por ${successor.code}.`);
    if(next.property_id!==previous.property_id)throw new Error('El nuevo contrato debe corresponder a la misma propiedad que el contrato anterior.');
    if(!RENEWAL_CANDIDATE_STATUSES.includes(next.status))throw new Error(`El nuevo contrato no puede usarse como renovación porque está en estado ${next.status}.`);
    if(next.previous_contract_id)throw new Error(next.previous_contract_id===contractId?'Estos contratos ya están vinculados.':'El nuevo contrato ya está vinculado como renovación de otro contrato.');
    if((await contractAncestorIds(client,contractId)).includes(newContractId))throw new Error('El contrato seleccionado es un antecesor del contrato actual; vincularlo generaría un ciclo en el historial.');
    const dates=await one(client,`SELECT (n.start_date>p.start_date) starts_after,to_char(n.start_date,'YYYY-MM') start_period FROM contracts n JOIN contracts p ON p.id=$2 WHERE n.id=$1`,[newContractId,contractId]);
    if(!dates.starts_after)throw new Error('El nuevo contrato debe comenzar después del inicio del contrato anterior.');
    const nextDocuments=await contractDocumentIds(client,next),previousDocuments=await contractDocumentIds(client,previous);
    if(!nextDocuments.length)throw new Error('El nuevo contrato no tiene un PDF asociado. Importá el contrato firmado antes de renovar.');
    if(nextDocuments.some(id=>previousDocuments.includes(id)))throw new Error('El nuevo contrato debe tener su propio PDF, distinto del contrato anterior.');
    const otherActive=await one(client,`SELECT code FROM contracts WHERE property_id=$1 AND status=ANY($2::text[]) AND id<>ALL($3::uuid[]) LIMIT 1`,[previous.property_id,RENEWAL_CANDIDATE_STATUSES,[contractId,newContractId]]);
    if(otherActive)throw new Error(`La propiedad tiene otro contrato vigente (${otherActive.code}). Resolvelo antes de renovar para no dejar dos contratos activos.`);

    await client.query("UPDATE contracts SET previous_contract_id=$1,status='Activo',updated_at=now() WHERE id=$2",[contractId,newContractId]);
    await client.query("UPDATE contracts SET status='Renovado',updated_at=now() WHERE id=$1",[contractId]);
    const substituted=await rows(client,`UPDATE installments i SET status='Sustituido'
      WHERE i.contract_id=$1 AND i.period>=$2 AND i.status IN ('Pendiente','Vencido') AND i.manual_partial_amount=0
        AND NOT EXISTS (SELECT 1 FROM payments pay WHERE pay.installment_id=i.id)
        AND NOT EXISTS (SELECT 1 FROM installment_services s WHERE s.installment_id=i.id)
        AND i.financial_closed_at IS NULL
      RETURNING i.id,i.period`,[contractId,dates.start_period]);
    const kept=await rows(client,`SELECT id,period,status FROM installments WHERE contract_id=$1 AND period>=$2 AND status<>'Sustituido' ORDER BY period`,[contractId,dates.start_period]);
    const property=await one(client,'SELECT address FROM properties WHERE id=$1',[previous.property_id]);
    const details={previous_contract_id:contractId,previous_contract_code:previous.code,new_contract_id:newContractId,new_contract_code:next.code,property_id:previous.property_id,property:property?.address||null,new_source_document_id:next.source_document_id,previous_source_document_id:previous.source_document_id,new_contract_previous_status:next.status,substituted_installments:substituted.map(row=>row.period).sort(),kept_overlapping_installments:kept.map(row=>({period:row.period,status:row.status})),linked_at:new Date().toISOString()};
    for(const entityId of [newContractId,contractId])await client.query('INSERT INTO audit_log(id,entity_type,entity_id,action,details_json) VALUES ($1,$2,$3,$4,$5)',[uid(),'contract',entityId,'contract_renewal_linked',details]);
    await client.query('COMMIT');
    return{id:newContractId,previous_contract_id:contractId,status:'Activo',previous_status:'Renovado',substituted_installments:details.substituted_installments,kept_overlapping_installments:details.kept_overlapping_installments};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

async function rescindContract(db,contractId,input={}){
  const date=input.rescission_date||new Date().toISOString().slice(0,10),penalty=Number(input.penalty_amount||0);
  return transitionContract(db,contractId,'rescind',input,async(client,contract)=>{
    await client.query(`UPDATE contracts SET status='Rescindido',end_date=$1,rescinded_at=$1,rescission_penalty=$2,deposit_returned_at=CASE WHEN $3 THEN $1 ELSE deposit_returned_at END,deposit_returned_amount=CASE WHEN $3 THEN COALESCE(deposit_amount,0) ELSE deposit_returned_amount END,updated_at=now() WHERE id=$4`,[date,penalty,booleanInput(input.return_deposit),contractId]);
    await client.query("UPDATE installments SET status='Vencido' WHERE contract_id=$1 AND due_date>$2 AND status NOT IN ('Pagado','Sustituido')",[contractId,date]);
    if(penalty>0)await client.query('INSERT INTO ledger_entries(id,entry_date,kind,category,description,amount,currency,property_id,contract_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[uid(),date,'Ingreso','Rescisión',`Multa por rescisión ${contract.code}`,penalty,contract.currency,contract.property_id,contractId]);
    if(booleanInput(input.return_deposit)&&!contract.deposit_returned_at&&Number(contract.deposit_amount||0)>0)await client.query('INSERT INTO ledger_entries(id,entry_date,kind,category,description,amount,currency,property_id,contract_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[uid(),date,'Gasto','Depósito',`Devolución de depósito ${contract.code}`,Number(contract.deposit_amount),contract.currency,contract.property_id,contractId]);
    return{status:'Rescindido',details:{rescission_date:date,penalty_amount:penalty,return_deposit:booleanInput(input.return_deposit)}};
  });
}

async function returnDeposit(db,contractId,input={}){
  const contract=await one(db,'SELECT * FROM contracts WHERE id=$1',[contractId]);
  if(!contract)throw new Error('Contrato no encontrado.');
  if(contract.deposit_returned_at)throw new Error(`El depósito ya figura devuelto el ${dateKey(contract.deposit_returned_at)}; no se registra dos veces.`);
  const amount=Number(input.amount||contract.deposit_amount||0);
  if(amount<=0)throw new Error('El importe del depósito debe ser mayor a cero.');
  const date=input.date||new Date().toISOString().slice(0,10);
  await db.query('UPDATE contracts SET deposit_returned_at=$1,deposit_returned_amount=$2,updated_at=now() WHERE id=$3',[date,amount,contractId]);
  await db.query('INSERT INTO ledger_entries(id,entry_date,kind,category,description,amount,currency,property_id,contract_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[uid(),date,'Gasto','Depósito',`Devolución de depósito ${contract.code}`,amount,contract.currency,contract.property_id,contractId]);
  await db.query('INSERT INTO audit_log(id,entity_type,entity_id,action,details_json) VALUES ($1,$2,$3,$4,$5)',[uid(),'contract',contractId,'deposit_returned',{amount,date}]);
  return{id:contractId,deposit_returned_amount:amount,deposit_returned_at:date};
}

async function attachContractFile(db,contractId,file){
  const contract=await one(db,'SELECT id,property_id FROM contracts WHERE id=$1',[contractId]);
  if(!contract)throw new Error('Contrato no encontrado.');
  const stored=await persistUploadedContract(db,file);
  const existing=await one(db,'SELECT id,contract_id FROM documents WHERE sha256=$1',[stored.sha256]);
  if(existing){
    const originalOf=await one(db,'SELECT id FROM contracts WHERE source_document_id=$1 AND id<>$2 LIMIT 1',[existing.id,contractId]);
    if(originalOf||existing.contract_id&&existing.contract_id!==contractId)throw new Error('Ese PDF ya respalda otro contrato. No se puede reasignar su evidencia original.');
    const linked=await db.query('UPDATE documents SET contract_id=$1,property_id=$2 WHERE id=$3 AND (contract_id IS NULL OR contract_id=$1) RETURNING id',[contractId,contract.property_id,existing.id]);
    if(!linked.rowCount)throw new Error('El documento cambió de vínculo. Actualizá la lista.');
    return{id:existing.id,storedPath:stored.path,attached:true,alreadyStored:true};
  }
  const id=uid();
  await db.query('INSERT INTO documents(id,filename,absolute_path,sha256,property_id,contract_id) VALUES ($1,$2,$3,$4,$5,$6)',[id,path.basename(stored.path),stored.path,stored.sha256,contract.property_id,contractId]);
  await db.query('INSERT INTO audit_log(id,entity_type,entity_id,action,details_json) VALUES ($1,$2,$3,$4,$5)',[uid(),'contract',contractId,'file_attached',{documentId:id,storedPath:stored.path}]);
  return{id,storedPath:stored.path,attached:true,alreadyStored:stored.alreadyStored};
}

// Vista previa de la eliminación: qué se borra, qué se desvincula, qué se conserva y qué la impide.
async function contractImpact(client,contractId){
  if(!UUID_PATTERN.test(String(contractId)))throw new Error('Contrato no encontrado.');
  const contract=await one(client,`SELECT c.*,p.address property,pe.full_name tenant FROM contracts c JOIN properties p ON p.id=c.property_id JOIN persons pe ON pe.id=c.tenant_id WHERE c.id=$1`,[contractId]);
  if(!contract)throw new Error('Contrato no encontrado.');
  const counts=await one(client,`SELECT
    (SELECT COUNT(*)::int FROM installments WHERE contract_id=$1) installments,
    (SELECT COUNT(*)::int FROM payments pay JOIN installments i ON i.id=pay.installment_id WHERE i.contract_id=$1) payments,
    (SELECT COUNT(*)::int FROM installments WHERE contract_id=$1 AND manual_partial_amount>0) manual_partials,
    (SELECT COUNT(*)::int FROM ledger_entries WHERE contract_id=$1) ledger,
    (SELECT COUNT(*)::int FROM incidents WHERE contract_id=$1) incidents,
    (SELECT COUNT(*)::int FROM documents WHERE contract_id=$1 OR id=$2::uuid) documents,
    (SELECT COUNT(*)::int FROM guarantees WHERE contract_id=$1) guarantees,
    (SELECT COUNT(*)::int FROM recurring_charges WHERE contract_id=$1) recurring_charges,
    (SELECT COUNT(*)::int FROM installment_services s JOIN installments i ON i.id=s.installment_id WHERE i.contract_id=$1) tenant_services,
    (SELECT COUNT(*)::int FROM service_rules WHERE contract_id=$1) service_rules,
    (SELECT COUNT(*)::int FROM initial_payments WHERE contract_id=$1) initial_payments,
    (SELECT COUNT(*)::int FROM rent_adjustment_history WHERE contract_id=$1) ipc_history,
    (SELECT COUNT(*)::int FROM contracts WHERE property_id=$3 AND id<>$1) other_property_contracts`,[contractId,contract.source_document_id,contract.property_id]);
  const successor=await one(client,'SELECT code,alias FROM contracts WHERE previous_contract_id=$1 LIMIT 1',[contractId]);
  const previous=contract.previous_contract_id?await one(client,'SELECT code,alias FROM contracts WHERE id=$1',[contract.previous_contract_id]):null;
  const people=await rows(client,`SELECT pe.id,pe.full_name,
      (pe.id=$2 OR EXISTS(SELECT 1 FROM contract_tenants t WHERE t.contract_id=$1 AND t.person_id=pe.id)) is_tenant,
      EXISTS(SELECT 1 FROM contract_owners o WHERE o.contract_id=$1 AND o.person_id=pe.id) is_owner_here,
      (SELECT COUNT(DISTINCT x.id)::int FROM contracts x LEFT JOIN contract_tenants xt ON xt.contract_id=x.id LEFT JOIN contract_owners xo ON xo.contract_id=x.id WHERE x.id<>$1 AND (x.tenant_id=pe.id OR xt.person_id=pe.id OR xo.person_id=pe.id)) other_contracts,
      (SELECT COUNT(*)::int FROM property_owners po WHERE po.person_id=pe.id) properties
    FROM persons pe WHERE pe.id=$2 OR pe.id IN (SELECT person_id FROM contract_tenants WHERE contract_id=$1 UNION SELECT person_id FROM contract_owners WHERE contract_id=$1) ORDER BY pe.full_name`,[contractId,contract.tenant_id]);
  const name=row=>row.alias||row.code,blockers=[];
  if(counts.payments)blockers.push(`Tiene cobros registrados (${counts.payments}). Los cobros no se borran: anulá o archivá el contrato para conservar el historial.`);
  if(counts.tenant_services||counts.service_rules)blockers.push('Tiene cargos de servicios o recurrencias con historial económico. Archivá el contrato para conservarlos.');
  if(counts.manual_partials)blockers.push(`Tiene pagos parciales cargados en ${plural(counts.manual_partials,'cuota')}.`);
  if(counts.ledger)blockers.push(`Tiene ${plural(counts.ledger,'movimiento contable','movimientos contables')} asociados (multas, depósitos u otros).`);
  if(successor)blockers.push(`Fue renovado por ${name(successor)}: eliminarlo rompería el historial de renovaciones.`);
  if(previous)blockers.push(`Es la renovación de ${name(previous)}: eliminarlo dejaría al contrato anterior sin su reemplazo. Anulalo si fue cargado por error.`);
  const keep=[{type:'property',role:'Propiedad',id:contract.property_id,label:contract.property,detail:counts.other_property_contracts?`Tiene ${plural(counts.other_property_contracts,'contrato más','contratos más')}.`:'Queda sin contratos: podrás archivarla o eliminarla desde Propiedades.',manage:'properties'},
    ...people.map(person=>{const role=person.is_tenant?'Inquilino':'Propietario',free=!person.other_contracts&&!person.properties;return{type:'person',role,id:person.id,label:person.full_name,detail:free?`Queda sin vínculos: podrás archivarlo o eliminarlo desde ${person.is_tenant?'Inquilinos':'Propietarios'}.`:person.other_contracts?`Figura en ${plural(person.other_contracts,'contrato más','contratos más')}.`:`Conserva ${plural(person.properties,'propiedad','propiedades')}.`,manage:person.is_tenant?'tenants':'owners'};})];
  const alternatives=['void','archive','deactivate'].filter(action=>!contractActionError(contract,action));
  return{entity:{type:'contract',id:contract.id,label:name(contract),detail:`${contract.property} · ${contract.tenant}`,status:contract.status},
    counts,can_delete:!blockers.length,blockers,
    remove:listItems([{label:'Cuotas sin cobros',count:counts.installments},{label:'Garantía del contrato',count:counts.guarantees},{label:'Servicios y cargos recurrentes del contrato',count:counts.recurring_charges},{label:'Pagos iniciales pactados',count:counts.initial_payments},{label:'Vínculos con inquilinos y propietarios (las personas se conservan)',count:people.length}]),
    unlink:listItems([{label:'Incidencias (quedan asociadas a la propiedad)',count:counts.incidents},{label:'Documentos PDF (el archivo y su registro se conservan y se pueden volver a importar)',count:counts.documents}]),
    keep:[...keep,...(counts.ipc_history?[{type:'history',role:'Historial',label:`Historial de ajustes IPC (${counts.ipc_history})`,detail:'Se conserva como auditoría.'}]:[])],
    irreversible:['Las cuotas pendientes y las condiciones del contrato se borran definitivamente.'],
    alternatives};
}

// Borra el contrato y lo exclusivo de él. Pagos y movimientos contables nunca llegan acá (los bloquea contractImpact);
// los documentos se desvinculan salvo que una reversión de importación pida quitarlos.
async function removeContractOnClient(client,contract,{reason=null,deleteDocuments=false}={}){
  const id=contract.id,summary={installments:0,documents:0,incidents:0,contracts:0};
  summary.installments=(await client.query('DELETE FROM installments WHERE contract_id=$1',[id])).rowCount;
  for(const table of ['initial_payments','recurring_charges','guarantees','contract_tenants','contract_owners'])await client.query(`DELETE FROM ${table} WHERE contract_id=$1`,[id]);
  summary.incidents=(await client.query('UPDATE incidents SET contract_id=NULL WHERE contract_id=$1',[id])).rowCount;
  summary.documents=(await client.query(`${deleteDocuments?'DELETE FROM documents':'UPDATE documents SET contract_id=NULL'} WHERE contract_id=$1 OR id=$2::uuid`,[id,contract.source_document_id])).rowCount;
  await client.query(`UPDATE imports SET status='Revertido',result_json=COALESCE(result_json,'{}'::jsonb) || $2::jsonb WHERE status='Procesado' AND result_json->'completion_result'->>'contractId'=$1::text`,[id,JSON.stringify({deleted_contract_at:new Date().toISOString(),delete_reason:reason||'Eliminado manualmente',contract_deleted:true})]);
  summary.contracts=(await client.query('DELETE FROM contracts WHERE id=$1',[id])).rowCount;
  return summary;
}

async function deleteContract(db,contractId,input={}){
  if(!UUID_PATTERN.test(String(contractId)))throw new Error('Contrato no encontrado.');
  return inTransaction(db,async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['ferraro:ipc:write']);
    const exists=await one(client,'SELECT id FROM contracts WHERE id=$1',[contractId]);
    if(!exists){if(await one(client,`SELECT 1 FROM audit_log WHERE entity_type='contract' AND entity_id=$1 AND action='deleted'`,[contractId]))return{id:contractId,deleted:true,alreadyDeleted:true};throw new Error('Contrato no encontrado.');}
    const contract=await lockContract(client,contractId),impact=await contractImpact(client,contractId);
    if(!impact.can_delete){const error=new Error(impact.blockers.join(' '));error.details=impact;throw error;}
    if(!booleanInput(input.confirm))throw new Error('Confirmá la eliminación después de revisar la vista previa.');
    const reason=cleanNullable(input.reason)||'Eliminado manualmente',summary=await removeContractOnClient(client,contract,{reason});
    await audit(client,'contract',contractId,'deleted',{...summary,reason,code:contract.code,property_id:contract.property_id,tenant_id:contract.tenant_id,source_document_id:contract.source_document_id,kept:impact.keep});
    return{id:contractId,deleted:true,summary,kept:impact.keep};
  });
}

// Every incoming payment and service operation shares the financial write lock.
// A distributed payment is one transaction, including idempotency and all allocations.
async function recordPayment(client,installmentId,input){
  const amount=decimal(scaled(input.amount));if(scaled(amount)<=0n)throw new Error('El importe del cobro debe ser mayor a cero.');
  const link=await one(client,'SELECT contract_id FROM installments WHERE id=$1',[installmentId]);
  if(!link)throw new Error('Cuota no encontrada.');
  const contract=await one(client,'SELECT * FROM contracts WHERE id=$1 FOR UPDATE',[link.contract_id]);
  const installment=await one(client,'SELECT * FROM installments WHERE id=$1 FOR UPDATE',[installmentId]);
  if(installment.financial_closed_at)throw new Error('El período está cerrado para nuevos movimientos.');
  if(input.currency&&input.currency!==installment.currency)throw new Error('La moneda del pago no coincide con la cuota.');
  if(installment.status==='Sustituido')throw new Error('Esta cuota fue sustituida por la renovación del contrato. Registrá el cobro en el contrato vigente.');
  if(contract.adjustment_index==='IPC'&&!installment.ipc_managed)installment.adjustment_pending=true;
  const settings=await allSettings(client);
  await client.query('INSERT INTO payments(id,installment_id,amount,paid_at,method,bank_name,reference,notes,payment_type,account_name,tax_status,is_split) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[uid(),installmentId,amount,input.paid_at||new Date().toISOString().slice(0,10),input.method||'Transferencia',input.bank_name||settings.bank_name,input.reference||null,input.notes||null,input.payment_type||'Alquiler',input.account_name||null,input.tax_status||'Declarado',booleanInput(input.is_split)]);
  const sum=(await one(client,'SELECT COALESCE(SUM(amount),0)::text total FROM payments WHERE installment_id=$1',[installmentId])).total;
  const paid=decimal(scaled(sum)+scaled(installment.manual_partial_amount)),status=paymentStatus(installment,paid);
  await client.query('UPDATE installments SET status=$1,adjustment_pending=$2 WHERE id=$3',[status,installment.adjustment_pending,installmentId]);
  return {id:installmentId,contract_id:installment.contract_id,period:installment.period,paid:Number(paid),status,adjustment_pending:installment.adjustment_pending};
}
async function performPayment(db,installmentId,input,{distribute=false}={}){
  const client=await db.connect(),notifications=[];
  const requestHash=crypto.createHash('sha256').update(JSON.stringify({installmentId,distribute,input})).digest('hex');let result;
  try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['ferraro:ipc:write']);
    if(input.request_id){
      if(!UUID_PATTERN.test(String(input.request_id)))throw new Error('Identificador de pago inválido.');
      const prior=await one(client,'SELECT * FROM payment_requests WHERE request_id=$1',[input.request_id]);
      if(prior){if(prior.request_hash!==requestHash)throw new Error('Este identificador ya fue usado para otro pago.');await client.query('ROLLBACK');return {...prior.result_json,replayed:true};}
    }
    if(distribute){
      if(!input.contract_id)throw new Error('Elegí el contrato.');
      const contract=await one(client,'SELECT * FROM contracts WHERE id=$1 FOR UPDATE',[input.contract_id]);if(!contract)throw new Error('Contrato no encontrado.');
      if(input.currency&&input.currency!==contract.currency)throw new Error('La moneda no coincide con el contrato.');
      let remaining=scaled(input.amount);if(remaining<=0n)throw new Error('El importe debe ser mayor a cero.');const original=remaining;
      const pending=await rows(client,`SELECT i.*,(COALESCE((SELECT SUM(amount) FROM payments p WHERE p.installment_id=i.id),0)+i.manual_partial_amount)::text paid_amount FROM installments i JOIN contracts c ON c.id=i.contract_id WHERE ${COLLECTIBLE_INSTALLMENT_SQL} AND c.id=$1 ORDER BY i.due_date,i.id FOR UPDATE OF i`,[contract.id]);
      let last=null;
      for(const item of pending){if(remaining<=0n)break;const due=scaled(balance(item));if(due<=0n)continue;const amount=remaining<due?remaining:due;last=await recordPayment(client,item.id,{...input,currency:contract.currency,amount:decimal(amount),is_split:true});notifications.push(last);remaining-=amount;}
      result={distributed:Number(decimal(original-remaining)),remaining:Number(decimal(remaining)),currency:contract.currency,last};
    }else{result=await recordPayment(client,installmentId,input);notifications.push(result);}
    if(input.request_id)await client.query('INSERT INTO payment_requests(request_id,request_hash,result_json) VALUES($1,$2,$3)',[input.request_id,requestHash,JSON.stringify(result)]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  for(const item of notifications){
    const owners=await rows(db,`SELECT co.person_id owner_id,p.address property FROM contract_owners co JOIN contracts c ON c.id=co.contract_id JOIN properties p ON p.id=c.property_id WHERE co.contract_id=$1`,[item.contract_id]);
    for(const owner of owners)await triggerAutomation(db,'PAYMENT_REGISTERED',{ownerId:owner.owner_id,relatedEntityType:'installment',relatedEntityId:item.id,parameters:[owner.property||'tu propiedad',item.period],idempotencyKey:`PAYMENT_REGISTERED:${owner.owner_id}:${item.id}:${item.status}`}).catch(error=>console.error('WhatsApp automation:',error.message));
  }
  return result;
}
const registerPayment=(db,id,input)=>performPayment(db,id,input);

async function handleApi(db,req,res,pathname){
  const parts=pathname.split('/').filter(Boolean),resource=parts[1],id=parts[2],action=parts[3];
  if(resource==='health')return json(res,200,{status:'ok',service:'Ferraro Propiedades',database:'postgresql'});
  if(resource==='whatsapp')return handleWhatsAppApi(db,req,res,pathname,{json,text,readBody,readRawBody});
  if(resource==='owner-portal'&&id==='verify'&&req.method==='GET'){
    const token=new URL(req.url,`http://${req.headers.host||'localhost'}`).searchParams.get('token')||'';
    const tokenHash=crypto.createHash('sha256').update(token).digest('hex');
    const row=await one(db,`SELECT t.id,t.owner_id,t.expires_at,t.revoked_at,p.full_name owner_name
      FROM owner_portal_tokens t JOIN persons p ON p.id=t.owner_id
      WHERE t.token_hash=$1`,[tokenHash]);
    if(!row||row.revoked_at||new Date(row.expires_at)<new Date())return json(res,401,{error:'Token inválido o vencido.'});
    await db.query('UPDATE owner_portal_tokens SET used_at=now() WHERE id=$1',[row.id]);
    return json(res,200,{owner_id:row.owner_id,owner_name:row.owner_name,expires_at:row.expires_at});
  }
  if(resource==='ipc'&&id==='latest'&&req.method==='GET')return json(res,200,await latestIpcSummary(db));
  if(resource==='ipc'&&id==='refresh'&&req.method==='POST')return json(res,200,await refreshAndUpdate(db,{force:true}));
  if(resource==='ipc'&&id==='reconciliation'&&['simulate','apply'].includes(action)&&req.method==='POST'){
    const input=await readBody(req);
    if(action==='apply'&&input.contract_ids)return json(res,200,await applyReconciliationBatch(db,{contractIds:input.contract_ids,tokens:input.tokens,reason:input.reason,interpretationConfirmed:booleanInput(input.interpretation_confirmed)}));
    if(action==='simulate'&&input.contract_changes)return json(res,200,await simulateContractChanges(db,input.contract_id,input.contract_changes));
    return json(res,200,await reconcileInstallments(db,{contractId:input.contract_id||null,apply:action==='apply',token:input.token,reason:input.reason||'',interpretationConfirmed:booleanInput(input.interpretation_confirmed)}));
  }
  if(resource==='ipc'&&id==='preview'&&req.method==='POST'){
    const input=await readBody(req),{buildRentPreview}=require('./modules/imports/contract-parser');
    return json(res,200,buildRentPreview({startDate:input.start_date,durationMonths:input.duration_months,initialAmount:input.initial_amount,currency:input.currency,adjustmentIndex:input.adjustment_index,adjustmentFrequencyMonths:input.adjustment_frequency_months,ipcLagMonths:input.ipc_lag_months},await loadStoredSeries(db)));
  }
  if(resource==='contracts'&&id&&action==='services'&&req.method==='GET')return json(res,200,await serviceDetails(db,id));
  if(resource==='contracts'&&id&&action==='services'&&['simulate','apply'].includes(parts[4])&&req.method==='POST')return json(res,200,await serviceOperation(db,id,await readBody(req),{apply:parts[4]==='apply'}));
  if(resource==='contracts'&&id&&action==='protection'&&req.method==='GET')return json(res,200,await contractProtection(db,id));
  if(resource==='contracts'&&id&&action==='rectification'&&['simulate','apply'].includes(parts[4])&&req.method==='POST')return json(res,200,await rectifyContract(db,id,await readBody(req),{apply:parts[4]==='apply'}));
  if(resource==='contracts'&&id&&action==='adjustments'&&req.method==='GET')return json(res,200,await rows(db,'SELECT * FROM rent_adjustment_history WHERE contract_id=$1 ORDER BY applied_at,version',[id]));
  if(resource==='geo'&&id==='provinces'&&req.method==='GET')return json(res,200,{country:'Argentina',provinces:await geo.provinces()});
  if(resource==='geo'&&id==='localities'&&req.method==='GET'){const province=new URL(req.url,`http://${req.headers.host||'localhost'}`).searchParams.get('province')||'';return json(res,200,{province:geo.normalizeProvinceName(province),label:geo.isCaba(province)?'Barrio':'Ciudad',localities:await geo.localities(province)});}
  if(resource==='dashboard'&&req.method==='GET')return json(res,200,await dashboard(db));
  if(resource==='settings'){
    if(req.method==='GET')return json(res,200,await allSettings(db));
    if(req.method==='PUT'){const input=await readBody(req);if(input.default_management_fee_pct!==undefined)validateFee(input.default_management_fee_pct);for(const [key,value]of Object.entries(input))await db.query('INSERT INTO settings(key,value,updated_at) VALUES ($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()',[key,String(value)]);return json(res,200,await allSettings(db));}
  }
  if(resource==='imports'){
    if(id==='scan'&&req.method==='POST'){
      try{return json(res,200,await scanImportDirectory(db));}catch(e){console.error('Scan error:',e);return json(res,500,{error:e.message});}
    }
    if(id&&action==='complete'&&req.method==='POST'){
      try{return json(res,200,await completeImportReview(db,id,await readBody(req)));}catch(error){return json(res,400,{error:error.message,details:error.details||null});}
    }
    if(id&&action==='discard'&&req.method==='POST'){
      try{return json(res,200,await discardImport(db,id,await readBody(req)));}catch(error){return json(res,400,{error:error.message});}
    }
    if(id&&action==='revert'&&req.method==='POST'){
      try{return json(res,200,await revertImport(db,id,await readBody(req)));}catch(error){return json(res,400,{error:error.message});}
    }
    if(id==='upload'&&req.method==='POST'){
      try{
        const {files}=await readMultipart(req);
        if(!files||!files.file){
          return json(res,400,{error:'No se envió archivo en campo "file"'});
        }
        const file=files.file;
        if(!file.filename||!file.data){
          return json(res,400,{error:'Archivo inválido'});
        }
        const stored=await persistUploadedContract(db,file);
        // Una subida es una acción explícita: puede volver a importar un PDF cuyo contrato fue eliminado o descartado.
        const result=await importPdf(db,stored.path,{mode:'manual'});
        return json(res,['Omitido','Confirmación requerida'].includes(result.status)?200:201,{...result,storedPath:stored.path,alreadyStored:stored.alreadyStored});
      }catch(error){
        console.error('Upload error:',error.message);
        return json(res,500,{error:error.message});
      }
    }
  }
  if(resource==='payments'&&id&&action==='register'&&req.method==='POST'){
    try{return json(res,201,await registerPayment(db,id,await readBody(req)));}catch(error){return json(res,400,{error:error.message});}
  }
  if(resource==='payments'&&id==='register'&&req.method==='POST')return json(res,201,await performPayment(db,null,await readBody(req),{distribute:true}));
  if(resource==='contracts'&&id&&action==='renewal-candidates'&&req.method==='GET'){
    try{return json(res,200,await renewalCandidates(db,id));}catch(error){return json(res,400,{error:error.message});}
  }
  if(resource==='document-admin')return handleDocumentAdminApi(db,req,res,id,{json,readBody});
  if(resource==='contracts'&&id&&['impact','lifecycle'].includes(action)&&req.method==='GET'){
    try{return json(res,200,action==='impact'?await contractImpact(db,id):await contractLifecycle(db,id));}catch(error){return json(res,400,{error:error.message});}
  }
  if(ENTITY_RESOURCES[resource]&&id&&action==='impact'&&req.method==='GET'){
    try{return json(res,200,await entityImpact(db,resource,id));}catch(error){return json(res,400,{error:error.message});}
  }
  if(ENTITY_RESOURCES[resource]&&id&&['archive','restore'].includes(action)&&req.method==='POST'){
    try{return json(res,200,await setEntityArchived(db,resource,id,action==='archive',await readBody(req)));}catch(error){return json(res,400,{error:error.message});}
  }
  if(resource==='pending-collections'&&req.method==='GET')return json(res,200,(await enrichInstallmentsWithIpc(db,await rows(db,queries[resource]))).map(withCollectionTotals));
  if(queries[resource]&&req.method==='GET')return json(res,200,await rows(db,queries[resource]));
  if(resource==='contracts'&&id&&action==='void'&&req.method==='POST'){
    try{return json(res,200,await voidContract(db,id,await readBody(req)));}catch(error){return json(res,400,{error:error.message});}
  }
  if(resource==='contracts'&&id&&action==='renew'&&req.method==='POST'){
    try{return json(res,201,await linkContractRenewal(db,id,await readBody(req)));}catch(error){return json(res,400,{error:error.message});}
  }
  if(resource==='contracts'&&id&&action==='rescind'&&req.method==='POST'){
    try{return json(res,200,await rescindContract(db,id,await readBody(req)));}catch(error){return json(res,400,{error:error.message});}
  }
  if(resource==='contracts'&&id&&action==='deactivate'&&req.method==='POST'){
    try{return json(res,200,await deactivateContract(db,id,await readBody(req)));}catch(error){return json(res,400,{error:error.message});}
  }
  const lifecycleHandlers={reactivate:reactivateContract,finalize:finalizeContract,archive:archiveContract,restore:restoreContract};
  if(resource==='contracts'&&id&&lifecycleHandlers[action]&&req.method==='POST'){
    try{return json(res,200,await lifecycleHandlers[action](db,id,await readBody(req)));}catch(error){return json(res,400,{error:error.message});}
  }
  if(resource==='contracts'&&id&&action==='return-deposit'&&req.method==='POST'){
    try{return json(res,200,await returnDeposit(db,id,await readBody(req)));}catch(error){return json(res,400,{error:error.message});}
  }
  if(resource==='contracts'&&id&&action==='upload-file'&&req.method==='POST'){
    try{
      const {files}=await readMultipart(req);
      if(!files?.file)return json(res,400,{error:'No se envió archivo en campo "file"'});
      return json(res,201,await attachContractFile(db,id,files.file));
    }catch(error){return json(res,400,{error:error.message});}
  }
  if(['properties','people','owners','incidents','ledger','expenses','services','other-income','contracts'].includes(resource)&&req.method==='POST')return json(res,201,await createRecord(db,resource,await readBody(req)));
  if(['incidents','contracts','owners','tenants','pending-collections'].includes(resource)&&id&&req.method==='PATCH')return json(res,200,await updateRecord(db,resource,id,await readBody(req)));
  if(resource==='contracts'&&id&&req.method==='DELETE'){
    try{return json(res,200,await deleteContract(db,id,await readBody(req)));}catch(error){return json(res,400,{error:error.message,details:error.details||null});}
  }
  if((ENTITY_RESOURCES[resource]||resource==='guarantors')&&id&&!action&&req.method==='DELETE'){
    try{return json(res,200,await deleteRecord(db,resource,id,await readBody(req)));}catch(error){return json(res,400,{error:error.message,details:error.details||null});}
  }
  return json(res,404,{error:'Ruta inexistente.'});
}

function staticFile(res,pathname){const relative=pathname==='/'?'index.html':pathname.slice(1),file=path.resolve(PUBLIC_DIR,relative);if(!file.startsWith(path.resolve(PUBLIC_DIR))||!fs.existsSync(file)||fs.statSync(file).isDirectory())return staticFile(res,'/index.html');const type={'.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.png':'image/png'}[path.extname(file)]||'application/octet-stream';res.writeHead(200,{'Content-Type':`${type}; charset=utf-8`});fs.createReadStream(file).pipe(res);}

async function createApp(options={}){
  const db=options.db||await openDatabase(options.databaseUrl);
  const server=http.createServer(async(req,res)=>{try{const pathname=new URL(req.url,`http://${req.headers.host||'localhost'}`).pathname;if(pathname.startsWith('/api/'))return await handleApi(db,req,res,pathname);return staticFile(res,pathname);}catch(error){return json(res,400,{error:error.message||'Error inesperado.'});}});
  let scanning=false;const scan=async()=>{if(scanning)return;scanning=true;try{await scanImportDirectory(db);}catch(error){console.error('Importación:',error.message);}finally{scanning=false;}};
  const startScanner=async()=>{await scan();const settings=await allSettings(db),timer=setInterval(scan,Math.max(10,Number(settings.scan_interval_seconds||30))*1000);timer.unref();return timer;};
  const startIpcUpdater=async()=>{
    let running=false;
    const tick=async()=>{if(running)return;running=true;try{await refreshAndUpdate(db);}catch(error){console.error('IPC:',error.message);}finally{running=false;}};
    await tick();const timer=setInterval(tick,60*60*1000);timer.unref();return timer;
  };
  const startWhatsAppGatewayWorker=async()=>createWhatsAppGatewayWorker(db).start();
  return{server,db,startScanner,startIpcUpdater,startWhatsAppGatewayWorker};
}
module.exports={createApp};

