const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {openDatabase,allSettings,uid,normalizeAddress}=require('./database');
const {scanImportDirectory,importPdf,completeImportReview}=require('./modules/imports/contract-parser');
const {adjustedAmountByIpc,latestIpcSummary}=require('./modules/ipc');
const {handleWhatsAppApi,triggerAutomation,normalizePhone}=require('./modules/whatsapp');
const {createWhatsAppGatewayWorker}=require('./modules/whatsapp-gateway');
const geo=require('./modules/geo');
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
  const existing=(await db.query(`SELECT absolute_path FROM documents WHERE sha256=$1 UNION SELECT absolute_path FROM imports WHERE sha256=$1 AND status IN ('Revisión','Error','Procesado') ORDER BY absolute_path LIMIT 1`,[sha256])).rows[0];
  if(existing?.absolute_path&&fs.existsSync(existing.absolute_path))return{path:existing.absolute_path,sha256,alreadyStored:true};
  const settings=await allSettings(db),directory=path.resolve(settings.import_directory);
  fs.mkdirSync(directory,{recursive:true});
  const destination=uniquePath(directory,safeUploadName(file.filename));
  fs.writeFileSync(destination,file.data);
  return{path:destination,sha256,alreadyStored:false};
}
const rows=async(db,sql,params=[])=>(await db.query(sql,params)).rows;
const one=async(db,sql,params=[])=>rows(db,sql,params).then(result=>result[0]);

async function enrichInstallmentsWithIpc(db, installments){
  const enriched=[];
  for(const installment of installments){
    if(installment.adjustment_index==='IPC'&&installment.adjustment_frequency_months){
      const adjustment=await adjustedAmountByIpc(installment,installment.period);
      enriched.push({...installment,expected_amount:adjustment.amount,ipc_applied:adjustment.applied,ipc_pending_official_data:Boolean(adjustment.pendingOfficialData),ipc_source_period:adjustment.sourcePeriod||null});
    }else{
      enriched.push({...installment,expected_amount:Number(installment.expected_amount)});
    }
  }
  return enriched;
}

function withCollectionTotals(installment){
  const expected=Number(installment.expected_amount||0),vat=Number(installment.vat_amount||0),late=Number(installment.late_fee_amount||0),discount=Number(installment.discount_amount||0),paid=Number(installment.paid_amount||0),declared=Number(installment.declared_amount||0),manualPartial=Number(installment.manual_partial_amount||0);
  const due=Math.max(0,expected+vat+late-discount-paid);
  return{...installment,vat_amount:vat,late_fee_amount:late,discount_amount:discount,declared_amount:declared,manual_partial_amount:manualPartial,paid_amount:paid,due_amount:due,total_amount:expected+vat+late-discount};
}

async function dashboard(db){
  const today=new Date().toISOString().slice(0,10),month=today.slice(0,7);
  const baseKpis=await one(db,`SELECT
    (SELECT COUNT(*)::int FROM properties) properties,
    (SELECT COUNT(*)::int FROM contracts WHERE status IN ('Activo','Revisión')) active_contracts,
    (SELECT COUNT(*)::int FROM installments i JOIN contracts c ON c.id=i.contract_id WHERE i.status IN ('Pendiente','Parcial','Vencido') AND i.due_date<$1::date AND c.status IN ('Activo','Revisión')) overdue_count,
    (SELECT COALESCE(SUM(amount),0)::float FROM payments WHERE to_char(paid_at,'YYYY-MM')=$2) collected_month,
    (SELECT COUNT(*)::int FROM imports WHERE status='Revisión') reviews,
    (SELECT COUNT(*)::int FROM incidents WHERE status NOT IN ('Resuelta','Cerrada')) open_incidents`,[today,month]);
  const dueRaw=await rows(db,`SELECT i.id,i.period,i.due_date,i.expected_amount::float,i.currency,i.status,i.adjustment_pending,c.adjustment_index,c.adjustment_frequency_months,c.initial_amount::float,c.start_date,p.address property,pe.full_name tenant
    FROM installments i JOIN contracts c ON c.id=i.contract_id JOIN properties p ON p.id=c.property_id JOIN persons pe ON pe.id=c.tenant_id
    WHERE i.status<>'Pagado' AND c.status IN ('Activo','Revisión') ORDER BY i.due_date LIMIT 8`);
  const due=await enrichInstallmentsWithIpc(db,dueRaw);
  const monthInstallments=await rows(db,`SELECT i.period,i.expected_amount::float,i.adjustment_pending,c.adjustment_index,c.adjustment_frequency_months,c.initial_amount::float,c.start_date
    FROM installments i JOIN contracts c ON c.id=i.contract_id WHERE i.period=$1 AND c.status IN ('Activo','Revisión')`,[month]);
  const enrichedMonth=await enrichInstallmentsWithIpc(db,monthInstallments);
  const movement=await rows(db,`SELECT to_char(paid_at,'YYYY-MM') period,SUM(amount)::float total FROM payments WHERE paid_at>=current_date-interval '5 months' GROUP BY 1 ORDER BY 1`);
  const ipc=await latestIpcSummary().catch(()=>null);
  return{kpis:{...baseKpis,expected_month:enrichedMonth.reduce((sum,item)=>sum+Number(item.expected_amount||0),0)},due,movement,today,ipc};
}

const queries={
  properties:`SELECT p.*,string_agg(DISTINCT pe.full_name,' / ') owners,(SELECT COUNT(*)::int FROM contracts c WHERE c.property_id=p.id AND c.status IN ('Activo','Revisión')) active_contracts,(SELECT c.code FROM contracts c WHERE c.property_id=p.id AND c.status IN ('Activo','Revisión') ORDER BY c.start_date DESC LIMIT 1) active_contract_code,(SELECT c.alias FROM contracts c WHERE c.property_id=p.id AND c.status IN ('Activo','Revisión') ORDER BY c.start_date DESC LIMIT 1) active_contract_alias,(SELECT tenant.full_name FROM contracts c JOIN persons tenant ON tenant.id=c.tenant_id WHERE c.property_id=p.id AND c.status IN ('Activo','Revisión') ORDER BY c.start_date DESC LIMIT 1) active_tenant FROM properties p LEFT JOIN property_owners po ON po.property_id=p.id LEFT JOIN persons pe ON pe.id=po.person_id GROUP BY p.id ORDER BY p.address`,
  owners:`SELECT pe.id,pe.full_name,pe.person_kind,pe.first_name,pe.last_name,pe.document_type,pe.document_number,pe.tax_id,pe.vat_condition,pe.email,pe.phone,pe.whatsapp,pe.whatsapp_normalized,pe.whatsapp_opt_in,pe.whatsapp_preferences_json,pe.address,pe.country,pe.province,pe.city,pe.neighborhood,pe.liquidation_email_enabled,pe.fiscal_address,pe.gross_income_number,pe.activity_start_date,COUNT(DISTINCT po.property_id)::int properties_count,string_agg(DISTINCT p.address,' / ') properties,COALESCE(json_agg(DISTINCT po.property_id) FILTER (WHERE po.property_id IS NOT NULL),'[]'::json)::json property_ids FROM persons pe LEFT JOIN property_owners po ON po.person_id=pe.id LEFT JOIN properties p ON p.id=po.property_id WHERE pe.is_owner=true OR po.person_id IS NOT NULL GROUP BY pe.id ORDER BY pe.full_name`,
  people:`SELECT pe.*,CASE WHEN COUNT(po.person_id)>0 THEN 'Propietario' END owner_role,CASE WHEN COUNT(c.id)+COUNT(ct.contract_id)>0 THEN 'Inquilino' END tenant_role FROM persons pe LEFT JOIN property_owners po ON po.person_id=pe.id LEFT JOIN contracts c ON c.tenant_id=pe.id LEFT JOIN contract_tenants ct ON ct.person_id=pe.id GROUP BY pe.id ORDER BY pe.full_name`,
  tenants:`WITH tenant_links AS (SELECT tenant_id person_id,id contract_id FROM contracts UNION SELECT person_id,contract_id FROM contract_tenants) SELECT pe.id,pe.full_name,pe.person_kind,pe.first_name,pe.last_name,pe.document_type,pe.document_number,pe.tax_id,pe.vat_condition,pe.nationality,pe.email,pe.phone,pe.whatsapp,pe.address,pe.country,pe.province,pe.city,pe.neighborhood,c.id contract_id,c.code contract_code,c.alias contract_alias,c.status contract_status,c.start_date,c.end_date,p.address property,COALESCE(g.gu_count,0)::int guarantors_count,g.names guarantors,COALESCE(g.items,'[]'::json)::json guarantors_json FROM tenant_links tl JOIN persons pe ON pe.id=tl.person_id JOIN contracts c ON c.id=tl.contract_id JOIN properties p ON p.id=c.property_id LEFT JOIN LATERAL (SELECT COUNT(*) gu_count,string_agg(COALESCE(gg.guarantor_name,gg.provider_detail,gg.provider), ' / ' ORDER BY COALESCE(gg.guarantor_name,gg.provider_detail,gg.provider)) names,json_agg(json_build_object('id',gg.id,'full_name',COALESCE(gg.guarantor_name,gg.provider_detail,gg.provider,gg.guarantee_type),'document_number',gg.guarantor_document,'email',gg.guarantor_email,'phone',gg.guarantor_phone,'address',COALESCE(gg.guarantor_address,gg.guaranteed_property),'guarantee_type',gg.guarantee_type,'provider',gg.provider,'provider_detail',gg.provider_detail,'contract_id',gg.contract_id)) items FROM guarantees gg WHERE gg.contract_id=c.id AND COALESCE(gg.guarantor_name,gg.provider_detail,gg.provider,gg.guarantee_type) IS NOT NULL) g ON true ORDER BY pe.full_name,c.start_date DESC`,
  guarantors:`SELECT g.id,g.contract_id,COALESCE(g.guarantor_name,g.provider_detail,g.provider,g.guarantee_type) full_name,g.guarantor_document document_number,g.guarantor_email email,g.guarantor_phone phone,g.guarantor_address address,g.guarantee_type,g.provider,g.provider_detail,g.guaranteed_property,g.policy_number,g.expiry_date,g.notes,c.code contract_code,c.alias contract_alias,c.status contract_status,p.address property,pe.full_name tenant FROM guarantees g JOIN contracts c ON c.id=g.contract_id JOIN properties p ON p.id=c.property_id JOIN persons pe ON pe.id=c.tenant_id WHERE COALESCE(g.guarantor_name,g.provider_detail,g.provider,g.guarantee_type) IS NOT NULL ORDER BY full_name`,
  contracts:`SELECT c.*,c.initial_amount::float,c.deposit_amount::float,c.management_fee_pct::float,c.adjustment_value_pct::float,c.vat_percentage::float,c.rescission_penalty::float,c.deposit_returned_amount::float,p.address property,pe.id tenant_id,pe.full_name tenant,g.id guarantee_id,g.guarantee_type,g.provider,g.provider_detail,g.guarantor_name,g.guarantor_document,g.guaranteed_property,string_agg(DISTINCT own.full_name,', ') owners,string_agg(DISTINCT own.id::text,',') owner_ids,d.absolute_path document_path,d.filename document_filename FROM contracts c JOIN properties p ON p.id=c.property_id JOIN persons pe ON pe.id=c.tenant_id LEFT JOIN guarantees g ON g.contract_id=c.id LEFT JOIN contract_owners co ON co.contract_id=c.id LEFT JOIN persons own ON own.id=co.person_id LEFT JOIN documents d ON d.id=c.source_document_id GROUP BY c.id,p.address,pe.id,pe.full_name,g.id,g.guarantee_type,g.provider,g.provider_detail,g.guarantor_name,g.guarantor_document,g.guaranteed_property,d.absolute_path,d.filename ORDER BY c.start_date DESC`,
  collections:`SELECT pay.id,pay.installment_id,pay.amount::float,pay.paid_at,pay.method,pay.bank_name,pay.reference,pay.notes,pay.payment_type,pay.account_name,pay.tax_status,pay.is_split,pay.created_at,i.period,i.currency,c.id contract_id,c.code contract_code,c.alias contract_alias,p.address property,pe.full_name tenant,('Alquiler de ' || to_char(i.due_date,'TMMonth YYYY')) description,'Pagado' status FROM payments pay JOIN installments i ON i.id=pay.installment_id JOIN contracts c ON c.id=i.contract_id JOIN properties p ON p.id=c.property_id JOIN persons pe ON pe.id=c.tenant_id ORDER BY pay.paid_at DESC,pay.created_at DESC`,
  'pending-collections':`SELECT i.*,i.expected_amount::float,i.vat_amount::float,i.late_fee_amount::float,i.discount_amount::float,i.declared_amount::float,i.manual_partial_amount::float,i.discount_percentage::float,(COALESCE((SELECT SUM(pay.amount) FROM payments pay WHERE pay.installment_id=i.id),0)+i.manual_partial_amount)::float paid_amount,p.address property,pe.full_name tenant,c.id contract_id,c.code contract_code,c.alias contract_alias,c.adjustment_index,c.adjustment_frequency_months,c.initial_amount::float,c.start_date,c.payment_due_day,c.late_fee_json FROM installments i JOIN contracts c ON c.id=i.contract_id JOIN properties p ON p.id=c.property_id JOIN persons pe ON pe.id=c.tenant_id WHERE i.status<>'Pagado' AND c.status IN ('Activo','Revisión') ORDER BY i.due_date`,
  incidents:`SELECT i.*,p.address property FROM incidents i LEFT JOIN properties p ON p.id=i.property_id ORDER BY i.opened_at DESC`,
  ledger:`SELECT l.*,l.amount::float,p.address property FROM ledger_entries l LEFT JOIN properties p ON p.id=l.property_id ORDER BY l.entry_date DESC,l.created_at DESC`,
  expenses:`SELECT l.*,l.amount::float,p.address property FROM ledger_entries l LEFT JOIN properties p ON p.id=l.property_id WHERE l.kind='Gasto' AND l.category<>'Servicio' ORDER BY l.entry_date DESC,l.created_at DESC`,
  services:`SELECT l.*,l.amount::float,p.address property FROM ledger_entries l LEFT JOIN properties p ON p.id=l.property_id WHERE l.kind='Gasto' AND l.category='Servicio' ORDER BY l.entry_date DESC,l.created_at DESC`,
  'other-income':`SELECT l.*,l.amount::float,p.address property FROM ledger_entries l LEFT JOIN properties p ON p.id=l.property_id WHERE l.kind='Ingreso' ORDER BY l.entry_date DESC,l.created_at DESC`,
  documents:`SELECT d.id,d.filename,d.absolute_path,d.imported_at,p.address property,c.code contract_code FROM documents d LEFT JOIN properties p ON p.id=d.property_id LEFT JOIN contracts c ON c.id=d.contract_id ORDER BY d.imported_at DESC`,
  imports:`SELECT id,filename,absolute_path,sha256,status,confidence::float,warnings_json warnings,result_json,error_message,created_at FROM imports ORDER BY created_at DESC LIMIT 100`
};
function validateFee(value){const fee=Number(value);if(fee<2||fee>5)throw new Error('El honorario de administración debe estar entre 2% y 5%.');return fee;}
function addMonths(dateString,count){const [year,month,day]=dateString.split('-').map(Number);return new Date(Date.UTC(year,month-1+count,day)).toISOString().slice(0,10);}
function endDate(start,duration){const d=new Date(`${addMonths(start,duration)}T00:00:00Z`);d.setUTCDate(d.getUTCDate()-1);return d.toISOString().slice(0,10);}
function previousDate(dateString){const d=new Date(`${dateString}T00:00:00Z`);d.setUTCDate(d.getUTCDate()-1);return d.toISOString().slice(0,10);}
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
      await client.query(`INSERT INTO contracts(id,code,property_id,tenant_id,rental_type,duration_months,start_date,end_date,initial_amount,currency,adjustment_frequency_months,adjustment_index,payment_due_day,management_fee_pct,bank_name,cbu,status) VALUES (${Array.from({length:17},(_,i)=>'$'+(i+1)).join(',')})`,[id,input.code,input.property_id,input.tenant_id,input.rental_type,Number(input.duration_months),input.start_date,input.end_date||endDate(input.start_date,Number(input.duration_months)),Number(input.initial_amount),input.currency||'ARS',Number(input.adjustment_frequency_months)||null,input.adjustment_index||null,Number(input.payment_due_day)||10,fee,input.bank_name||null,input.cbu||null,input.status||'Activo']);
      if(input.owner_id){await client.query('INSERT INTO contract_owners(contract_id,person_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',[id,input.owner_id]);await client.query('INSERT INTO property_owners(property_id,person_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',[input.property_id,input.owner_id]);await client.query('UPDATE persons SET is_owner=true,updated_at=now() WHERE id=$1',[input.owner_id]);}
      await client.query('INSERT INTO guarantees(id,contract_id,guarantee_type,provider,provider_detail) VALUES ($1,$2,$3,$4,$5)',[uid(),id,input.guarantee_type||'Sin garantía',input.guarantee_provider||null,input.guarantee_provider_detail||null]);
      for(let index=0;index<Number(input.duration_months);index++){const monthDate=addMonths(input.start_date,index),period=monthDate.slice(0,7),pending=Boolean(Number(input.adjustment_frequency_months)&&index>=Number(input.adjustment_frequency_months));await client.query('INSERT INTO installments(id,contract_id,period,due_date,expected_amount,currency,adjustment_pending) VALUES ($1,$2,$3,$4,$5,$6,$7)',[uid(),id,period,`${period}-${String(Math.min(Number(input.payment_due_day)||10,28)).padStart(2,'0')}`,Number(input.initial_amount),input.currency||'ARS',pending]);}
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }else throw new Error('No se puede crear ese recurso.');
  await db.query('INSERT INTO audit_log(id,entity_type,entity_id,action,details_json) VALUES ($1,$2,$3,$4,$5)',[uid(),resource,id,'created',input]);
  return{id};
}

async function updateRecord(db,resource,id,input){
  if(resource==='contracts'){
    const allowed=['alias','rental_type','duration_months','start_date','end_date','initial_amount','currency','adjustment_frequency_months','adjustment_index','payment_due_day','management_fee_pct','deposit_amount','bank_name','cbu','status','notes'];
    const assignments=[],values=[];
    for(const field of allowed){
      if(input[field]===undefined)continue;
      let value=input[field];
      if(['duration_months','adjustment_frequency_months','payment_due_day'].includes(field))value=value===''?null:Number(value);
      if(['initial_amount','deposit_amount'].includes(field))value=value===''?null:Number(value);
      if(field==='management_fee_pct')value=validateFee(value);
      values.push(value);
      assignments.push(`${field}=$${values.length}`);
    }
    if(!assignments.length)throw new Error('No hay cambios para guardar.');
    values.push(id);
    const result=await db.query(`UPDATE contracts SET ${assignments.join(', ')},updated_at=now() WHERE id=$${values.length} RETURNING id`,values);
    if(!result.rowCount)throw new Error('Contrato no encontrado.');
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
    let where;
    if(booleanInput(input.repeat_remaining)){
      const current=await one(db,'SELECT contract_id,due_date FROM installments WHERE id=$1',[id]);
      if(!current)throw new Error('Cobro pendiente no encontrado.');
      values.push(current.contract_id);
      const contractIndex=values.length;
      values.push(current.due_date);
      const dueIndex=values.length;
      where=`contract_id=$${contractIndex} AND due_date>=$${dueIndex} AND status<>'Pagado'`;
    }else{
      values.push(id);
      where=`id=$${values.length}`;
    }
    const result=await db.query(`UPDATE installments SET ${assignments.join(', ')} WHERE ${where} RETURNING id`,values);
    if(!result.rowCount)throw new Error('Cobro pendiente no encontrado.');
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

async function deleteRecord(db,resource,id){
  if(resource==='guarantors'){
    const result=await db.query('DELETE FROM guarantees WHERE id=$1 RETURNING id',[id]);
    if(!result.rowCount)throw new Error('Garante no encontrado.');
  }else if(resource==='tenants'){
    const active=await one(db,`SELECT COUNT(*)::int total FROM contracts c LEFT JOIN contract_tenants ct ON ct.contract_id=c.id WHERE c.tenant_id=$1 OR ct.person_id=$1`,[id]);
    if(active.total>0)throw new Error('No se puede eliminar un inquilino vinculado a contratos. Editá primero el contrato.');
    await db.query('DELETE FROM contract_tenants WHERE person_id=$1',[id]);
    const result=await db.query('DELETE FROM persons WHERE id=$1 RETURNING id',[id]);
    if(!result.rowCount)throw new Error('Inquilino no encontrado.');
  }else throw new Error('Eliminación no disponible para ese recurso.');
  await db.query('INSERT INTO audit_log(id,entity_type,entity_id,action,details_json) VALUES ($1,$2,$3,$4,$5)',[uid(),resource,id,'deleted',{}]);
  return{id,deleted:true};
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
    await client.query('DELETE FROM documents WHERE id=$1 OR contract_id=$2',[documentId,contractId]).then(res=>{summary.deleted.documents=res.rowCount;});
    await client.query('DELETE FROM contracts WHERE id=$1',[contractId]).then(res=>{summary.deleted.contracts=res.rowCount;});

    for(const propertyId of createdIds(result,'propertyIds')){
      if(await canDeleteProperty(client,propertyId)){
        await client.query('DELETE FROM property_owners WHERE property_id=$1',[propertyId]);
        await client.query('DELETE FROM properties WHERE id=$1',[propertyId]).then(res=>{summary.deleted.properties+=res.rowCount;});
      }else summary.kept.properties.push(propertyId);
    }
    for(const personId of createdIds(result,'personIds')){
      await client.query('DELETE FROM property_owners WHERE person_id=$1',[personId]);
      if(await canDeletePerson(client,personId))await client.query('DELETE FROM persons WHERE id=$1',[personId]).then(res=>{summary.deleted.persons+=res.rowCount;});
      else summary.kept.persons.push(personId);
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

async function voidContract(db,contractId,input={}){
  const reason=cleanNullable(input.reason)||'Anulado manualmente';
  const result=await db.query(`UPDATE contracts SET status='Anulado',voided_at=now(),void_reason=$1,updated_at=now() WHERE id=$2 RETURNING id,status,voided_at,void_reason`,[reason,contractId]);
  if(!result.rowCount)throw new Error('Contrato no encontrado.');
  await db.query('UPDATE installments SET status=$1 WHERE contract_id=$2 AND status<>$3',['Vencido',contractId,'Pagado']);
  await db.query('INSERT INTO audit_log(id,entity_type,entity_id,action,details_json) VALUES ($1,$2,$3,$4,$5)',[uid(),'contract',contractId,'voided',{reason}]);
  return result.rows[0];
}

async function renewContract(db,contractId,input={}){
  const current=await one(db,'SELECT * FROM contracts WHERE id=$1',[contractId]);
  if(!current)throw new Error('Contrato no encontrado.');
  const start=input.start_date;
  if(!start)throw new Error('La fecha de inicio es obligatoria.');
  const duration=Number(input.duration_months||current.duration_months||24);
  const initial=Number(input.initial_amount||current.initial_amount||0);
  const adjustmentFrequency=Number(input.adjustment_frequency_months||current.adjustment_frequency_months||0)||null;
  const adjustmentIndex=input.adjustment_index||current.adjustment_index||null;
  const adjustmentType=input.adjustment_type||current.adjustment_type||adjustmentIndex||null;
  const id=uid(),client=await db.connect();
  try{await client.query('BEGIN');
    const next=Number((await client.query('SELECT COUNT(*) total FROM contracts')).rows[0].total)+1;
    await client.query(`INSERT INTO contracts(id,code,alias,property_id,tenant_id,rental_type,duration_months,start_date,end_date,initial_amount,currency,adjustment_frequency_months,adjustment_index,payment_due_day,payment_period_start_day,payment_period_end_day,management_fee_pct,deposit_amount,bank_name,cbu,status,previous_contract_id,adjustment_type,adjustment_value_pct,ipc_lag_months,vat_applicable,vat_percentage,late_fee_json,payment_terms_json,import_snapshot_json)
      VALUES (${Array.from({length:30},(_,i)=>'$'+(i+1)).join(',')})`,[id,input.code||`CONT-${start.slice(0,4)}-${String(next).padStart(3,'0')}`,input.alias||current.alias,current.property_id,current.tenant_id,current.rental_type,duration,start,endDate(start,duration),initial,current.currency,adjustmentFrequency,adjustmentIndex,Number(input.payment_due_day||current.payment_due_day||10),current.payment_period_start_day,current.payment_period_end_day,current.management_fee_pct,input.deposit_amount!==undefined?Number(input.deposit_amount):current.deposit_amount,current.bank_name,current.cbu,'Activo',contractId,adjustmentType,input.adjustment_value_pct!==undefined?Number(input.adjustment_value_pct):current.adjustment_value_pct,current.ipc_lag_months,current.vat_applicable,current.vat_percentage,JSON.stringify(current.late_fee_json||{}),JSON.stringify(current.payment_terms_json||{}),JSON.stringify({renewed_from:contractId})]);
    const owners=await client.query('SELECT person_id FROM contract_owners WHERE contract_id=$1',[contractId]);
    for(const owner of owners.rows)await client.query('INSERT INTO contract_owners(contract_id,person_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',[id,owner.person_id]);
    const tenants=await client.query('SELECT person_id,snapshot_name,snapshot_document FROM contract_tenants WHERE contract_id=$1',[contractId]);
    for(const tenant of tenants.rows)await client.query('INSERT INTO contract_tenants(contract_id,person_id,snapshot_name,snapshot_document) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',[id,tenant.person_id,tenant.snapshot_name,tenant.snapshot_document]);
    const guarantee=await client.query('SELECT * FROM guarantees WHERE contract_id=$1 LIMIT 1',[contractId]);
    if(guarantee.rows[0]){
      const g=guarantee.rows[0];
      await client.query('INSERT INTO guarantees(id,contract_id,guarantee_type,provider,provider_detail,guarantor_name,guarantor_document,guaranteed_property,policy_number,expiry_date,notes,guarantor_email,guarantor_phone,guarantor_address) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',[uid(),id,g.guarantee_type,g.provider,g.provider_detail,g.guarantor_name,g.guarantor_document,g.guaranteed_property,g.policy_number,g.expiry_date,g.notes,g.guarantor_email,g.guarantor_phone,g.guarantor_address]);
    }
    for(let index=0;index<duration;index++){const monthDate=addMonths(start,index),period=monthDate.slice(0,7),pending=Boolean(adjustmentFrequency&&index>=adjustmentFrequency);await client.query('INSERT INTO installments(id,contract_id,period,due_date,expected_amount,currency,adjustment_pending) VALUES ($1,$2,$3,$4,$5,$6,$7)',[uid(),id,period,`${period}-${String(Math.min(Number(input.payment_due_day||current.payment_due_day||10),28)).padStart(2,'0')}`,initial,current.currency,pending]);}
    if(booleanInput(input.deactivate_previous))await client.query('UPDATE contracts SET status=$1,end_date=$2,updated_at=now() WHERE id=$3',['Renovado',previousDate(start),contractId]);
    await client.query('INSERT INTO audit_log(id,entity_type,entity_id,action,details_json) VALUES ($1,$2,$3,$4,$5)',[uid(),'contract',id,'renewed',{from:contractId,input}]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  return{id,previous_contract_id:contractId,status:'Activo'};
}

async function rescindContract(db,contractId,input={}){
  const date=input.rescission_date||new Date().toISOString().slice(0,10),penalty=Number(input.penalty_amount||0);
  const contract=await one(db,'SELECT * FROM contracts WHERE id=$1',[contractId]);
  if(!contract)throw new Error('Contrato no encontrado.');
  const client=await db.connect();
  try{await client.query('BEGIN');
    await client.query(`UPDATE contracts SET status='Rescindido',end_date=$1,rescinded_at=$1,rescission_penalty=$2,deposit_returned_at=CASE WHEN $3 THEN $1 ELSE deposit_returned_at END,deposit_returned_amount=CASE WHEN $3 THEN COALESCE(deposit_amount,0) ELSE deposit_returned_amount END,updated_at=now() WHERE id=$4`,[date,penalty,booleanInput(input.return_deposit),contractId]);
    await client.query("UPDATE installments SET status='Vencido' WHERE contract_id=$1 AND due_date>$2 AND status<>'Pagado'",[contractId,date]);
    if(penalty>0)await client.query('INSERT INTO ledger_entries(id,entry_date,kind,category,description,amount,currency,property_id,contract_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[uid(),date,'Ingreso','Rescisión',`Multa por rescisión ${contract.code}`,penalty,contract.currency,contract.property_id,contractId]);
    if(booleanInput(input.return_deposit)&&Number(contract.deposit_amount||0)>0)await client.query('INSERT INTO ledger_entries(id,entry_date,kind,category,description,amount,currency,property_id,contract_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[uid(),date,'Gasto','Depósito',`Devolución de depósito ${contract.code}`,Number(contract.deposit_amount),contract.currency,contract.property_id,contractId]);
    await client.query('INSERT INTO audit_log(id,entity_type,entity_id,action,details_json) VALUES ($1,$2,$3,$4,$5)',[uid(),'contract',contractId,'rescinded',input]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  return{id:contractId,status:'Rescindido'};
}

async function deactivateContract(db,contractId,input={}){
  const result=await db.query("UPDATE contracts SET status='Archivado',deactivated_at=now(),updated_at=now(),notes=COALESCE(notes,'') || CASE WHEN $1<>'' THEN E'\\nDesactivado: ' || $1 ELSE '' END WHERE id=$2 RETURNING id,status",[cleanNullable(input.reason)||'',contractId]);
  if(!result.rowCount)throw new Error('Contrato no encontrado.');
  await db.query("UPDATE installments SET status='Vencido' WHERE contract_id=$1 AND status<>'Pagado'",[contractId]);
  await db.query('INSERT INTO audit_log(id,entity_type,entity_id,action,details_json) VALUES ($1,$2,$3,$4,$5)',[uid(),'contract',contractId,'deactivated',input]);
  return result.rows[0];
}

async function returnDeposit(db,contractId,input={}){
  const contract=await one(db,'SELECT * FROM contracts WHERE id=$1',[contractId]);
  if(!contract)throw new Error('Contrato no encontrado.');
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
  const existing=await one(db,'SELECT id FROM documents WHERE sha256=$1',[stored.sha256]);
  if(existing){
    await db.query('UPDATE documents SET contract_id=$1,property_id=$2 WHERE id=$3',[contractId,contract.property_id,existing.id]);
    return{id:existing.id,storedPath:stored.path,attached:true,alreadyStored:true};
  }
  const id=uid();
  await db.query('INSERT INTO documents(id,filename,absolute_path,sha256,property_id,contract_id) VALUES ($1,$2,$3,$4,$5,$6)',[id,path.basename(stored.path),stored.path,stored.sha256,contract.property_id,contractId]);
  await db.query('INSERT INTO audit_log(id,entity_type,entity_id,action,details_json) VALUES ($1,$2,$3,$4,$5)',[uid(),'contract',contractId,'file_attached',{documentId:id,storedPath:stored.path}]);
  return{id,storedPath:stored.path,attached:true,alreadyStored:stored.alreadyStored};
}

async function deleteContract(db,contractId,input={}){
  const contract=await one(db,'SELECT id FROM contracts WHERE id=$1',[contractId]);
  if(!contract)throw new Error('Contrato no encontrado.');
  const client=await db.connect(),summary={payments:0,installments:0,documents:0,ledger:0,incidents:0,contracts:0};
  try{await client.query('BEGIN');
    await client.query(`DELETE FROM payments WHERE installment_id IN (SELECT id FROM installments WHERE contract_id=$1)`,[contractId]).then(res=>{summary.payments=res.rowCount;});
    await client.query('DELETE FROM installments WHERE contract_id=$1',[contractId]).then(res=>{summary.installments=res.rowCount;});
    await client.query('DELETE FROM initial_payments WHERE contract_id=$1',[contractId]);
    await client.query('DELETE FROM recurring_charges WHERE contract_id=$1',[contractId]);
    await client.query('DELETE FROM guarantees WHERE contract_id=$1',[contractId]);
    await client.query('DELETE FROM contract_tenants WHERE contract_id=$1',[contractId]);
    await client.query('DELETE FROM contract_owners WHERE contract_id=$1',[contractId]);
    await client.query('DELETE FROM ledger_entries WHERE contract_id=$1',[contractId]).then(res=>{summary.ledger=res.rowCount;});
    await client.query('DELETE FROM incidents WHERE contract_id=$1',[contractId]).then(res=>{summary.incidents=res.rowCount;});
    await client.query('DELETE FROM documents WHERE contract_id=$1',[contractId]).then(res=>{summary.documents=res.rowCount;});
    await client.query('UPDATE contracts SET previous_contract_id=NULL WHERE previous_contract_id=$1',[contractId]);
    await client.query('UPDATE imports SET status=$1,result_json=result_json || $2::jsonb WHERE result_json->\'completion_result\'->>\'contractId\'=$3',['Revertido',JSON.stringify({deleted_contract_at:new Date().toISOString(),delete_reason:input.reason||'Eliminado manualmente'}),contractId]);
    await client.query('DELETE FROM contracts WHERE id=$1',[contractId]).then(res=>{summary.contracts=res.rowCount;});
    await client.query('INSERT INTO audit_log(id,entity_type,entity_id,action,details_json) VALUES ($1,$2,$3,$4,$5)',[uid(),'contract',contractId,'deleted',{...summary,reason:input.reason||null}]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  return{id:contractId,deleted:true,summary};
}

async function registerPayment(db,installmentId,input={}){
  const installment=await one(db,'SELECT * FROM installments WHERE id=$1',[installmentId]);
  if(!installment)throw new Error('Cuota no encontrada.');
  const amount=Number(input.amount);
  if(!amount||amount<=0)throw new Error('El importe del cobro debe ser mayor a cero.');
  const contract=await one(db,'SELECT adjustment_index,adjustment_frequency_months,initial_amount::float,start_date FROM contracts WHERE id=$1',[installment.contract_id]);
  const settings=await allSettings(db);
  await db.query('INSERT INTO payments(id,installment_id,amount,paid_at,method,bank_name,reference,notes,payment_type,account_name,tax_status,is_split) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[uid(),installmentId,amount,input.paid_at||new Date().toISOString().slice(0,10),input.method||'Transferencia',input.bank_name||settings.bank_name,input.reference||null,input.notes||null,input.payment_type||'Alquiler',input.account_name||null,input.tax_status||'Declarado',booleanInput(input.is_split)]);
  const paid=Number((await one(db,'SELECT COALESCE(SUM(amount),0) total FROM payments WHERE installment_id=$1',[installmentId])).total)+Number(installment.manual_partial_amount||0),expectedAdjustment=await adjustedAmountByIpc({...contract},installment.period).catch(()=>({amount:Number(installment.expected_amount)})),expected=contract.adjustment_index==='IPC'?Number(expectedAdjustment.amount):Number(installment.expected_amount),total=expected+Number(installment.vat_amount||0)+Number(installment.late_fee_amount||0)-Number(installment.discount_amount||0),status=total&&paid>=total?'Pagado':'Parcial';
  await db.query('UPDATE installments SET status=$1,expected_amount=$2,adjustment_pending=false WHERE id=$3',[status,expected,installmentId]);
  const owners=await rows(db,`SELECT co.person_id owner_id,p.address property FROM contract_owners co JOIN contracts c ON c.id=co.contract_id JOIN properties p ON p.id=c.property_id WHERE co.contract_id=$1`,[installment.contract_id]);
  for(const owner of owners){
    await triggerAutomation(db,'PAYMENT_REGISTERED',{ownerId:owner.owner_id,relatedEntityType:'installment',relatedEntityId:installmentId,parameters:[owner.property||'tu propiedad',installment.period],idempotencyKey:`PAYMENT_REGISTERED:${owner.owner_id}:${installmentId}:${status}`}).catch(error=>console.error('WhatsApp automation:',error.message));
  }
  return{id:installmentId,paid,status};
}

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
  if(resource==='ipc'&&id==='latest'&&req.method==='GET')return json(res,200,await latestIpcSummary());
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
        const result=await importPdf(db,stored.path);
        return json(res,201,{...result,storedPath:stored.path,alreadyStored:stored.alreadyStored});
      }catch(error){
        console.error('Upload error:',error.message);
        return json(res,500,{error:error.message});
      }
    }
  }
  if(resource==='payments'&&id&&action==='register'&&req.method==='POST'){
    try{return json(res,201,await registerPayment(db,id,await readBody(req)));}catch(error){return json(res,400,{error:error.message});}
  }
  if(resource==='payments'&&id==='register'&&req.method==='POST'){
    const input=await readBody(req),amount=Number(input.amount);
    if(!input.contract_id||!amount)return json(res,400,{error:'Contrato e importe son obligatorios.'});
    let remaining=amount,last=null;
    const pendingRaw=await rows(db,`SELECT i.*,i.expected_amount::float,i.vat_amount::float,i.late_fee_amount::float,i.discount_amount::float,i.declared_amount::float,i.manual_partial_amount::float,i.discount_percentage::float,(COALESCE((SELECT SUM(pay.amount) FROM payments pay WHERE pay.installment_id=i.id),0)+i.manual_partial_amount)::float paid_amount,p.address property,pe.full_name tenant,c.id contract_id,c.code contract_code,c.alias contract_alias,c.adjustment_index,c.adjustment_frequency_months,c.initial_amount::float,c.start_date,c.payment_due_day,c.late_fee_json FROM installments i JOIN contracts c ON c.id=i.contract_id JOIN properties p ON p.id=c.property_id JOIN persons pe ON pe.id=c.tenant_id WHERE i.status<>'Pagado' AND c.id=$1 AND c.status IN ('Activo','Revisión') ORDER BY i.due_date`,[input.contract_id]);
    const pending=await enrichInstallmentsWithIpc(db,pendingRaw);
    for(const item of pending.map(withCollectionTotals)){
      if(remaining<=0)break;
      const payAmount=Math.min(remaining,Number(item.due_amount||0));
      if(payAmount<=0)continue;
      const result=await registerPayment(db,item.id,{...input,amount:payAmount,is_split:true});
      last=result;
      remaining-=payAmount;
    }
    return json(res,201,{distributed:amount-remaining,remaining,last});
  }
  if(resource==='pending-collections'&&req.method==='GET')return json(res,200,(await enrichInstallmentsWithIpc(db,await rows(db,queries[resource]))).map(withCollectionTotals));
  if(queries[resource]&&req.method==='GET')return json(res,200,await rows(db,queries[resource]));
  if(resource==='contracts'&&id&&action==='void'&&req.method==='POST'){
    try{return json(res,200,await voidContract(db,id,await readBody(req)));}catch(error){return json(res,400,{error:error.message});}
  }
  if(resource==='contracts'&&id&&action==='renew'&&req.method==='POST'){
    try{return json(res,201,await renewContract(db,id,await readBody(req)));}catch(error){return json(res,400,{error:error.message});}
  }
  if(resource==='contracts'&&id&&action==='rescind'&&req.method==='POST'){
    try{return json(res,200,await rescindContract(db,id,await readBody(req)));}catch(error){return json(res,400,{error:error.message});}
  }
  if(resource==='contracts'&&id&&action==='deactivate'&&req.method==='POST'){
    try{return json(res,200,await deactivateContract(db,id,await readBody(req)));}catch(error){return json(res,400,{error:error.message});}
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
    try{return json(res,200,await deleteContract(db,id,await readBody(req)));}catch(error){return json(res,400,{error:error.message});}
  }
  if(['tenants','guarantors'].includes(resource)&&id&&req.method==='DELETE'){
    try{return json(res,200,await deleteRecord(db,resource,id));}catch(error){return json(res,400,{error:error.message});}
  }
  return json(res,404,{error:'Ruta inexistente.'});
}

function staticFile(res,pathname){const relative=pathname==='/'?'index.html':pathname.slice(1),file=path.resolve(PUBLIC_DIR,relative);if(!file.startsWith(path.resolve(PUBLIC_DIR))||!fs.existsSync(file)||fs.statSync(file).isDirectory())return staticFile(res,'/index.html');const type={'.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.png':'image/png'}[path.extname(file)]||'application/octet-stream';res.writeHead(200,{'Content-Type':`${type}; charset=utf-8`});fs.createReadStream(file).pipe(res);}

async function createApp(options={}){
  const db=options.db||await openDatabase(options.databaseUrl);
  const server=http.createServer(async(req,res)=>{try{const pathname=new URL(req.url,`http://${req.headers.host||'localhost'}`).pathname;if(pathname.startsWith('/api/'))return await handleApi(db,req,res,pathname);return staticFile(res,pathname);}catch(error){return json(res,400,{error:error.message||'Error inesperado.'});}});
  let scanning=false;const scan=async()=>{if(scanning)return;scanning=true;try{await scanImportDirectory(db);}catch(error){console.error('Importación:',error.message);}finally{scanning=false;}};
  const startScanner=async()=>{await scan();const settings=await allSettings(db),timer=setInterval(scan,Math.max(10,Number(settings.scan_interval_seconds||30))*1000);timer.unref();return timer;};
  const startWhatsAppGatewayWorker=async()=>createWhatsAppGatewayWorker(db).start();
  return{server,db,startScanner,startWhatsAppGatewayWorker};
}
module.exports={createApp};

