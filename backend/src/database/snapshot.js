const {Query}=require('pg'),crypto=require('node:crypto');
const {balance,scaled,decimal}=require('../lib/money');
const quote=name=>'"'+name.replaceAll('"','""')+'"';
async function hashRows(client,text,values=[]){const hash=crypto.createHash('sha256');let count=0;await new Promise((resolve,reject)=>{const q=new Query({text,values,rowMode:'array'});q.on('row',row=>{const s=row[0];hash.update(Buffer.byteLength(s)+':'+s);count++;});q.on('error',reject);q.on('end',resolve);client.query(q);});return {count,hash:hash.digest('hex')};}
async function snapshot(client,{projection=null}={}){
  // Normalize serialization across Docker (UTC/locale) and native macOS clusters.
  await client.query("SET TIME ZONE 'UTC'; SET datestyle='ISO, YMD'; SET intervalstyle='postgres'");
  const columns=(await client.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")).rows;
  const tables=(await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(r=>r.tablename).sort(),result={tables:{}};
  for(const table of projection?Object.keys(projection.tables):tables){
    if(!tables.includes(table))throw new Error('Desapareció una tabla existente.');
    const names=columns.filter(c=>c.table_name===table).map(c=>c.column_name),keep=projection?.tables[table].columns||names;
    if(keep.some(n=>!names.includes(n)))throw new Error('Desapareció una columna existente.');
    const excluded=names.filter(n=>!keep.includes(n));
    result.tables[table]={columns:keep,...await hashRows(client,`SELECT (to_jsonb(t)-$1::text[])::text FROM public.${quote(table)} t ORDER BY (to_jsonb(t)-$1::text[])::text COLLATE "C"`,[excluded])};
  }
  const structures=(await client.query(`SELECT 'column' kind,table_name name,column_name detail,concat_ws('|',data_type,is_nullable,column_default) definition FROM information_schema.columns WHERE table_schema='public'
    UNION ALL SELECT 'constraint',c.relname,k.conname,pg_get_constraintdef(k.oid) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
    UNION ALL SELECT 'view',viewname,'',definition FROM pg_views WHERE schemaname='public'
    UNION ALL SELECT 'index',tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public'
    UNION ALL SELECT 'trigger',c.relname,t.tgname,pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal
    UNION ALL SELECT 'function',p.proname,pg_get_function_identity_arguments(p.oid),pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'
    ORDER BY 1,2,3,4`)).rows;
  result.schema_hash=crypto.createHash('sha256').update(JSON.stringify(structures.sort((a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:JSON.stringify(a)>JSON.stringify(b)?1:0))).digest('hex');
  const sequences=(await client.query("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).rows;result.sequences={};
  for(const {sequencename} of sequences.sort((a,b)=>a.sequencename<b.sequencename?-1:a.sequencename>b.sequencename?1:0))result.sequences[sequencename]=(await client.query(`SELECT last_value::text,is_called FROM public.${quote(sequencename)}`)).rows[0];
  result.finance=await financialSummary(client,columns,tables);return result;
}
async function financialSummary(client,columns,tables){
  if(!tables.includes('installments'))return null;
  const names=columns.filter(c=>c.table_name==='installments').map(c=>c.column_name),fields=['expected_amount','vat_amount','late_fee_amount','services_amount','discount_amount','manual_partial_amount'];
  const rows=(await client.query(`SELECT i.id,i.status,i.currency,${fields.map(f=>names.includes(f)?'i.'+quote(f)+'::text':"'0'::text AS "+quote(f)).join(',')},COALESCE((SELECT SUM(amount) FROM payments p WHERE p.installment_id=i.id),0)::text payments FROM installments i ORDER BY i.id`)).rows;
  const hash=crypto.createHash('sha256'),due={},credit={};for(const r of rows){const paid=decimal(scaled(r.payments)+scaled(r.manual_partial_amount)),signed=balance(r,paid);hash.update(JSON.stringify({id:r.id,status:r.status,currency:r.currency,paid,balance:signed}));const value=scaled(signed);if(value>0n)due[r.currency]=(due[r.currency]||0n)+value;else credit[r.currency]=(credit[r.currency]||0n)-value;}
  return {installments:rows.length,hash:hash.digest('hex'),due:Object.fromEntries(Object.entries(due).map(([k,v])=>[k,decimal(v)])),credit:Object.fromEntries(Object.entries(credit).map(([k,v])=>[k,decimal(v)]))};
}
function assertPreserved(before,after){for(const [name,value] of Object.entries(before.tables)){if(name==='schema_migrations')continue;const next=after.tables[name];if(!next||value.hash!==next.hash||value.count!==next.count)throw new Error('La simulación cambió información existente en '+name+'. Actualización cancelada.');}if(JSON.stringify(before.finance)!==JSON.stringify(after.finance))throw new Error('Cambió la comparación de saldos, pagos o créditos.');}
async function lockTables(client,mode='SHARE'){if(!['SHARE','ACCESS EXCLUSIVE'].includes(mode))throw new Error('Bloqueo inválido.');const tables=(await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;for(const t of tables)await client.query(`LOCK TABLE public.${quote(t.tablename)} IN ${mode} MODE`);}
module.exports={snapshot,assertPreserved,lockTables,quote};
