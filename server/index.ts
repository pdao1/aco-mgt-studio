import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { runMigrations } from './database/migrate.js';
import { Repository } from './database/repository.js';
import { BillingValidationError, OrderBillingLockedError } from './database/repository.js';
import { MailboxSyncCoordinator, verifyGmailConnection } from './email/imap.js';
import { OpenAIOrderEnrichmentProvider } from './workflows/openai-order-review.js';
import { StripeBillingError, StripeBillingGateway, StripeNotConfiguredError } from './billing/stripe.js';
import { SecretBox } from './security/secret-box.js';
import { verifyPortalToken } from './security/portal-token.js';
import { issueServiceAccess, requireServiceAccess, serialMatches } from './security/access.js';
import { SmtpNotifier } from './notifications/smtp.js';
import { TrackingSyncCoordinator } from './tracking/coordinator.js';
import { CompositeCarrierTrackingProvider, FedexTrackingProvider, UpsTrackingProvider, UspsTrackingProvider } from './tracking/providers.js';
import {
  clearSession,
  enforceOrigin,
  issueSession,
  loginRateLimit,
  operatorPasswordMatches,
  requireSession,
} from './security/session.js';

const config = loadConfig();
await runMigrations(config.databaseUrl, config.nodeEnv === 'production');

const repository = new Repository(config.databaseUrl, config.nodeEnv === 'production');
const workspaceId = await repository.ensureWorkspace(config.workspaceSlug, config.workspaceName);
const existingSettings = await repository.getWorkspaceSettings(workspaceId);
if ((config.venmoPaymentUrl && !existingSettings.venmoPaymentUrl) || (config.notificationSellerEmail && !existingSettings.notificationSellerEmail)) {
  await repository.updateWorkspaceSettings(workspaceId, {
    ...existingSettings,
    venmoPaymentUrl: existingSettings.venmoPaymentUrl ?? config.venmoPaymentUrl,
    notificationSellerEmail: existingSettings.notificationSellerEmail ?? config.notificationSellerEmail,
  });
}
const secretBox = new SecretBox(config.mailboxEncryptionKey);
const orderEnricher = config.openaiKey
  ? new OpenAIOrderEnrichmentProvider(config.openaiKey, config.openaiModel)
  : undefined;
const syncCoordinator = new MailboxSyncCoordinator(
  repository,
  secretBox,
  workspaceId,
  config.syncMaxMessages,
  orderEnricher,
  config.openaiMaxReviewsPerSync,
);
syncCoordinator.startPolling(config.syncIntervalMinutes);
const carrierTrackingProvider = new CompositeCarrierTrackingProvider([
  new UspsTrackingProvider(config.uspsClientId, config.uspsClientSecret),
  new UpsTrackingProvider(config.upsClientId, config.upsClientSecret, config.upsTransactionSrc),
  new FedexTrackingProvider(config.fedexApiKey, config.fedexSecretKey, config.fedexAccountNumber),
]);
const trackingCoordinator = new TrackingSyncCoordinator(
  repository,
  workspaceId,
  carrierTrackingProvider,
  config.trackingMaxShipmentsPerSync,
);
trackingCoordinator.startPolling(config.trackingSyncIntervalMinutes);
const stripeGateway = new StripeBillingGateway(config.stripeSecretKey);
const smtpNotifier = new SmtpNotifier({
  host: config.smtpHost,
  port: config.smtpPort,
  secure: config.smtpSecure,
  user: config.smtpUser,
  password: config.smtpPassword,
  from: config.smtpFrom,
});

const app = express();
if (config.nodeEnv === 'production') app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: config.nodeEnv === 'production' ? undefined : false,
  crossOriginResourcePolicy: { policy: 'same-origin' },
  referrerPolicy: { policy: 'no-referrer' },
}));
app.post('/api/stripe/webhook', express.raw({ type: 'application/json', limit: '64kb' }), async (request, response) => {
  if (!config.stripeWebhookSecret) {
    response.status(503).json({ error: 'STRIPE_NOT_CONFIGURED', message: 'Stripe webhooks are not configured for this workspace.' });
    return;
  }
  const signature = request.get('stripe-signature');
  if (!signature || !Buffer.isBuffer(request.body)) {
    response.status(400).json({ error: 'INVALID_STRIPE_WEBHOOK', message: 'Stripe webhook payload is invalid.' });
    return;
  }
  try {
    const event = stripeGateway.constructWebhookEvent(request.body, signature, config.stripeWebhookSecret);
    const accepted = await repository.recordStripeEvent(workspaceId, event.id, event.type);
    if (accepted) await applyStripeEvent(event);
    response.json({ received: true });
  } catch (error) {
    if (error instanceof StripeNotConfiguredError) {
      response.status(503).json({ error: 'STRIPE_NOT_CONFIGURED', message: error.message });
      return;
    }
    if (error instanceof StripeBillingError) {
      response.status(400).json({ error: 'INVALID_STRIPE_WEBHOOK', message: error.message });
      return;
    }
    response.status(500).json({ error: 'STRIPE_WEBHOOK_FAILED', message: 'The Stripe event will be retried.' });
  }
});
app.use(express.json({ limit: '32kb' }));
app.use(cookieParser());
app.use(enforceOrigin(config.appOrigin));
if (config.nodeEnv === 'production') {
  app.use((request, response, next) => {
    if (request.protocol !== 'https') {
      response.redirect(308, `${config.appOrigin}${request.originalUrl}`);
      return;
    }
    next();
  });
}

app.get('/api/health', async (_request, response) => {
  try {
    await repository.pool.query('SELECT 1');
    response.json({ ok: true });
  } catch {
    response.status(503).json({ ok: false });
  }
});

const loginSchema = z.object({ password: z.string().min(1).max(512) }).strict();
const accessSchema = z.object({ serial: z.string().trim().min(1).max(512) }).strict();
app.post('/api/access/activate', (request, response) => {
  const parsed = accessSchema.safeParse(request.body);
  if (!parsed.success || !serialMatches(parsed.data.serial, config.serviceSerial)) {
    response.status(401).json({ error: 'INVALID_SERVICE_SERIAL', message: 'That service serial is not valid.' });
    return;
  }
  issueServiceAccess(response, config.serviceSerial, config.sessionSecret, config.nodeEnv === 'production');
  response.json({ ok: true });
});

app.post('/api/auth/login', requireServiceAccess(config.sessionSecret, config.serviceSerial), loginRateLimit(), (request, response) => {
  const parsed = loginSchema.safeParse(request.body);
  if (!parsed.success || !operatorPasswordMatches(parsed.data.password, config.operatorPassword)) {
    response.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'The workspace password is incorrect.' });
    return;
  }
  issueSession(response, workspaceId, config.sessionSecret, config.nodeEnv === 'production');
  response.json({ ok: true });
});

app.post('/api/auth/logout', (_request, response) => {
  clearSession(response, config.nodeEnv === 'production');
  response.json({ ok: true });
});

// Customer links are intentionally public, but only expose a signed, scoped view.
// Keep this route before the operator session middleware below.
app.get('/api/public/portal/:token', async (request, response, next) => {
  try {
    const staticPayload = await repository.customerPortalByStaticToken(request.params.token);
    if (staticPayload) {
      response.setHeader('Cache-Control', 'private, no-store');
      response.json({ ...staticPayload, portalExpiresAt: null });
      return;
    }
    const claims = verifyPortalToken(request.params.token, config.portalSecret);
    if (!claims) {
      response.status(404).json({ error: 'PORTAL_LINK_INVALID', message: 'This customer link is invalid or has expired.' });
      return;
    }
    const payload = await repository.customerPortal(claims.workspaceId, claims.customerId);
    if (!payload) {
      response.status(404).json({ error: 'PORTAL_LINK_INVALID', message: 'This customer link is invalid or has expired.' });
      return;
    }
    response.setHeader('Cache-Control', 'private, no-store');
    response.json({ ...payload, portalExpiresAt: new Date(claims.expiresAt).toISOString() });
  } catch (error) {
    next(error);
  }
});

app.use('/api', requireServiceAccess(config.sessionSecret, config.serviceSerial), requireSession(config.sessionSecret));

app.get('/api/dashboard', async (request, response, next) => {
  try {
    response.json(await repository.dashboard(request.workspaceId!));
  } catch (error) {
    next(error);
  }
});

app.get('/api/billing', async (request, response, next) => {
  try {
    response.json(await repository.billing(request.workspaceId!));
  } catch (error) {
    next(error);
  }
});

app.get('/api/settings', async (request, response, next) => {
  try {
    response.json({ settings: await repository.getWorkspaceSettings(request.workspaceId!) });
  } catch (error) {
    next(error);
  }
});

const settingsSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  logoUrl: z.string().url().refine((value) => value.startsWith('https://'), 'Logo URL must use HTTPS.').nullable().optional(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  notificationSellerEmail: z.string().email().nullable().optional(),
  venmoPaymentUrl: z.string().url().refine((value) => value.startsWith('https://'), 'Venmo URL must use HTTPS.').nullable().optional(),
}).strict();

app.patch('/api/settings', async (request, response, next) => {
  const parsed = settingsSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: 'INVALID_SETTINGS', message: parsed.error.issues[0]?.message ?? 'Check the workspace settings.' });
    return;
  }
  try {
    response.json({ settings: await repository.updateWorkspaceSettings(request.workspaceId!, parsed.data) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/super/overview', async (request, response) => {
  const supplied = request.get('x-super-admin-serial');
  if (!config.superAdminSerial || !supplied || !serialMatches(supplied, config.superAdminSerial)) {
    response.status(403).json({ error: 'OWNER_ACCESS_REQUIRED', message: 'The owner console is reserved for the service owner.' });
    return;
  }
  response.status(501).json({ error: 'OWNER_CONSOLE_NOT_CONFIGURED', message: 'Owner provisioning controls are not enabled in this beta.' });
});

const createInvoiceSchema = z.object({
  orderIds: z.array(z.string().uuid()).min(1).max(200),
  dueDays: z.number().int().min(1).max(90).default(config.stripeDueDays),
}).strict().superRefine((value, context) => {
  if (new Set(value.orderIds).size !== value.orderIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['orderIds'], message: 'Order IDs must be unique.' });
  }
});

app.post('/api/customers/:customerId/invoices', async (request, response, next) => {
  if (!isUuid(request.params.customerId)) {
    response.status(400).json({ error: 'INVALID_CUSTOMER', message: 'That customer identifier is invalid.' });
    return;
  }
  const parsed = createInvoiceSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: 'INVALID_INVOICE', message: parsed.error.issues[0]?.message ?? 'Check the invoice orders.' });
    return;
  }
  const idempotencyKey = request.get('idempotency-key')?.trim() || randomUUID();
  if (idempotencyKey.length > 128) {
    response.status(400).json({ error: 'INVALID_IDEMPOTENCY_KEY', message: 'The invoice request key is too long.' });
    return;
  }
  try {
    const invoice = await repository.createInvoice(
      request.workspaceId!,
      request.params.customerId,
      parsed.data.orderIds,
      parsed.data.dueDays,
      idempotencyKey,
    );
    const profile = await repository.getCustomerBillingProfile(request.workspaceId!, request.params.customerId);
    if (profile) smtpNotifier.enqueueInvoiceGenerated(invoice, profile.gmailAddress);
    response.status(201).json({ invoice });
  } catch (error) {
    if (error instanceof BillingValidationError) {
      response.status(409).json({ error: error.code, message: error.message });
      return;
    }
    next(error);
  }
});

app.post('/api/invoices/:invoiceId/issue', async (request, response, next) => {
  if (!isUuid(request.params.invoiceId)) {
    response.status(400).json({ error: 'INVALID_INVOICE', message: 'That invoice identifier is invalid.' });
    return;
  }
  try {
    const invoice = await repository.getInvoice(request.workspaceId!, request.params.invoiceId);
    if (!invoice) {
      response.status(404).json({ error: 'INVOICE_NOT_FOUND', message: 'Invoice not found.' });
      return;
    }
    if (invoice.status !== 'draft') {
      response.json({ invoice });
      return;
    }
    const profile = await repository.getCustomerBillingProfile(request.workspaceId!, invoice.customerId);
    if (!profile) {
      response.status(404).json({ error: 'CUSTOMER_NOT_FOUND', message: 'Customer not found.' });
      return;
    }
    const dueDays = invoice.dueAt
      ? Math.max(1, Math.ceil((new Date(invoice.dueAt).getTime() - Date.now()) / 86_400_000))
      : config.stripeDueDays;
    const stripeInvoice = await stripeGateway.issueInvoice(profile, invoice, dueDays);
    await repository.setStripeCustomerId(request.workspaceId!, invoice.customerId, stripeInvoice.stripeCustomerId);
    const updated = await repository.updateInvoiceStripeState(request.workspaceId!, invoice.id, {
      status: 'open',
      stripeInvoiceId: stripeInvoice.stripeInvoiceId,
      paymentUrl: stripeInvoice.paymentUrl,
      lastError: null,
    });
    response.json({ invoice: updated ?? invoice });
  } catch (error) {
    if (error instanceof StripeNotConfiguredError) {
      response.status(503).json({ error: 'STRIPE_NOT_CONFIGURED', message: error.message });
      return;
    }
    if (error instanceof StripeBillingError) {
      await repository.updateInvoiceStripeState(request.workspaceId!, request.params.invoiceId, {
        status: 'draft',
        lastError: error.message,
      }).catch(() => undefined);
      response.status(502).json({ error: 'STRIPE_ISSUE_FAILED', message: error.message });
      return;
    }
    next(error);
  }
});

const connectCustomerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  gmailAddress: z.string().trim().toLowerCase().email().refine((value) => value.endsWith('@gmail.com'), 'A Gmail address is required.'),
  appPassword: z.string().transform((value) => value.replace(/\s/g, '')).pipe(z.string().length(16)),
  syncDays: z.number().int().min(30).max(365),
}).strict();

app.post('/api/customers', async (request, response, next) => {
  const parsed = connectCustomerSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: 'INVALID_CUSTOMER', message: parsed.error.issues[0]?.message ?? 'Check the customer details.' });
    return;
  }
  try {
    await verifyGmailConnection(parsed.data.gmailAddress, parsed.data.appPassword);
    const customer = await repository.createCustomer(request.workspaceId!, {
      name: parsed.data.name,
      gmailAddress: parsed.data.gmailAddress,
      syncDays: parsed.data.syncDays,
      secretCiphertext: secretBox.encrypt(parsed.data.appPassword),
    });
    syncCoordinator.enqueue(customer.id);
    response.status(201).json({ customer });
  } catch (error) {
    if (isPostgresUniqueViolation(error)) {
      response.status(409).json({ error: 'MAILBOX_EXISTS', message: 'That Gmail inbox is already connected.' });
      return;
    }
    if (error instanceof Error && /Gmail|app password/i.test(error.message)) {
      response.status(422).json({ error: 'GMAIL_CONNECTION_FAILED', message: error.message });
      return;
    }
    next(error);
  }
});

app.post('/api/customers/:customerId/sync', async (request, response) => {
  const mailbox = await repository.getMailbox(request.workspaceId!, request.params.customerId);
  if (!mailbox) {
    response.status(404).json({ error: 'CUSTOMER_NOT_FOUND', message: 'Customer not found.' });
    return;
  }
  // A manual sync is an intentional repair/backfill operation. It scans the
  // customer's configured history so new item/cancellation parsers can repair
  // messages that were previously marked as processed.
  syncCoordinator.enqueue(request.params.customerId, { fullHistory: true });
  response.status(202).json({ accepted: true });
});

app.post('/api/customers/:customerId/portal-link', async (request, response, next) => {
  try {
    const customer = await repository.customerPortal(request.workspaceId!, request.params.customerId);
    if (!customer) {
      response.status(404).json({ error: 'CUSTOMER_NOT_FOUND', message: 'Customer not found.' });
      return;
    }
    const issued = await repository.getOrCreatePortalToken(request.workspaceId!, request.params.customerId, secretBox);
    if (!issued) {
      response.status(404).json({ error: 'CUSTOMER_NOT_FOUND', message: 'Customer not found.' });
      return;
    }
    response.json({ url: `${config.appOrigin}/portal/${issued.token}`, createdAt: issued.createdAt });
  } catch (error) {
    next(error);
  }
});

const feePercentSchema = z.number().finite().min(0).max(100);
const orderFeeSchema = z.discriminatedUnion('feeBasis', [
  z.object({
    feePercent: feePercentSchema,
    feeBasis: z.literal('checkout_total'),
  }).strict(),
  z.object({
    feePercent: feePercentSchema,
    feeBasis: z.literal('custom_amount'),
    customBasisCents: z.number().int().min(0).max(2_147_483_647),
  }).strict(),
]);

app.patch('/api/orders/:orderId/fee', async (request, response, next) => {
  const parsed = orderFeeSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: 'INVALID_FEE', message: 'Fee must be a number between 0% and 100%.' });
    return;
  }
  if (!isUuid(request.params.orderId)) {
    response.status(400).json({ error: 'INVALID_ORDER', message: 'That order identifier is invalid.' });
    return;
  }
  try {
    const fee = await repository.updateOrderFee(
      request.workspaceId!,
      request.params.orderId,
      Math.round(parsed.data.feePercent * 100),
      parsed.data.feeBasis,
      parsed.data.feeBasis === 'custom_amount' ? parsed.data.customBasisCents : null,
    );
    if (!fee) {
      response.status(404).json({ error: 'ORDER_NOT_FOUND', message: 'Order not found.' });
      return;
    }
    response.json(fee);
  } catch (error) {
    if (error instanceof OrderBillingLockedError) {
      response.status(409).json({ error: 'ORDER_BILLING_LOCKED', message: error.message });
      return;
    }
    if (error instanceof BillingValidationError) {
      response.status(409).json({ error: error.code, message: error.message });
      return;
    }
    next(error);
  }
});

const orderOverrideSchema = z.object({
  status: z.enum(['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled']).nullable(),
  note: z.string().trim().max(240).optional().nullable(),
}).strict();

app.patch('/api/orders/:orderId/override', async (request, response, next) => {
  const parsed = orderOverrideSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: 'INVALID_OVERRIDE', message: parsed.error.issues[0]?.message ?? 'Check the manual order status.' });
    return;
  }
  if (!isUuid(request.params.orderId)) {
    response.status(400).json({ error: 'INVALID_ORDER', message: 'That order identifier is invalid.' });
    return;
  }
  try {
    const override = await repository.updateOrderOverride(
      request.workspaceId!,
      request.params.orderId,
      parsed.data.status,
      parsed.data.note ?? null,
    );
    if (!override) {
      response.status(404).json({ error: 'ORDER_NOT_FOUND', message: 'Order not found.' });
      return;
    }
    response.json(override);
  } catch (error) {
    next(error);
  }
});

const serverDirectory = dirname(fileURLToPath(import.meta.url));
const distDirectory = join(serverDirectory, '..', 'dist');
if (existsSync(distDirectory)) {
  app.use(express.static(distDirectory, { index: false, maxAge: config.nodeEnv === 'production' ? '1h' : 0 }));
  app.use((request, response, next) => {
    if (request.method === 'GET' && request.accepts('html')) {
      response.sendFile(join(distDirectory, 'index.html'));
      return;
    }
    next();
  });
}

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  const requestId = randomUUID();
  console.error(`[api] request=${requestId}`, error instanceof Error ? error.message : 'Unknown error');
  response.status(500).json({ error: 'INTERNAL_ERROR', message: `The request could not be completed. Reference ${requestId}.` });
});

const server = app.listen(config.port, '0.0.0.0', () => {
  console.info(`ACO Studio listening on port ${config.port}.`);
});

const shutdown = async () => {
  syncCoordinator.stopPolling();
  trackingCoordinator.stopPolling();
  server.close();
  await repository.close();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

async function applyStripeEvent(event: { type: string; data: { object: unknown } }) {
  const object = event.data.object as {
    id?: unknown;
    metadata?: Record<string, string | undefined>;
    hosted_invoice_url?: unknown;
    status_transitions?: { paid_at?: number | null };
  };
  const stripeInvoiceId = typeof object.id === 'string' ? object.id : null;
  const internalInvoiceId = typeof object.metadata?.aco_invoice_id === 'string' ? object.metadata.aco_invoice_id : null;
  const invoice = internalInvoiceId
    ? await repository.getInvoice(workspaceId, internalInvoiceId)
    : stripeInvoiceId
      ? await repository.findInvoiceByStripeId(workspaceId, stripeInvoiceId)
      : null;
  if (!invoice) return;
  const wasAlreadyPaid = invoice.status === 'paid';

  const status = event.type === 'invoice.paid'
    ? 'paid'
    : event.type === 'invoice.voided'
      ? 'void'
      : event.type === 'invoice.marked_uncollectible'
        ? 'uncollectible'
        : 'open';
  const paidAt = status === 'paid'
    ? (typeof object.status_transitions?.paid_at === 'number'
      ? new Date(object.status_transitions.paid_at * 1000)
      : new Date())
    : null;
  const updated = await repository.updateInvoiceStripeState(workspaceId, invoice.id, {
    status,
    stripeInvoiceId: stripeInvoiceId ?? undefined,
    paymentUrl: typeof object.hosted_invoice_url === 'string' ? object.hosted_invoice_url : undefined,
    paidAt,
    lastError: event.type === 'invoice.payment_failed' ? 'Stripe reported a payment failure.' : null,
  });
  if (status === 'paid' && updated && !wasAlreadyPaid) {
    const profile = await repository.getCustomerBillingProfile(workspaceId, invoice.customerId);
    const settings = await repository.getWorkspaceSettings(workspaceId);
    if (profile) smtpNotifier.enqueueInvoicePaid(updated, profile.gmailAddress, settings.notificationSellerEmail ?? config.notificationSellerEmail);
  }
}

function isPostgresUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505');
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
