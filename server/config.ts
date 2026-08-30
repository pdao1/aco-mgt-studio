import 'dotenv/config';
import { z } from 'zod';

const optionalSecret = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().min(1).optional(),
);
const booleanFromEnv = z.preprocess(
  (value) => typeof value === 'string' ? ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase()) : value,
  z.boolean(),
);

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  MAILBOX_ENCRYPTION_KEY: z.string().min(1),
  OPERATOR_PASSWORD: z.preprocess((value) => value === '' ? undefined : value, z.string().min(12).optional()),
  SESSION_SECRET: z.string().min(24),
  PORTAL_SECRET: z.string().min(24),
  STRIPE_SECRET_KEY: optionalSecret,
  STRIPE_WEBHOOK_SECRET: optionalSecret,
  STRIPE_DUE_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  SERVICE_SERIAL: z.string().min(12),
  SUPER_ADMIN_SERIAL: optionalSecret,
  SMTP_HOST: optionalSecret,
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: booleanFromEnv.default(false),
  SMTP_USER: optionalSecret,
  SMTP_PASSWORD: optionalSecret,
  SMTP_FROM: optionalSecret,
  NOTIFICATION_SELLER_EMAIL: optionalSecret,
  VENMO_PAYMENT_URL: optionalSecret,
  // Optional low-cost item-row review. Order identity/status stay deterministic
  // even when this provider is disabled or unavailable.
  OPENAI_KEY: optionalSecret,
  OPENAI_MODEL: z.string().trim().min(1).max(120).default('gpt-5-nano'),
  OPENAI_MAX_REVIEWS_PER_SYNC: z.coerce.number().int().min(0).max(100).default(25),
  // Optional carrier API credentials. Each carrier offers a no-cost developer
  // tier, but all three require the operator to create an account and keys.
  USPS_CLIENT_ID: optionalSecret,
  USPS_CLIENT_SECRET: optionalSecret,
  UPS_CLIENT_ID: optionalSecret,
  UPS_CLIENT_SECRET: optionalSecret,
  UPS_TRANSACTION_SRC: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().trim().min(1).max(120),
  ).default('aco-studio'),
  FEDEX_API_KEY: optionalSecret,
  FEDEX_SECRET_KEY: optionalSecret,
  FEDEX_ACCOUNT_NUMBER: optionalSecret,
  TRACKING_SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
  TRACKING_MAX_SHIPMENTS_PER_SYNC: z.coerce.number().int().min(1).max(1000).default(100),
  WORKSPACE_NAME: z.string().min(1).default('ACO Studio'),
  WORKSPACE_SLUG: z.string().regex(/^[a-z0-9-]+$/).default('default'),
  PORT: z.coerce.number().int().positive().default(3001),
  APP_ORIGIN: z.string().url().default('http://localhost:5173'),
  SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(5),
  SYNC_MAX_MESSAGES: z.coerce.number().int().min(1).max(5000).default(500),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type AppConfig = {
  databaseUrl: string;
  mailboxEncryptionKey: string;
  operatorPassword: string | null;
  sessionSecret: string;
  portalSecret: string;
  stripeSecretKey: string | null;
  stripeWebhookSecret: string | null;
  stripeDueDays: number;
  serviceSerial: string;
  superAdminSerial: string | null;
  smtpHost: string | null;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string | null;
  smtpPassword: string | null;
  smtpFrom: string | null;
  notificationSellerEmail: string | null;
  venmoPaymentUrl: string | null;
  openaiKey: string | null;
  openaiModel: string;
  openaiMaxReviewsPerSync: number;
  uspsClientId: string | null;
  uspsClientSecret: string | null;
  upsClientId: string | null;
  upsClientSecret: string | null;
  upsTransactionSrc: string;
  fedexApiKey: string | null;
  fedexSecretKey: string | null;
  fedexAccountNumber: string | null;
  trackingSyncIntervalMinutes: number;
  trackingMaxShipmentsPerSync: number;
  workspaceName: string;
  workspaceSlug: string;
  port: number;
  appOrigin: string;
  syncIntervalMinutes: number;
  syncMaxMessages: number;
  nodeEnv: 'development' | 'test' | 'production';
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(environment);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Missing or invalid server configuration: ${fields}`);
  }
  const value = parsed.data;
  if (value.NODE_ENV === 'production' && !value.APP_ORIGIN.startsWith('https://')) {
    throw new Error('APP_ORIGIN must use HTTPS in production so customer portal links are secure.');
  }
  return {
    databaseUrl: value.DATABASE_URL,
    mailboxEncryptionKey: value.MAILBOX_ENCRYPTION_KEY,
    operatorPassword: value.OPERATOR_PASSWORD ?? null,
    sessionSecret: value.SESSION_SECRET,
    portalSecret: value.PORTAL_SECRET,
    stripeSecretKey: value.STRIPE_SECRET_KEY ?? null,
    stripeWebhookSecret: value.STRIPE_WEBHOOK_SECRET ?? null,
    stripeDueDays: value.STRIPE_DUE_DAYS,
    serviceSerial: value.SERVICE_SERIAL,
    superAdminSerial: value.SUPER_ADMIN_SERIAL ?? null,
    smtpHost: value.SMTP_HOST ?? null,
    smtpPort: value.SMTP_PORT,
    smtpSecure: value.SMTP_SECURE,
    smtpUser: value.SMTP_USER ?? null,
    smtpPassword: value.SMTP_PASSWORD ?? null,
    smtpFrom: value.SMTP_FROM ?? null,
    notificationSellerEmail: value.NOTIFICATION_SELLER_EMAIL ?? null,
    venmoPaymentUrl: value.VENMO_PAYMENT_URL ?? null,
    openaiKey: value.OPENAI_KEY ?? null,
    openaiModel: value.OPENAI_MODEL,
    openaiMaxReviewsPerSync: value.OPENAI_MAX_REVIEWS_PER_SYNC,
    uspsClientId: value.USPS_CLIENT_ID ?? null,
    uspsClientSecret: value.USPS_CLIENT_SECRET ?? null,
    upsClientId: value.UPS_CLIENT_ID ?? null,
    upsClientSecret: value.UPS_CLIENT_SECRET ?? null,
    upsTransactionSrc: value.UPS_TRANSACTION_SRC,
    fedexApiKey: value.FEDEX_API_KEY ?? null,
    fedexSecretKey: value.FEDEX_SECRET_KEY ?? null,
    fedexAccountNumber: value.FEDEX_ACCOUNT_NUMBER ?? null,
    trackingSyncIntervalMinutes: value.TRACKING_SYNC_INTERVAL_MINUTES,
    trackingMaxShipmentsPerSync: value.TRACKING_MAX_SHIPMENTS_PER_SYNC,
    workspaceName: value.WORKSPACE_NAME,
    workspaceSlug: value.WORKSPACE_SLUG,
    port: value.PORT,
    appOrigin: value.APP_ORIGIN.replace(/\/$/, ''),
    syncIntervalMinutes: value.SYNC_INTERVAL_MINUTES,
    syncMaxMessages: value.SYNC_MAX_MESSAGES,
    nodeEnv: value.NODE_ENV,
  };
}
