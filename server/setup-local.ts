import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const envPath = resolve(process.cwd(), '.env');

if (existsSync(envPath)) {
  const current = await readFile(envPath, 'utf8');
  if (!/^SERVICE_SERIAL=\S+/m.test(current)) {
    await writeFile(envPath, `${current.trimEnd()}\nSERVICE_SERIAL=aco-beta-${randomBytes(18).toString('base64url')}\n`, { encoding: 'utf8' });
    console.info('Added a generated local beta serial to .env.');
  } else {
    console.info('Using the existing .env file.');
  }
} else {
  const env = [
    '# Generated for local development by npm run setup:local. Do not commit this file.',
    'DATABASE_URL=postgresql://aco_studio:local-development-only@127.0.0.1:55432/aco_studio',
    `MAILBOX_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`,
    `SESSION_SECRET=${randomBytes(32).toString('base64url')}`,
    `PORTAL_SECRET=${randomBytes(32).toString('base64url')}`,
    'STRIPE_SECRET_KEY=',
    'STRIPE_WEBHOOK_SECRET=',
    'STRIPE_DUE_DAYS=7',
    `SERVICE_SERIAL=aco-beta-${randomBytes(18).toString('base64url')}`,
    'SUPER_ADMIN_SERIAL=',
    'SMTP_HOST=',
    'SMTP_PORT=587',
    'SMTP_SECURE=false',
    'SMTP_USER=',
    'SMTP_PASSWORD=',
    'SMTP_FROM=',
    'NOTIFICATION_SELLER_EMAIL=',
    'VENMO_PAYMENT_URL=',
    'OPENAI_KEY=',
    'OPENAI_MODEL=gpt-5-nano',
    'OPENAI_MAX_REVIEWS_PER_SYNC=25',
    'USPS_CLIENT_ID=',
    'USPS_CLIENT_SECRET=',
    'UPS_CLIENT_ID=',
    'UPS_CLIENT_SECRET=',
    'UPS_TRANSACTION_SRC=aco-studio',
    'FEDEX_API_KEY=',
    'FEDEX_SECRET_KEY=',
    'FEDEX_ACCOUNT_NUMBER=',
    'TRACKING_SYNC_INTERVAL_MINUTES=30',
    'TRACKING_MAX_SHIPMENTS_PER_SYNC=100',
    'PORT=3001',
    'APP_ORIGIN=http://127.0.0.1:5173',
    'SYNC_INTERVAL_MINUTES=5',
    'SYNC_MAX_MESSAGES=500',
    'NODE_ENV=development',
    'POSTGRES_PASSWORD=local-development-only',
    'POSTGRES_PORT=55432',
    '',
  ].join('\n');

  await writeFile(envPath, env, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  console.info('Created .env with generated local-only secrets.');
  console.info('Enter SERVICE_SERIAL from .env, then create your company workspace in the app.');
}
