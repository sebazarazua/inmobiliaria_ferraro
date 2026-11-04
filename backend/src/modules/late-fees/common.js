const crypto=require('node:crypto');
const {scaled,decimal}=require('../../lib/money');
const {dateKey}=require('../../lib/calendar');
const secret=crypto.randomBytes(32);
const actor={id:'local-operator',label:'Operador local'};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function canonical(value){if(value instanceof Date)return value.toISOString();if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value;}
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const sign=payload=>crypto.createHmac('sha256',secret).update(payload).digest('hex');
function issue(fingerprint){const body=Buffer.from(JSON.stringify({fingerprint,expires:Date.now()+15*60*1000})).toString('base64url');return body+'.'+sign(body);}
function verify(token,fingerprint){try{const [body,mac,...rest]=String(token||'').split('.'),expected=sign(body||'');if(rest.length||!mac||Buffer.byteLength(mac)!==Buffer.byteLength(expected)||!crypto.timingSafeEqual(Buffer.from(mac),Buffer.from(expected)))throw Error();const data=JSON.parse(Buffer.from(body,'base64url'));if(data.expires<Date.now()||data.fingerprint!==fingerprint)throw Error();}catch{throw new Error('La revisión falta, venció o cambiaron los datos. Volvé a simular.');}}
function amount(value){if(!/^\d{1,12}(?:\.\d{1,2})?$/.test(String(value)))throw new Error('Ingresá un importe no negativo con hasta dos decimales.');return decimal(scaled(value));}
function reason(value){if(typeof value!=='string'||value.trim().length<5||value.length>3000)throw new Error('Indicá un motivo de entre 5 y 3000 caracteres.');return value.trim();}
const normalize=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const day=value=>{const key=dateKey(value);if(Number(key.slice(0,4))<1900||Number(key.slice(0,4))>9999)throw new Error('Fecha fuera de rango.');return key;};
const shift=(date,n)=>{const d=new Date(day(date)+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
module.exports={actor,uuid,hash,issue,verify,amount,reason,normalize,day,shift};
