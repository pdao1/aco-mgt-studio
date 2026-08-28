import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadConfig } from '../config.js';

const { Pool } = pg;
const directory = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(databaseUrl: string, production = false) {
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: production ? { rejectUnauthorized: false } : undefined,
    max: 1,
  });
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const migrations = ['001_initial', '002_fees_portal', '003_billing_overrides', '004_service_fee_tenancy', '005_beta_access_settings', '006_cancellation_matching', '007_order_items'];
    for (const name of migrations) {
      const existing = await client.query('SELECT 1 FROM app_migrations WHERE name = $1', [name]);
      if (existing.rowCount !== 0) continue;
      const sql = await readFile(join(directory, 'migrations', `${name}.sql`), 'utf8');
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO app_migrations(name) VALUES ($1)', [name]);
      await client.query('COMMIT');
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = loadConfig();
  await runMigrations(config.databaseUrl, config.nodeEnv === 'production');
  console.info('Database migrations are current.');
}
