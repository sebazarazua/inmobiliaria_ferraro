const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {validate}=require('./environment');
const DIRECTORY=path.resolve(__dirname,'../../../database/migrations');
const checksum=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
function files(directory=DIRECTORY){return fs.readdirSync(directory).filter(f=>/^\d+_[\w-]+\.sql$/.test(f)).sort().map(version=>({version,checksum:checksum(fs.readFileSync(path.join(directory,version))),sql:fs.readFileSync(path.join(directory,version),'utf8')}));}
async function status(client,{directory=DIRECTORY}={}){
  const local=files(directory),exists=(await client.query("SELECT to_regclass('public.schema_migrations') IS NOT NULL ok")).rows[0].ok;
  const applied=exists?(await client.query('SELECT version,applied_at FROM public.schema_migrations ORDER BY version')).rows:[];
  const tracked=(await client.query("SELECT to_regclass('ferraro_system.migration_checksums') IS NOT NULL ok")).rows[0].ok;
  const records=tracked?(await client.query('SELECT * FROM ferraro_system.migration_checksums')).rows:[];
  return {applied,files:local.map(({sql,...r})=>r),pending:local.filter(f=>!applied.some(a=>a.version===f.version)).map(({sql,...r})=>r),unknown:applied.filter(a=>!local.some(f=>f.version===a.version)).map(a=>a.version),altered:records.filter(r=>applied.some(a=>a.version===r.version)&&local.some(f=>f.version===r.version&&f.checksum!==r.checksum)).map(r=>r.version),historical_unverified:applied.filter(a=>!records.some(r=>r.version===a.version&&r.provenance==='executed_verified')).map(a=>a.version)};
}
async function assertCompatible(client,options){const s=await status(client,options);if(s.altered.length)throw new Error('Checksum alterado: '+s.altered.join(', '));if(s.unknown.length)throw new Error('Esquema de otra versión: '+s.unknown.join(', '));if(s.pending.length)throw new Error('Faltan migraciones: '+s.pending.map(f=>f.version).join(', ')+'. Usá el procedimiento del entorno; el arranque no las aplica.');return s;}
async function metadata(client){await client.query(`CREATE SCHEMA IF NOT EXISTS ferraro_system;
 CREATE TABLE IF NOT EXISTS public.schema_migrations(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS ferraro_system.migration_checksums(version text PRIMARY KEY,checksum text NOT NULL,provenance text NOT NULL CHECK(provenance IN ('adopted_unverified','executed_verified')),first_seen_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS ferraro_system.migration_runs(id uuid PRIMARY KEY,version text NOT NULL,checksum text NOT NULL,started_at timestamptz NOT NULL,finished_at timestamptz,duration_ms integer,result text NOT NULL,error_code text,operation_id uuid);`);}
async function adopt(client,s){for(const a of s.applied){const f=s.files.find(f=>f.version===a.version);if(f)await client.query("INSERT INTO ferraro_system.migration_checksums(version,checksum,provenance) VALUES($1,$2,'adopted_unverified') ON CONFLICT(version) DO NOTHING",[f.version,f.checksum]);}}
async function migrateClient(client,ctx,{directory=DIRECTORY,inTransaction=false,operationId=null}={}){
  await validate(client,ctx);
  if(ctx.environment==='prod'&&!inTransaction)throw new Error('PROD sólo migra mediante preparación, confirmación y transacción exclusiva.');
  // Transaction-level lock in a production outer transaction; session lock for per-file DEV/TEST commits.
  await client.query(inTransaction?"SELECT pg_advisory_xact_lock(hashtext('ferraro:schema:migrate'))":"SELECT pg_advisory_lock(hashtext('ferraro:schema:migrate'))");
  try{
    let s=await status(client,{directory});if(s.altered.length||s.unknown.length)throw new Error('Migraciones alteradas o desconocidas: '+s.altered.concat(s.unknown).join(', '));
    await metadata(client);await adopt(client,s);
    const applied=[];
    for(const f of files(directory).filter(f=>s.pending.some(p=>p.version===f.version))){
      const id=crypto.randomUUID(),started=new Date();
      if(!inTransaction)await client.query('BEGIN');
      try{
        await client.query('INSERT INTO ferraro_system.migration_runs(id,version,checksum,started_at,result,operation_id) VALUES($1,$2,$3,$4,\'running\',$5)',[id,f.version,f.checksum,started,operationId]);
        await client.query(f.sql);
        await client.query('INSERT INTO public.schema_migrations(version) VALUES($1)',[f.version]);
        await client.query("INSERT INTO ferraro_system.migration_checksums(version,checksum,provenance) VALUES($1,$2,'executed_verified') ON CONFLICT(version) DO UPDATE SET checksum=excluded.checksum,provenance=excluded.provenance",[f.version,f.checksum]);
        await client.query("UPDATE ferraro_system.migration_runs SET finished_at=clock_timestamp(),duration_ms=$2,result='success' WHERE id=$1",[id,Date.now()-started.getTime()]);
        if(!inTransaction)await client.query('COMMIT');applied.push(f.version);
      }catch(e){
        if(!inTransaction){await client.query('ROLLBACK');await client.query("INSERT INTO ferraro_system.migration_runs(id,version,checksum,started_at,finished_at,duration_ms,result,error_code,operation_id) VALUES($1,$2,$3,$4,clock_timestamp(),$5,'failed',$6,$7)",[id,f.version,f.checksum,started,Date.now()-started.getTime(),e.code||'ERROR',operationId]);}
        throw new Error(`Migración ${f.version} cancelada (${e.code||'ERROR'}); sin rollback destructivo.`);
      }
    }
    return applied;
  }finally{if(!inTransaction)await client.query("SELECT pg_advisory_unlock(hashtext('ferraro:schema:migrate'))");}
}
async function migrate(db,ctx,options){const client=await db.connect();try{return await migrateClient(client,ctx,options);}finally{client.release();}}
module.exports={DIRECTORY,files,status,assertCompatible,migrate,migrateClient,checksum};
