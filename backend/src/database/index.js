const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const {context,validate}=require('./environment');
const {migrate,assertCompatible}=require('./migrations');

async function openDatabase(connectionString, {runMigrations=process.env.AUTO_MIGRATE==='true'}={}) {
  const ctx=context({connectionString});
  if(ctx.environment==='prod'&&(runMigrations||process.env.AUTO_MIGRATE==='true'))throw new Error('AUTO_MIGRATE=true está prohibido en PROD. Usá db:prod:prepare y db:prod:migrate.');
  if(ctx.environment==='test'&&ctx.purpose!=='tests')throw new Error('Una restauración de producción no es una base de pruebas sintéticas de la aplicación.');
  const pool = new Pool({ connectionString:ctx.url, application_name:'ferraro:'+ctx.environment, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  let lease;
  try {
    lease=await pool.connect();await validate(lease,ctx);
    const available=(await lease.query("SELECT pg_try_advisory_lock_shared(hashtext('ferraro:maintenance')) ok")).rows[0].ok;if(!available)throw new Error('Actualización en curso: no se habilitan escritores.');
    if(runMigrations)await migrate(pool,ctx);else await assertCompatible(lease);
    if(ctx.environment!=='prod')await seedSettings(pool);
    const end=pool.end.bind(pool);pool.end=async()=>{if(lease){await lease.query("SELECT pg_advisory_unlock_shared(hashtext('ferraro:maintenance'))").catch(()=>{});lease.release();lease=null;}await end();};
    return pool;
  } catch(error) {if(lease)lease.release();await pool.end();throw error;}
}

async function seedSettings(db) {
  const ctx=context();
  const defaults = {
    business_name: 'Eugenio A. Ferraro Propiedades',
    import_directory: ctx.import_directory,
    bank_name: 'Banco de Prueba',
    cbu: '0000000000000000000000',
    default_management_fee_pct: '3',
    scan_interval_seconds: '30'
  };
  for (const [key,value] of Object.entries(defaults)) await db.query('INSERT INTO settings(key,value) VALUES ($1,$2) ON CONFLICT DO NOTHING',[key,value]);
}

async function allSettings(db) {
  const { rows } = await db.query('SELECT key,value FROM settings');
  const settings=Object.fromEntries(rows.map(row => [row.key,row.value]));
  require('./environment').assertImportDirectory(settings.import_directory);return settings;
}

function uid() { return crypto.randomUUID(); }
function normalizeAddress(value='') { return value.toLocaleLowerCase('es-AR').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\b(caba|ciudad autonoma de buenos aires|capital federal)\b/g,'').replace(/[^a-z0-9]+/g,' ').trim(); }

module.exports = { openDatabase, allSettings, uid, normalizeAddress };
