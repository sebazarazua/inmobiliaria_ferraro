const crypto=require('node:crypto');
const config=require('../../config');
const {uid}=require('../../database');

const BUSINESS_NAME='Eugenio A. Ferraro Propiedades';
const DIGITS=/\D+/g;

function stripAccents(value=''){return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'');}
function normalizeText(value=''){return stripAccents(value).toLowerCase().replace(/\s+/g,' ').trim();}
function onlyDigits(value=''){return String(value||'').replace(DIGITS,'');}
function maskDocument(value=''){const digits=onlyDigits(value);return digits.length<=4?'****':`${'*'.repeat(Math.max(0,digits.length-4))}${digits.slice(-4)}`;}
function normalizePhone(value=''){
  let digits=onlyDigits(value);
  if(!digits)return '';
  if(digits.startsWith('00'))digits=digits.slice(2);
  if(digits.startsWith('549'))return `+${digits}`;
  if(digits.startsWith('54'))return `+${digits}`;
  if(digits.startsWith('9')&&digits.length>=11)return `+54${digits}`;
  if(digits.length===10)return `+54${digits}`;
  if(digits.length===8&&digits.startsWith('4'))return `+5411${digits}`;
  return `+${digits}`;
}
function phoneVariants(phone=''){
  const normalized=normalizePhone(phone),digits=onlyDigits(normalized),variants=new Set([normalized,`+${digits}`,digits]);
  if(digits.startsWith('549'))variants.add(`+54${digits.slice(3)}`);
  if(digits.startsWith('54')&&!digits.startsWith('549'))variants.add(`+549${digits.slice(2)}`);
  if(digits.length>=10)variants.add(digits.slice(-10));
  if(digits.length>=8)variants.add(digits.slice(-8));
  return variants;
}
function documentsMatch(input,person){
  const value=onlyDigits(input);
  if(!value)return false;
  return [person.document_number,person.tax_id].some(item=>onlyDigits(item)===value);
}
function isUuid(value=''){return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value));}
function addMinutes(minutes){return new Date(Date.now()+minutes*60_000).toISOString();}
function addHours(hours){return new Date(Date.now()+hours*60*60_000).toISOString();}
function sha256(value){return crypto.createHash('sha256').update(value).digest('hex');}
function safeMetadata(payload){return JSON.parse(JSON.stringify(payload||{},(key,value)=>['access_token','token','document_number','tax_id'].includes(key)?undefined:value));}

class WhatsAppProvider{
  constructor(options=config.whatsapp){this.options=options;}
  isConfigured(){return Boolean(this.options.accessToken&&this.options.phoneNumberId);}
  async send(payload){
    if(!this.isConfigured()){
      const error=new Error('WhatsApp Cloud API no está configurada. Faltan WHATSAPP_ACCESS_TOKEN o WHATSAPP_PHONE_NUMBER_ID.');
      error.code='WHATSAPP_NOT_CONFIGURED';
      throw error;
    }
    const url=`https://graph.facebook.com/${this.options.graphVersion}/${this.options.phoneNumberId}/messages`;
    const started=Date.now();
    const response=await fetch(url,{method:'POST',headers:{'Authorization':`Bearer ${this.options.accessToken}`,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',...payload})});
    const body=await response.json().catch(()=>({}));
    if(!response.ok){
      const error=new Error(body?.error?.message||`Meta WhatsApp respondió ${response.status}`);
      error.status=response.status;
      error.meta=body?.error||body;
      error.latency_ms=Date.now()-started;
      throw error;
    }
    return{...body,latency_ms:Date.now()-started};
  }
  sendText(to,body){return this.send({to:onlyDigits(to),type:'text',text:{preview_url:true,body}});}
  sendTemplate(to,name,language='es_AR',parameters=[]){
    const components=parameters.length?[{type:'body',parameters:parameters.map(text=>({type:'text',text:String(text)}))}]:undefined;
    return this.send({to:onlyDigits(to),type:'template',template:{name,language:{code:language},components}});
  }
  sendDocument(to,link,filename,caption=''){
    return this.send({to:onlyDigits(to),type:'document',document:{link,filename,caption}});
  }
  sendInteractive(to,body,buttons=[]){
    return this.send({to:onlyDigits(to),type:'interactive',interactive:{type:'button',body:{text:body},action:{buttons:buttons.slice(0,3).map(button=>({type:'reply',reply:{id:button.id,title:button.title.slice(0,20)}}))}}});
  }
}

async function recordMessage(db,{conversationId=null,direction,whatsappMessageId=null,phone=null,type='text',body=null,status=null,templateName=null,relatedEntityType=null,relatedEntityId=null,automated=true,error=null,metadata={}}){
  const id=uid();
  await db.query(`INSERT INTO whatsapp_messages(id,conversation_id,direction,whatsapp_message_id,phone_e164,message_type,body,status,template_name,related_entity_type,related_entity_id,automated,error,metadata_json)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT(whatsapp_message_id) DO NOTHING`,[id,conversationId,direction,whatsappMessageId,phone?normalizePhone(phone):null,type,body,status,templateName,relatedEntityType,isUuid(relatedEntityId)?relatedEntityId:null,automated,error,JSON.stringify(safeMetadata(metadata))]);
  return id;
}

async function findOwnerByPhone(db,phone){
  const normalized=normalizePhone(phone),variants=phoneVariants(normalized);
  const owners=(await db.query(`SELECT id,full_name,document_number,tax_id,whatsapp,whatsapp_normalized,whatsapp_opt_in,whatsapp_preferences_json,whatsapp_session_revoked_at
    FROM persons WHERE is_owner=true OR id IN (SELECT person_id FROM property_owners)`)).rows;
  for(const owner of owners){
    const candidate=owner.whatsapp_normalized||normalizePhone(owner.whatsapp);
    const candidateVariants=phoneVariants(candidate);
    if([...variants].some(item=>candidateVariants.has(item)))return{...owner,whatsapp_normalized:candidate||normalized};
  }
  return null;
}

async function getOrCreateConversation(db,phone,owner=null){
  const normalized=normalizePhone(phone);
  let conversation=(await db.query("SELECT * FROM whatsapp_conversations WHERE phone_e164=$1 AND status<>'CLOSED' ORDER BY created_at DESC LIMIT 1",[normalized])).rows[0];
  if(conversation)return conversation;
  if(owner?.id){
    const byOwner=(await db.query("SELECT * FROM whatsapp_conversations WHERE owner_id=$1 AND status<>'CLOSED' ORDER BY updated_at DESC LIMIT 5",[owner.id])).rows;
    const variants=phoneVariants(normalized);
    conversation=byOwner.find(item=>[...phoneVariants(item.phone_e164)].some(value=>variants.has(value)))||byOwner[0];
    if(conversation){
      if(conversation.phone_e164!==normalized)await db.query('UPDATE whatsapp_conversations SET phone_e164=$1,updated_at=now() WHERE id=$2',[normalized,conversation.id]);
      return{...conversation,phone_e164:normalized};
    }
  }
  const id=uid();
  await db.query('INSERT INTO whatsapp_conversations(id,owner_id,phone_e164,status,last_message_at) VALUES ($1,$2,$3,$4,now())',[id,owner?.id||null,normalized,owner?'PENDING_AUTH':'BLOCKED']);
  return (await db.query('SELECT * FROM whatsapp_conversations WHERE id=$1',[id])).rows[0];
}

async function updateConversation(db,id,fields){
  const entries=Object.entries(fields).filter(([,value])=>value!==undefined);
  if(!entries.length)return;
  const assignments=entries.map(([key],index)=>`${key}=$${index+1}`);
  await db.query(`UPDATE whatsapp_conversations SET ${assignments.join(', ')},updated_at=now() WHERE id=$${entries.length+1}`,[...entries.map(([,value])=>value),id]);
}

function resolveIntent(text='',messageType='text'){
  const value=normalizeText(text);
  if(['baja','stop','cancelar notificaciones','no quiero recibir','no quiero recibir notificaciones'].some(item=>value.includes(item)))return'OPT_OUT';
  if(['alta','reactivar','activar notificaciones'].some(item=>value.includes(item)))return'OPT_IN';
  if(['asesor','humano','persona','hablar con la inmobiliaria'].some(item=>value.includes(item)))return'HUMAN_HANDOFF';
  if(['menu','menú','ayuda','hola','buen dia','buenas','inicio'].some(item=>value===normalizeText(item)||value.startsWith(`${normalizeText(item)} `)))return'MENU';
  if(value.includes('liquidacion')||value.includes('liquidación'))return'LATEST_LIQUIDATION';
  if(value.includes('pago')||value.includes('pagos')||value.includes('cobro')||value.includes('cobraron'))return'PAYMENT_STATUS';
  if(value.includes('propiedad')||value.includes('inmueble'))return'PROPERTIES';
  if(value.includes('portal')||value.includes('link'))return'OWNER_PORTAL';
  if(value.includes('documento')||value.includes('comprobante')||value.includes('pdf'))return'DOCUMENTS';
  if(messageType==='interactive')return value.toUpperCase();
  return'UNKNOWN';
}

function menuText(){
  return [
    'Menú principal:',
    '1. Última liquidación',
    '2. Estado de pagos',
    '3. Mis propiedades',
    '4. Portal del propietario',
    '5. Documentos',
    '6. Hablar con la inmobiliaria',
    '',
    'También podés escribir: liquidación, pagos, propiedades, portal, documentos o asesor.'
  ].join('\n');
}

async function sendAndStore(db,conversation,provider,body,{automated=true,type='text',templateName=null,relatedEntityType=null,relatedEntityId=null}={}){
  let status='failed',metaId=null,error=null,metadata={};
  try{
    const result=await provider.sendText(conversation.phone_e164,body);
    metaId=result.messages?.[0]?.id||null;
    status='sent';
    metadata={meta:result};
  }catch(err){
    error=err.message;
    metadata={code:err.code||null,status:err.status||null};
  }
  await recordMessage(db,{conversationId:conversation.id,direction:'OUTBOUND',whatsappMessageId:metaId,phone:conversation.phone_e164,type,body,status,templateName,relatedEntityType,relatedEntityId,automated,error,metadata});
  return{status,metaId,error};
}

async function generatePortalToken(db,ownerId){
  const raw=crypto.randomBytes(32).toString('base64url'),hash=sha256(raw),id=uid();
  await db.query('INSERT INTO owner_portal_tokens(id,owner_id,token_hash,expires_at) VALUES ($1,$2,$3,$4)',[id,ownerId,hash,addMinutes(config.whatsapp.portalTokenTtlMinutes)]);
  return raw;
}

async function latestLiquidationText(db,owner){
  const payment=(await db.query(`SELECT pay.amount::float,pay.paid_at,pay.tax_status,i.period,i.currency,i.vat_amount::float,i.late_fee_amount::float,i.discount_amount::float,c.management_fee_pct::float,c.code,p.address property
    FROM payments pay
    JOIN installments i ON i.id=pay.installment_id
    JOIN contracts c ON c.id=i.contract_id
    JOIN properties p ON p.id=c.property_id
    JOIN contract_owners co ON co.contract_id=c.id
    WHERE co.person_id=$1
    ORDER BY pay.paid_at DESC,pay.created_at DESC LIMIT 1`,[owner.id])).rows[0];
  if(!payment)return 'Todavía no encuentro una liquidación o cobro registrado para tus propiedades.';
  const fee=Math.round(Number(payment.amount||0)*Number(payment.management_fee_pct||0)/100);
  const total=Math.max(0,Math.round(Number(payment.amount||0)-fee-Number(payment.discount_amount||0)));
  return [`Última información registrada para propietario:`,
    `Período: ${payment.period}`,
    `Propiedad: ${payment.property}`,
    `Alquiler cobrado: $ ${Math.round(payment.amount).toLocaleString('es-AR')}`,
    `Deducciones registradas: $ ${fee.toLocaleString('es-AR')}`,
    `Total estimado a liquidar según registros: $ ${total.toLocaleString('es-AR')}`,
    `Estado: ${payment.tax_status||'Registrado'}`,
    `Fecha: ${new Date(payment.paid_at).toLocaleDateString('es-AR')}`,
    '',
    'Si necesitás el PDF oficial y no aparece en Documentos, escribí “asesor”.'].join('\n');
}

async function paymentStatusText(db,owner){
  const rows=(await db.query(`SELECT i.period,i.due_date,i.status,i.expected_amount::float,i.currency,p.address property,COALESCE(SUM(pay.amount),0)::float paid
    FROM installments i
    JOIN contracts c ON c.id=i.contract_id
    JOIN properties p ON p.id=c.property_id
    JOIN contract_owners co ON co.contract_id=c.id
    LEFT JOIN payments pay ON pay.installment_id=i.id
    WHERE co.person_id=$1 AND c.status IN ('Activo','Revisión')
    GROUP BY i.id,p.address
    ORDER BY i.due_date DESC LIMIT 5`,[owner.id])).rows;
  if(!rows.length)return 'No encuentro pagos o cuotas vinculadas a tus propiedades.';
  return ['Estado de pagos registrado:',...rows.map(row=>{
    const pending=Math.max(0,Number(row.expected_amount||0)-Number(row.paid||0));
    return `• ${row.property} / ${row.period}: ${row.status}. Cobrado $ ${Math.round(Number(row.paid||0)).toLocaleString('es-AR')} · Pendiente $ ${Math.round(pending).toLocaleString('es-AR')}`;
  })].join('\n');
}

async function propertiesText(db,owner){
  const rows=(await db.query(`SELECT p.address,p.property_type,p.status,COUNT(c.id)::int active_contracts
    FROM properties p
    JOIN property_owners po ON po.property_id=p.id
    LEFT JOIN contracts c ON c.property_id=p.id AND c.status IN ('Activo','Revisión')
    WHERE po.person_id=$1
    GROUP BY p.id ORDER BY p.address`,[owner.id])).rows;
  if(!rows.length)return 'No encuentro propiedades vinculadas a tu ficha.';
  return ['Tus propiedades vinculadas:',...rows.map(row=>`• ${row.address} · ${row.property_type} · ${Number(row.active_contracts)>0?'Con contrato activo':'Sin contrato activo'}`)].join('\n');
}

async function documentsText(db,owner){
  const rows=(await db.query(`SELECT d.id,d.filename,d.imported_at,p.address property
    FROM documents d
    JOIN properties p ON p.id=d.property_id
    JOIN property_owners po ON po.property_id=p.id
    WHERE po.person_id=$1 AND d.owner_visible=true
    ORDER BY d.imported_at DESC LIMIT 10`,[owner.id])).rows;
  if(!rows.length)return 'No hay documentos habilitados para consultar por WhatsApp en este momento.';
  return ['Documentos disponibles:',...rows.map(row=>`• ${row.filename} · ${row.property||'Propiedad'} · ${new Date(row.imported_at).toLocaleDateString('es-AR')}`),'Por seguridad, los enlaces se generan desde el portal del propietario. Escribí “portal” para ingresar.'].join('\n');
}

async function handleVerifiedIntent(db,conversation,owner,intent,provider){
  if(intent==='OPT_OUT'){
    await db.query('UPDATE persons SET whatsapp_opt_in=false,updated_at=now() WHERE id=$1',[owner.id]);
    await updateConversation(db,conversation.id,{opted_out_at:new Date().toISOString()});
    return sendAndStore(db,conversation,provider,'Listo. Dejamos de enviarte notificaciones automáticas por WhatsApp. Podés escribir “alta” para reactivarlas.');
  }
  if(intent==='OPT_IN'){
    await db.query('UPDATE persons SET whatsapp_opt_in=true,updated_at=now() WHERE id=$1',[owner.id]);
    return sendAndStore(db,conversation,provider,'Listo. Reactivamos tus notificaciones por WhatsApp.');
  }
  if(intent==='HUMAN_HANDOFF'){
    await updateConversation(db,conversation.id,{status:'HUMAN_HANDOFF',handoff_reason:'Solicitado por propietario'});
    return sendAndStore(db,conversation,provider,'Te derivamos con la inmobiliaria. Un administrador continuará la conversación.');
  }
  if(intent==='LATEST_LIQUIDATION'||intent==='1')return sendAndStore(db,conversation,provider,await latestLiquidationText(db,owner),{relatedEntityType:'owner',relatedEntityId:owner.id});
  if(intent==='PAYMENT_STATUS'||intent==='2')return sendAndStore(db,conversation,provider,await paymentStatusText(db,owner),{relatedEntityType:'owner',relatedEntityId:owner.id});
  if(intent==='PROPERTIES'||intent==='3')return sendAndStore(db,conversation,provider,await propertiesText(db,owner),{relatedEntityType:'owner',relatedEntityId:owner.id});
  if(intent==='OWNER_PORTAL'||intent==='4'){
    const token=await generatePortalToken(db,owner.id);
    return sendAndStore(db,conversation,provider,`🌐 Ingresar al portal:\n${config.publicBaseUrl}/#owner-portal?token=${encodeURIComponent(token)}\n\nEl enlace vence en ${config.whatsapp.portalTokenTtlMinutes} minutos.`,{relatedEntityType:'owner',relatedEntityId:owner.id});
  }
  if(intent==='DOCUMENTS'||intent==='5')return sendAndStore(db,conversation,provider,await documentsText(db,owner),{relatedEntityType:'owner',relatedEntityId:owner.id});
  return sendAndStore(db,conversation,provider,menuText());
}

async function processInboundMessage(db,message,provider=new WhatsAppProvider()){
  const messageId=message.id;
  if(messageId){
    const duplicate=(await db.query('SELECT id FROM whatsapp_messages WHERE whatsapp_message_id=$1',[messageId])).rows[0];
    if(duplicate)return{duplicate:true};
  }
  const phone=normalizePhone(message.from),text=message.text||'',messageType=message.type||'text',owner=await findOwnerByPhone(db,phone),conversation=await getOrCreateConversation(db,phone,owner);
  await recordMessage(db,{conversationId:conversation.id,direction:'INBOUND',whatsappMessageId:messageId,phone,type:messageType,body:text,status:'received',metadata:{profile_name:message.profile_name||null}});
  await updateConversation(db,conversation.id,{last_message_at:new Date().toISOString(),owner_id:owner?.id||conversation.owner_id||null});
  const recentCount=Number((await db.query("SELECT COUNT(*) total FROM whatsapp_messages WHERE phone_e164=$1 AND direction='INBOUND' AND created_at>now()-interval '5 minutes'",[phone])).rows[0].total);
  if(recentCount>25)return{rate_limited:true};
  if(!owner)return sendAndStore(db,conversation,provider,`Hola, soy el asistente virtual de ${BUSINESS_NAME}. Este número no está asociado a ningún propietario. Para actualizar tus datos, comunicate con la inmobiliaria.`);
  if(owner.whatsapp_normalized!==normalizePhone(owner.whatsapp))await db.query('UPDATE persons SET whatsapp_normalized=$1 WHERE id=$2',[normalizePhone(owner.whatsapp),owner.id]);
  const current=(await db.query('SELECT * FROM whatsapp_conversations WHERE id=$1',[conversation.id])).rows[0];
  if(current.status==='HUMAN_HANDOFF'){
    const intent=resolveIntent(text,messageType);
    if(intent==='MENU')return sendAndStore(db,current,provider,'La conversación está tomada por un administrador. Si querés volver al bot, esperá a que el administrador la cierre.');
    return{handoff:true};
  }
  const revoked=owner.whatsapp_session_revoked_at&&current.session_verified_at&&new Date(owner.whatsapp_session_revoked_at)>new Date(current.session_verified_at);
  const verified=current.status==='VERIFIED'&&current.session_expires_at&&new Date(current.session_expires_at)>new Date()&&!revoked;
  if(!verified){
    const looksLikeDocument=onlyDigits(text).length>=7;
    if(!looksLikeDocument){
      return sendAndStore(db,current,provider,`Hola, soy el asistente virtual de ${BUSINESS_NAME}.\nPara proteger tu información, respondé con tu DNI o CUIT para validar identidad.`);
    }
    if(documentsMatch(text,owner)){
      await updateConversation(db,current.id,{status:'VERIFIED',failed_auth_attempts:0,session_verified_at:new Date().toISOString(),session_expires_at:addHours(config.whatsapp.sessionTtlHours)});
      const verifiedConversation={...current,status:'VERIFIED'};
      return sendAndStore(db,verifiedConversation,provider,`Identidad validada correctamente.\n\n${menuText()}`);
    }
    const attempts=Number(current.failed_auth_attempts||0)+1;
    await updateConversation(db,current.id,{failed_auth_attempts:attempts,status:attempts>=config.whatsapp.maxAuthAttempts?'BLOCKED':'PENDING_AUTH'});
    if(attempts>=config.whatsapp.maxAuthAttempts)return sendAndStore(db,current,provider,'No pudimos validar la identidad. Por seguridad, la sesión quedó bloqueada. Comunicate con la inmobiliaria.');
    return sendAndStore(db,current,provider,`No pudimos validar esos datos. Revisá el número ingresado e intentá nuevamente. Intentos disponibles: ${config.whatsapp.maxAuthAttempts-attempts}.`);
  }
  return handleVerifiedIntent(db,current,owner,resolveIntent(text,messageType),provider);
}

function extractMessages(payload){
  const items=[];
  for(const entry of payload.entry||[])for(const change of entry.changes||[]){
    const value=change.value||{};
    for(const message of value.messages||[]){
      const type=message.type||'text';
      let text=message.text?.body||message.button?.text||message.interactive?.button_reply?.title||message.interactive?.list_reply?.title||'';
      const idText=message.interactive?.button_reply?.id||message.interactive?.list_reply?.id;
      if(idText)text=idText;
      items.push({id:message.id,from:message.from,type:type==='interactive'?'interactive':type,text,profile_name:value.contacts?.find(contact=>contact.wa_id===message.from)?.profile?.name});
    }
  }
  return items;
}

function extractStatuses(payload){
  const items=[];
  for(const entry of payload.entry||[])for(const change of entry.changes||[]){
    for(const status of change.value?.statuses||[])items.push(status);
  }
  return items;
}

function verifySignature(rawBody,header,secret=config.whatsapp.appSecret){
  if(!secret)return false;
  const expected=`sha256=${crypto.createHmac('sha256',secret).update(rawBody).digest('hex')}`;
  const left=Buffer.from(expected),right=Buffer.from(header||'');
  return left.length===right.length&&crypto.timingSafeEqual(left,right);
}

async function processWebhookPayload(db,payload,provider=new WhatsAppProvider()){
  const payloadHash=sha256(JSON.stringify(payload));
  const results=[];
  for(const status of extractStatuses(payload)){
    const eventId=`status:${status.id}:${status.status}:${status.timestamp||''}`;
    const inserted=await db.query('INSERT INTO whatsapp_webhook_events(event_id,event_type,payload_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',[eventId,'status',payloadHash]);
    if(!inserted.rowCount){results.push({duplicate:true,eventId});continue;}
    await db.query('UPDATE whatsapp_messages SET status=$1,error=$2,metadata_json=metadata_json || $3::jsonb WHERE whatsapp_message_id=$4',[status.status,status.errors?.[0]?.title||null,JSON.stringify({status_webhook:safeMetadata(status)}),status.id]);
    await recordMessage(db,{direction:'STATUS',whatsappMessageId:null,phone:status.recipient_id,type:'status',status:status.status,body:status.id,error:status.errors?.[0]?.title||null,metadata:status});
    results.push({status:status.status,id:status.id});
  }
  for(const message of extractMessages(payload)){
    const eventId=`message:${message.id}`;
    const inserted=await db.query('INSERT INTO whatsapp_webhook_events(event_id,event_type,payload_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',[eventId,'message',payloadHash]);
    if(!inserted.rowCount){results.push({duplicate:true,eventId});continue;}
    results.push(await processInboundMessage(db,message,provider));
  }
  return{processed:results.length,results};
}

async function enqueueOutbound(db,{idempotencyKey,eventType,ownerId,phone,payload,conversationId=null,relatedEntityType=null,relatedEntityId=null}){
  const jobId=uid(),automationEventId=uid();
  const result=await db.query(`INSERT INTO whatsapp_outbound_jobs(id,idempotency_key,conversation_id,owner_id,phone_e164,payload_json)
    VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key=excluded.idempotency_key RETURNING id`,[jobId,idempotencyKey,conversationId,ownerId,normalizePhone(phone),JSON.stringify(payload)]);
  await db.query(`INSERT INTO whatsapp_automation_events(id,idempotency_key,event_type,owner_id,related_entity_type,related_entity_id,job_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(idempotency_key) DO NOTHING`,[automationEventId,idempotencyKey,eventType,ownerId,relatedEntityType,isUuid(relatedEntityId)?relatedEntityId:null,result.rows[0].id]);
  return result.rows[0].id;
}

async function triggerAutomation(db,eventType,{ownerId,relatedEntityType=null,relatedEntityId=null,parameters=[],idempotencyKey=null}={}){
  const automation=(await db.query('SELECT a.*,t.meta_template_name,t.language FROM whatsapp_automations a LEFT JOIN whatsapp_templates t ON t.name=a.template_name WHERE a.event_type=$1',[eventType])).rows[0];
  if(!automation?.enabled)return{skipped:'automation_disabled'};
  const owner=(await db.query('SELECT * FROM persons WHERE id=$1',[ownerId])).rows[0];
  if(!owner||!owner.whatsapp||owner.whatsapp_opt_in===false)return{skipped:'owner_not_available'};
  const prefs=owner.whatsapp_preferences_json||{};
  if(automation.preference_key&&prefs[automation.preference_key]===false)return{skipped:'preference_disabled'};
  const key=idempotencyKey||`${eventType}:${ownerId}:${relatedEntityType||'none'}:${relatedEntityId||'none'}`;
  const payload={kind:'template',template:automation.meta_template_name,language:automation.language||'es_AR',parameters};
  const jobId=await enqueueOutbound(db,{idempotencyKey:key,eventType,ownerId,phone:owner.whatsapp,payload,relatedEntityType,relatedEntityId});
  return{jobId};
}

async function processOutboundJobs(db,provider=new WhatsAppProvider(),limit=10){
  const jobs=(await db.query("SELECT * FROM whatsapp_outbound_jobs WHERE status IN ('QUEUED','FAILED') AND next_attempt_at<=now() ORDER BY created_at LIMIT $1",[limit])).rows,results=[];
  for(const job of jobs){
    await db.query("UPDATE whatsapp_outbound_jobs SET status='SENDING',attempts=attempts+1 WHERE id=$1",[job.id]);
    const payload=job.payload_json;
    try{
      let result;
      if(payload.kind==='template')result=await provider.sendTemplate(job.phone_e164,payload.template,payload.language,payload.parameters||[]);
      else result=await provider.sendText(job.phone_e164,payload.text||'');
      const metaId=result.messages?.[0]?.id||null;
      await db.query("UPDATE whatsapp_outbound_jobs SET status='SENT',meta_message_id=$1,sent_at=now(),last_error=NULL WHERE id=$2",[metaId,job.id]);
      await recordMessage(db,{conversationId:job.conversation_id,direction:'OUTBOUND',whatsappMessageId:metaId,phone:job.phone_e164,type:payload.kind||'text',body:payload.text||null,status:'sent',templateName:payload.template||null,automated:true,metadata:{job_id:job.id}});
      results.push({id:job.id,status:'SENT'});
    }catch(error){
      const attempts=Number(job.attempts||0)+1,dead=attempts>=Number(job.max_attempts||5),minutes=Math.min(60,2**attempts);
      await db.query(`UPDATE whatsapp_outbound_jobs SET status=$1,last_error=$2,next_attempt_at=now()+($3 || ' minutes')::interval WHERE id=$4`,[dead?'DEAD':'FAILED',error.message,minutes,job.id]);
      results.push({id:job.id,status:dead?'DEAD':'FAILED',error:error.message});
    }
  }
  return results;
}

async function whatsappDashboard(db){
  const stats=(await db.query(`SELECT
    (SELECT COUNT(*)::int FROM whatsapp_conversations WHERE status IN ('PENDING_AUTH','VERIFIED','HUMAN_HANDOFF')) active_conversations,
    (SELECT COUNT(*)::int FROM whatsapp_messages WHERE direction='OUTBOUND') sent_total,
    (SELECT COUNT(*)::int FROM whatsapp_messages WHERE status='delivered') delivered,
    (SELECT COUNT(*)::int FROM whatsapp_messages WHERE status='read') read,
    (SELECT COUNT(*)::int FROM whatsapp_messages WHERE status IN ('failed','FAILED') OR error IS NOT NULL) errors,
    (SELECT COUNT(*)::int FROM whatsapp_outbound_jobs WHERE created_at>now()-interval '7 days') recent_automations`)).rows[0];
  const recent=(await db.query(`SELECT c.id,c.status,c.phone_e164,c.last_message_at,p.full_name owner,
    (SELECT body FROM whatsapp_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) last_message
    FROM whatsapp_conversations c LEFT JOIN persons p ON p.id=c.owner_id ORDER BY c.updated_at DESC LIMIT 8`)).rows;
  return{stats,recent};
}

async function listConversations(db){
  return (await db.query(`SELECT c.*,p.full_name owner,p.whatsapp_opt_in,
    (SELECT body FROM whatsapp_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) last_message
    FROM whatsapp_conversations c LEFT JOIN persons p ON p.id=c.owner_id ORDER BY c.updated_at DESC`)).rows;
}

async function handleWhatsAppApi(db,req,res,pathname,helpers){
  const {json,text,readBody,readRawBody}=helpers,parts=pathname.split('/').filter(Boolean),section=parts[2],id=parts[3],action=parts[4];
  if(section==='webhook'&&req.method==='GET'){
    const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    if(url.searchParams.get('hub.mode')==='subscribe'&&url.searchParams.get('hub.verify_token')===config.whatsapp.verifyToken)return text(res,200,url.searchParams.get('hub.challenge')||'');
    return text(res,403,'Forbidden');
  }
  if(section==='webhook'&&req.method==='POST'){
    const raw=await readRawBody(req);
    if(!verifySignature(raw,req.headers['x-hub-signature-256']))return json(res,401,{error:'Firma de webhook inválida o WHATSAPP_APP_SECRET no configurado.'});
    const payload=raw.length?JSON.parse(raw.toString('utf8')):{};
    return json(res,200,await processWebhookPayload(db,payload));
  }
  if(section==='dashboard'&&req.method==='GET')return json(res,200,await whatsappDashboard(db));
  if(section==='conversations'&&req.method==='GET')return json(res,200,await listConversations(db));
  if(section==='conversations'&&id&&action==='messages'&&req.method==='GET')return json(res,200,(await db.query('SELECT * FROM whatsapp_messages WHERE conversation_id=$1 ORDER BY created_at',[id])).rows);
  if(section==='conversations'&&id&&action==='reply'&&req.method==='POST'){
    const input=await readBody(req),conversation=(await db.query('SELECT * FROM whatsapp_conversations WHERE id=$1',[id])).rows[0];
    if(!conversation)return json(res,404,{error:'Conversación no encontrada.'});
    const result=await sendAndStore(db,conversation,new WhatsAppProvider(),String(input.text||''),{automated:false});
    return json(res,result.error?400:201,result);
  }
  if(section==='conversations'&&id&&['take','close','bot'].includes(action)&&req.method==='POST'){
    const status=action==='take'?'HUMAN_HANDOFF':(action==='close'?'CLOSED':'VERIFIED');
    await updateConversation(db,id,{status});
    return json(res,200,{id,status});
  }
  if(section==='templates'&&req.method==='GET')return json(res,200,(await db.query('SELECT * FROM whatsapp_templates ORDER BY name')).rows);
  if(section==='templates'&&id&&req.method==='PATCH'){
    const input=await readBody(req);
    await db.query('UPDATE whatsapp_templates SET meta_template_name=COALESCE($1,meta_template_name),category=COALESCE($2,category),language=COALESCE($3,language),status=COALESCE($4,status),enabled=COALESCE($5,enabled),updated_at=now() WHERE name=$6',[input.meta_template_name||null,input.category||null,input.language||null,input.status||null,input.enabled,id]);
    return json(res,200,{name:id,updated:true});
  }
  if(section==='automations'&&req.method==='GET')return json(res,200,(await db.query('SELECT a.*,t.status template_status FROM whatsapp_automations a LEFT JOIN whatsapp_templates t ON t.name=a.template_name ORDER BY a.event_type')).rows);
  if(section==='automations'&&id&&req.method==='PATCH'){
    const input=await readBody(req);
    await db.query('UPDATE whatsapp_automations SET enabled=COALESCE($1,enabled),template_name=COALESCE($2,template_name),updated_at=now() WHERE id=$3',[input.enabled,input.template_name||null,id]);
    return json(res,200,{id,updated:true});
  }
  if(section==='jobs'&&action==='process'&&req.method==='POST')return json(res,200,{processed:await processOutboundJobs(db)});
  if(section==='config'&&req.method==='GET')return json(res,200,{configured:new WhatsAppProvider().isConfigured(),phone_number_id:config.whatsapp.phoneNumberId?`…${config.whatsapp.phoneNumberId.slice(-4)}`:'',business_account_id:config.whatsapp.businessAccountId?`…${config.whatsapp.businessAccountId.slice(-4)}`:'',webhook_path:'/api/whatsapp/webhook',graph_version:config.whatsapp.graphVersion,verify_token_set:Boolean(config.whatsapp.verifyToken),app_secret_set:Boolean(config.whatsapp.appSecret)});
  return json(res,404,{error:'Ruta WhatsApp inexistente.'});
}

module.exports={WhatsAppProvider,normalizePhone,resolveIntent,verifySignature,processInboundMessage,processWebhookPayload,triggerAutomation,processOutboundJobs,handleWhatsAppApi,generatePortalToken};
