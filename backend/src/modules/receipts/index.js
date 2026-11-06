const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {PDFDocument,StandardFonts,rgb}=require('pdf-lib');
const {balance,scaled,decimal}=require('../../lib/money');
const {uid}=require('../../database');

const logoPath=path.resolve(__dirname,'../../../../frontend/src/assets/ferraro-logo.png');
const actor='Operador local; sin sesión autenticada';
const money=(value,currency)=>{const amount=decimal(scaled(value)),negative=amount.startsWith('-'),[whole,cents]=(negative?amount.slice(1):amount).split('.');return `${currency} ${negative?'-':''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g,'.')},${cents}`;};
const printable=value=>String(value??'—').replace(/[^\u0020-\u00ff]/g,' ').replace(/\s+/g,' ').trim().slice(0,170)||'—';
const date=value=>new Date(value).toLocaleDateString('es-AR',{timeZone:'UTC',day:'2-digit',month:'2-digit',year:'numeric'});

async function makePdf(snapshot){
  const pdf=await PDFDocument.create(),page=pdf.addPage([595.28,841.89]),regular=await pdf.embedFont(StandardFonts.Helvetica),bold=await pdf.embedFont(StandardFonts.HelveticaBold);
  page.drawRectangle({x:0,y:0,width:595.28,height:841.89,color:rgb(1,1,1)});
  const navy=rgb(.10,.10,.12),muted=rgb(.36,.36,.39),line=rgb(.83,.84,.86),accent=rgb(.60,0,.043);
  const draw=(value,x,y,size=10,font=regular,color=navy)=>page.drawText(printable(value),{x,y,size,font,color,maxWidth:505});
  const fit=(value,max,font,size)=>{let s=printable(value);while(s.length>1&&font.widthOfTextAtSize(s,size)>max)s=s.slice(0,-2);return s};
  const row=(label,value,y)=>{draw(label,47,y,9,regular,muted);draw(fit(value,285,regular,10),260,y,10);page.drawLine({start:{x:47,y:y-8},end:{x:548,y:y-8},thickness:.4,color:line});};
  try{const logo=await pdf.embedPng(fs.readFileSync(logoPath));page.drawImage(logo,{x:47,y:741,width:66,height:66});}catch{/* The legal identity remains in text if the bundled image cannot be loaded. */}
  draw('Eugenio A. Ferraro Propiedades',125,788,17,bold);draw('RECIBO ADMINISTRATIVO DE COBRO',125,768,10,bold,accent);
  draw('No es factura fiscal. No contiene CAE.',125,751,8,regular,muted);
  page.drawLine({start:{x:47,y:727},end:{x:548,y:727},thickness:1,color:accent});
  draw(`Comprobante N° ${String(snapshot.number).padStart(8,'0')}`,47,703,15,bold);
  draw(`Emitido: ${date(snapshot.issued_at)}`,370,704,9);
  if(snapshot.replaces_number)draw(`Rectifica comprobante N° ${String(snapshot.replaces_number).padStart(8,'0')}`,47,684,8,regular,muted);
  row('Fecha de pago',date(snapshot.paid_at),672);row('Inquilino',snapshot.tenant,648);row('Propiedad',snapshot.property,624);
  row('Contrato',snapshot.contract,600);row('Período',snapshot.period,576);row('Medio de pago',snapshot.method,552);
  row('Referencia del movimiento',snapshot.reference||snapshot.payment_id,528);
  draw('COMPOSICIÓN DE LA OBLIGACIÓN',47,495,10,bold,accent);
  draw('Importes registrados en la cuota al emitir; no son una imputación por concepto.',47,478,8,regular,muted);
  const items=[['Canon del período',snapshot.components.rent],['IVA',snapshot.components.vat],['Servicios netos',snapshot.components.services],['Gastos trasladables',snapshot.components.recoverable],['Otros cargos',snapshot.components.other],['Punitorios netos',snapshot.components.late_fee],['Descuento general',`-${snapshot.components.discount}`]];
  let y=451;for(const [label,value] of items){if(scaled(value)===0n)continue;draw(label,47,y,9);draw(money(value,snapshot.currency),390,y,9);y-=22;}
  page.drawLine({start:{x:47,y:y+7},end:{x:548,y:y+7},thickness:.5,color:line});y-=17;
  draw('TOTAL EFECTIVAMENTE RECIBIDO',47,y,11,bold);draw(money(snapshot.amount,snapshot.currency),365,y,13,bold,accent);y-=31;
  draw('Saldo de la cuota al emitir',47,y,9);draw(money(snapshot.due,snapshot.currency),390,y,9);y-=23;
  if(scaled(snapshot.credit)>0n){draw('Crédito resultante',47,y,9);draw(money(snapshot.credit,snapshot.currency),390,y,9);}
  draw('El importe recibido corresponde al pago identificado arriba.',47,111,8,regular,muted);
  draw('Los cambios posteriores no alteran esta versión emitida.',47,98,8,regular,muted);
  page.drawLine({start:{x:47,y:84},end:{x:548,y:84},thickness:.5,color:line});
  draw(`Pago ${snapshot.payment_id}`,47,69,8,regular,muted);
  return Buffer.from(await pdf.save({useObjectStreams:false}));
}

async function issueReceipt(client,paymentId,{replaces=null,reason=null}={}){
  const existing=(await client.query("SELECT id,receipt_number,status FROM payment_receipts WHERE payment_id=$1 AND status='Emitido'",[paymentId])).rows[0];
  if(existing)return{id:existing.id,number:existing.receipt_number,status:existing.status,already_issued:true};
  if(!replaces&&(await client.query('SELECT 1 FROM payment_receipts WHERE payment_id=$1 LIMIT 1',[paymentId])).rowCount)throw new Error('El comprobante fue anulado. Usá la rectificación auditada.');
  const r=(await client.query(`SELECT pay.*,i.period,i.currency,i.expected_amount,i.vat_amount,i.services_amount,i.late_fee_amount,i.discount_amount,i.manual_partial_amount,
      c.code contract_code,c.alias contract_alias,pe.full_name tenant,pr.address property
    FROM payments pay JOIN installments i ON i.id=pay.installment_id JOIN contracts c ON c.id=i.contract_id
    JOIN persons pe ON pe.id=c.tenant_id JOIN properties pr ON pr.id=c.property_id WHERE pay.id=$1 FOR UPDATE OF pay`,[paymentId])).rows[0];
  if(!r)throw new Error('No existe el pago registrado.');
  const charges=(await client.query(`SELECT charge_kind,COALESCE(SUM(original_amount-forgiven_amount),0)::text amount
    FROM installment_services WHERE installment_id=$1 AND status='Confirmado' GROUP BY charge_kind`,[r.installment_id])).rows;
  const categories=Object.fromEntries(charges.map(c=>[c.charge_kind,c.amount]));
  if(charges.reduce((sum,c)=>sum+scaled(c.amount),0n)!==scaled(r.services_amount))throw new Error('La proyección de cargos de esta cuota no coincide; revisala antes de emitir el recibo.');
  const received=(await client.query('SELECT COALESCE(SUM(amount),0)::text amount FROM payments WHERE installment_id=$1',[r.installment_id])).rows[0].amount;
  const totalPaid=decimal(scaled(received)+scaled(r.manual_partial_amount)),signed=scaled(balance(r,totalPaid));
  const number=(await client.query("SELECT nextval('payment_receipt_number_seq')::text number")).rows[0].number;
  const issuedAt=(await client.query('SELECT clock_timestamp() issued_at')).rows[0].issued_at;
  const replaced=replaces?(await client.query('SELECT receipt_number::text number FROM payment_receipts WHERE id=$1',[replaces])).rows[0]:null;
  const snapshot={version:1,number,replaces_number:replaced?.number||null,issued_at:issuedAt.toISOString(),payment_id:r.id,installment_id:r.installment_id,
    paid_at:r.paid_at,tenant:r.tenant,property:r.property,contract:r.contract_alias||r.contract_code,period:r.period,
    amount:r.amount,currency:r.currency,method:r.method,reference:r.reference,
    components:{rent:r.expected_amount,vat:r.vat_amount||'0.00',services:categories.service||'0.00',recoverable:categories.recoverable||'0.00',other:categories.other||'0.00',late_fee:r.late_fee_amount||'0.00',discount:r.discount_amount||'0.00'},
    due:decimal(signed>0n?signed:0n),credit:decimal(signed<0n?-signed:0n)};
  const bytes=await makePdf(snapshot),hash=crypto.createHash('sha256').update(bytes).digest('hex'),id=uid();
  await client.query(`INSERT INTO payment_receipts(id,receipt_number,payment_id,replaces_receipt_id,issued_at,snapshot_json,pdf_bytes,pdf_sha256)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,number,paymentId,replaces,issuedAt,snapshot,bytes,hash]);
  await client.query('INSERT INTO payment_receipt_events(id,receipt_id,action,reason,actor) VALUES($1,$2,$3,$4,$5)',[uid(),id,'Emitido',reason,actor]);
  return{id,number,status:'Emitido',payment_id:paymentId,pdf_sha256:hash};
}

async function issueHistorical(db,paymentId){const client=await db.connect();try{
  await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['ferraro:ipc:write']);
  const result=await issueReceipt(client,paymentId);await client.query('COMMIT');return result;
}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}

async function getReceipt(db,id,{withPdf=false}={}){
  const r=(await db.query(`SELECT id,receipt_number::text number,payment_id,issued_at,snapshot_json,pdf_sha256,status,voided_at,void_reason${withPdf?',pdf_bytes':''} FROM payment_receipts WHERE id=$1`,[id])).rows[0];
  if(!r)throw new Error('Comprobante no encontrado.');
  if(withPdf&&crypto.createHash('sha256').update(r.pdf_bytes).digest('hex')!==r.pdf_sha256)throw new Error('La integridad del PDF almacenado no coincide.');
  return r;
}
async function listReceipts(db,paymentId){return(await db.query(`SELECT id,receipt_number::text number,payment_id,replaces_receipt_id,issued_at,pdf_sha256,status,voided_at,void_reason
  FROM payment_receipts WHERE payment_id=$1 ORDER BY receipt_number DESC`,[paymentId])).rows;}

async function voidReceipt(db,id,reason){const clean=String(reason||'').trim();if(clean.length<5)throw new Error('Indicá un motivo de al menos cinco caracteres.');
  const client=await db.connect();try{await client.query('BEGIN');const r=(await client.query('SELECT id,status FROM payment_receipts WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!r)throw new Error('Comprobante no encontrado.');if(r.status!=='Emitido')throw new Error('El comprobante ya está anulado.');
    await client.query("UPDATE payment_receipts SET status='Anulado',voided_at=clock_timestamp(),void_reason=$2 WHERE id=$1",[id,clean]);
    await client.query('INSERT INTO payment_receipt_events(id,receipt_id,action,reason,actor) VALUES($1,$2,$3,$4,$5)',[uid(),id,'Anulado',clean,actor]);
    await client.query('COMMIT');return{id,status:'Anulado'};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}

async function rectifyReceipt(db,id,reason){const clean=String(reason||'').trim();if(clean.length<5)throw new Error('Indicá un motivo de al menos cinco caracteres.');
  const client=await db.connect();try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['ferraro:ipc:write']);
    const old=(await client.query('SELECT payment_id,receipt_number,status FROM payment_receipts WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!old)throw new Error('Comprobante no encontrado.');
    if((await client.query('SELECT 1 FROM payment_receipts WHERE replaces_receipt_id=$1',[id])).rowCount)throw new Error('El comprobante ya fue rectificado.');
    if(old.status==='Emitido'){
      await client.query("UPDATE payment_receipts SET status='Anulado',voided_at=clock_timestamp(),void_reason=$2 WHERE id=$1",[id,clean]);
      await client.query('INSERT INTO payment_receipt_events(id,receipt_id,action,reason,actor) VALUES($1,$2,$3,$4,$5)',[uid(),id,'Anulado',clean,actor]);
    }
    const replacement=await issueReceipt(client,old.payment_id,{replaces:id,reason:clean});
    if(replacement.already_issued)throw new Error('Ya existe otro recibo vigente para este pago.');
    await client.query('COMMIT');return replacement;
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}

module.exports={makePdf,issueReceipt,issueHistorical,getReceipt,listReceipts,voidReceipt,rectifyReceipt};
