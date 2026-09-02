const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_URL = 'postgresql://ferraro:ferraro_local@127.0.0.1:54329/inmobiliaria';

async function openDatabase(connectionString = process.env.DATABASE_URL || DEFAULT_URL) {
  const pool = new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  await pool.query('SELECT 1');
  await migrate(pool);
  await seedSettings(pool);
  return pool;
}

async function migrate(pool) {
  const directory = path.join(PROJECT_ROOT, 'database', 'migrations');
  const files = fs.readdirSync(directory).filter(file => file.endsWith('.sql')).sort();
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const file of files) {
    const exists = await pool.query('SELECT 1 FROM schema_migrations WHERE version=$1', [file]);
    if (exists.rowCount) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(fs.readFileSync(path.join(directory, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
}

async function seedSettings(db) {
  const defaults = {
    business_name: 'Eugenio A. Ferraro Propiedades',
    import_directory: path.join(PROJECT_ROOT, 'contratos'),
    bank_name: 'Banco Patagonia',
    cbu: '0340010408022000515001',
    default_management_fee_pct: '3',
    scan_interval_seconds: '30'
  };
  for (const [key,value] of Object.entries(defaults)) await db.query('INSERT INTO settings(key,value) VALUES ($1,$2) ON CONFLICT DO NOTHING',[key,value]);
}

async function allSettings(db) {
  const { rows } = await db.query('SELECT key,value FROM settings');
  return Object.fromEntries(rows.map(row => [row.key,row.value]));
}

function uid() { return crypto.randomUUID(); }
function normalizeAddress(value='') { return value.toLocaleLowerCase('es-AR').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\b(caba|ciudad autonoma de buenos aires|capital federal)\b/g,'').replace(/[^a-z0-9]+/g,' ').trim(); }

module.exports = { openDatabase, allSettings, uid, normalizeAddress };
