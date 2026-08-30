import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg, { type PoolClient } from 'pg';
import type { ParsedOrderEmail, ParsedOrderItem, ParsedOrderStatus } from '../email/parser.js';
import { SecretBox } from '../security/secret-box.js';
import type { TrackingSnapshot } from '../tracking/providers.js';
import type { WorkspaceTheme } from '../../src/lib/themes.js';

const { Pool } = pg;

export type FeeBasis = 'checkout_total' | 'custom_amount';

export interface WorkspaceRecord {
  id: string;
  slug: string;
  name: string;
  nodeGroupKey: string;
  status: 'provisioning' | 'active' | 'suspended';
  settings: WorkspaceSettingsRecord;
}

export interface WorkspaceSettingsRecord {
  theme: WorkspaceTheme;
  displayName: string;
  logoUrl: string | null;
  accentColor: string;
  notificationSellerEmail: string | null;
  venmoPaymentUrl: string | null;
}

export interface CustomerRecord {
  id: string;
  name: string;
  emailMasked: string;
  syncStatus: 'synced' | 'syncing' | 'warning' | 'error';
  lastSyncedAt: string | null;
  syncMessage: string | null;
}

export interface MailboxRecord {
  customerId: string;
  gmailAddress: string;
  secretCiphertext: string;
  syncDays: number;
  lastSyncedAt: Date | null;
}

export interface ProcessedMessageMeta {
  messageKey: string;
  fromAddress: string;
  subject: string;
  receivedAt: Date;
}

export interface OrderFeeRecord {
  orderId: string;
  feePercent: number;
  feeBasis: FeeBasis;
  feeBasisCents: number | null;
  feeCents: number | null;
}

export interface OrderOverrideRecord {
  orderId: string;
  status: ParsedOrderStatus | null;
  isManualOverride: boolean;
  overrideNote: string | null;
}

export interface InvoiceLineRecord {
  id: string;
  orderId: string;
  description: string;
  subtotalCents: number;
  feePercent: number;
  feeBasis: FeeBasis;
  feeBasisCents: number;
  feeCents: number;
  totalCents: number;
  currency: string;
}

export interface InvoiceRecord {
  id: string;
  workspaceId: string;
  companyName: string | null;
  customerId: string;
  invoiceNumber: string;
  billingModel: 'legacy_order_plus_fee' | 'service_fee_only';
  status: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';
  currency: string;
  subtotalCents: number;
  feeCents: number;
  totalCents: number;
  dueAt: string | null;
  createdAt: string;
  paidAt: string | null;
  paymentUrl: string | null;
  lastError: string | null;
  lines: InvoiceLineRecord[];
}

export interface CustomerBillingProfile {
  id: string;
  name: string;
  gmailAddress: string;
  stripeCustomerId: string | null;
}

export interface ActiveShipmentRecord {
  id: string;
  customerId: string;
  orderId: string;
  carrier: string | null;
  trackingNumber: string;
  trackingUrl: string | null;
  status: ParsedOrderStatus;
}

export class BillingValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export class OrderBillingLockedError extends Error {
  constructor() {
    super('This order is already on an issued invoice. Create a credit or void the invoice before changing its fee.');
  }
}

export class Repository {
  readonly pool: pg.Pool;

  constructor(databaseUrl: string, production = false) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      ssl: production ? { rejectUnauthorized: false } : undefined,
      max: 10,
      idleTimeoutMillis: 30_000,
    });
  }

  async close() {
    await this.pool.end();
  }

  async ensureWorkspace(slug: string, name: string): Promise<string> {
    const id = randomUUID();
    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO workspaces(id, slug, name, node_group_key, status)
       VALUES ($1, $2, $3, $2, 'active')
       ON CONFLICT (slug) DO UPDATE SET
         node_group_key = COALESCE(workspaces.node_group_key, EXCLUDED.node_group_key),
         updated_at = now()
       RETURNING id`,
      [id, slug, name],
    );
    await this.withWorkspace(inserted.rows[0].id, async (client) => {
      await client.query(`
        INSERT INTO workspace_settings(workspace_id, display_name)
        VALUES ($1, $2)
        ON CONFLICT (workspace_id) DO NOTHING
      `, [inserted.rows[0].id, name]);
    });
    return inserted.rows[0].id;
  }

  async listActiveWorkspaceIds(): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>("SELECT id FROM workspaces WHERE status = 'active'");
    return result.rows.map((row) => row.id);
  }

  async findWorkspaceIdBySlug(slug: string): Promise<string | null> {
    const result = await this.pool.query<{ id: string }>('SELECT id FROM workspaces WHERE slug = $1', [slug]);
    return result.rows[0]?.id ?? null;
  }

  async createWorkspace(slug: string, name: string, passwordHash: string): Promise<string> {
    const id = randomUUID();
    return this.withWorkspace(id, async (client) => {
      // INSERT only: knowing an existing slug can never claim that workspace.
      await client.query(`INSERT INTO workspaces(id, slug, name, node_group_key, status)
        VALUES ($1, $2, $3, $2, 'active')`, [id, slug, name]);
      await client.query('INSERT INTO workspace_settings(workspace_id, display_name) VALUES ($1, $2)', [id, name]);
      await client.query('INSERT INTO workspace_credentials(workspace_id, password_hash) VALUES ($1, $2)', [id, passwordHash]);
      return id;
    });
  }

  async bootstrapPassword(workspaceId: string, passwordHash: string): Promise<void> {
    await this.withWorkspace(workspaceId, async (client) => {
      await client.query(`INSERT INTO workspace_credentials(workspace_id, password_hash) VALUES ($1, $2)
        ON CONFLICT (workspace_id) DO NOTHING`, [workspaceId, passwordHash]);
    });
  }

  async credentialsForSlug(slug: string) {
    const result = await this.pool.query<{ id: string }>("SELECT id FROM workspaces WHERE slug = $1 AND status = 'active'", [slug]);
    if (!result.rows[0]) return null;
    const workspaceId = result.rows[0].id;
    const credentials = await this.getCredentials(workspaceId);
    return credentials ? { workspaceId, ...credentials } : null;
  }

  async getCredentials(workspaceId: string) {
    return this.withWorkspace(workspaceId, async (client) => {
      const result = await client.query<{ password_hash: string; session_version: number }>(`
        SELECT c.password_hash, c.session_version FROM workspace_credentials c
        JOIN workspaces w ON w.id = c.workspace_id
        WHERE c.workspace_id = $1 AND w.status = 'active'`, [workspaceId]);
      return result.rows[0] ?? null;
    });
  }

  async changePassword(workspaceId: string, previousHash: string, passwordHash: string): Promise<number | null> {
    return this.withWorkspace(workspaceId, async (client) => {
      const result = await client.query<{ session_version: number }>(`
        UPDATE workspace_credentials SET password_hash = $3, session_version = session_version + 1, updated_at = now()
        WHERE workspace_id = $1 AND password_hash = $2 RETURNING session_version`, [workspaceId, previousHash, passwordHash]);
      return result.rows[0]?.session_version ?? null;
    });
  }

  async dashboard(workspaceId: string) {
    return this.withWorkspace(workspaceId, async (client) => {
      const workspaceResult = await client.query<{
        id: string;
        slug: string;
        name: string;
        node_group_key: string;
        status: WorkspaceRecord['status'];
      }>(`
        SELECT id, slug, name, node_group_key, status
        FROM workspaces
        WHERE id = $1
      `, [workspaceId]);
      const workspace = workspaceResult.rows[0];
      if (!workspace) throw new Error('Workspace not found.');
      const settingsResult = await client.query<{
        theme: WorkspaceTheme;
        display_name: string;
        logo_url: string | null;
        accent_color: string;
        notification_seller_email: string | null;
        venmo_payment_url: string | null;
      }>(`
        SELECT theme, display_name, logo_url, accent_color, notification_seller_email, venmo_payment_url
        FROM workspace_settings WHERE workspace_id = $1
      `, [workspaceId]);
      const settings = settingsResult.rows[0] ?? {
        theme: 'classic-light' as const,
        display_name: workspace.name,
        logo_url: null,
        accent_color: '#1463f3',
        notification_seller_email: null,
        venmo_payment_url: null,
      };

      const customersResult = await client.query<{
        id: string;
        display_name: string;
        gmail_address: string;
        sync_status: CustomerRecord['syncStatus'];
        last_synced_at: Date | null;
        last_sync_error: string | null;
      }>(`
        SELECT id, display_name, gmail_address, sync_status, last_synced_at, last_sync_error
        FROM customers
        WHERE workspace_id = $1
        ORDER BY created_at ASC
      `, [workspaceId]);

      const ordersResult = await client.query<{
        id: string;
        customer_id: string;
        merchant: string;
        order_number: string;
        ordered_at: Date;
        total_cents: number | null;
        fee_basis_points: number;
        fee_basis: FeeBasis;
        custom_fee_basis_cents: number | null;
        item_count: number | null;
        items: unknown;
        currency: string;
        status: ParsedOrderStatus;
        status_override: ParsedOrderStatus | null;
        override_note: string | null;
        override_updated_at: Date | null;
        billing_invoice_id: string | null;
        billing_status: InvoiceRecord['status'] | null;
        carrier: string | null;
        tracking_number: string | null;
        tracking_url: string | null;
        expected_delivery: Date | null;
      }>(`
        SELECT o.id, o.customer_id, o.merchant, o.order_number, o.ordered_at,
               o.total_cents, o.fee_basis_points, o.fee_basis, o.custom_fee_basis_cents,
               o.item_count, o.items, o.currency, o.status,
               o.status_override, o.override_note, o.override_updated_at, o.billing_invoice_id,
               i.status AS billing_status,
               s.carrier, s.tracking_number, s.tracking_url, s.expected_delivery
        FROM orders o
        LEFT JOIN invoices i
          ON i.workspace_id = o.workspace_id AND i.id = o.billing_invoice_id
        LEFT JOIN shipments s
          ON s.workspace_id = o.workspace_id AND s.customer_id = o.customer_id AND s.order_id = o.id
        -- Order identifiers accepted by the parser contain at least one
        -- digit. Keep legacy prose artifacts out of operator/customer views
        -- without deleting historical rows.
        WHERE o.workspace_id = $1
          AND o.order_number ~ '[0-9]'
        ORDER BY o.ordered_at DESC
        LIMIT 2000
      `, [workspaceId]);

      const orderIds = ordersResult.rows.map((order) => order.id);
      const eventsResult = orderIds.length === 0
        ? { rows: [] as Array<{ id: string; order_id: string; status: ParsedOrderStatus; label: string; detail: string; occurred_at: Date }> }
        : await client.query<{
          id: string;
          order_id: string;
          status: ParsedOrderStatus;
          label: string;
          detail: string;
          occurred_at: Date;
        }>(`
          SELECT id, order_id, status, label, detail, occurred_at
          FROM order_events
          WHERE workspace_id = $1 AND order_id = ANY($2::uuid[])
          ORDER BY occurred_at ASC
        `, [workspaceId, orderIds]);

      const eventsByOrder = new Map<string, typeof eventsResult.rows>();
      for (const event of eventsResult.rows) {
        const events = eventsByOrder.get(event.order_id) ?? [];
        events.push(event);
        eventsByOrder.set(event.order_id, events);
      }

      return {
        workspace: {
          id: workspace.id,
          slug: workspace.slug,
          name: workspace.name,
          nodeGroupKey: workspace.node_group_key,
          status: workspace.status,
          settings: toWorkspaceSettings(settings),
        },
        customers: customersResult.rows.map((customer) => ({
          id: customer.id,
          name: customer.display_name,
          emailMasked: maskEmail(customer.gmail_address),
          syncStatus: customer.sync_status,
          lastSyncedAt: customer.last_synced_at?.toISOString() ?? null,
          syncMessage: customer.last_sync_error,
        })),
        orders: ordersResult.rows.map((order) => {
          const effectiveStatus = order.status_override ?? order.status;
          const feeBasisCents = resolveFeeBasisCents(
            order.total_cents,
            order.fee_basis,
            order.custom_fee_basis_cents,
          );
          const events = (eventsByOrder.get(order.id) ?? []).map((event) => ({
            id: event.id,
            status: event.status,
            label: event.label,
            detail: event.detail,
            occurredAt: event.occurred_at.toISOString(),
          }));
          if (order.status_override && order.override_updated_at) {
            events.push({
              id: `manual-${order.id}-${order.override_updated_at.getTime()}`,
              status: effectiveStatus,
              label: 'Manual status update',
              detail: order.override_note || 'Status updated by the ACO operator.',
              occurredAt: order.override_updated_at.toISOString(),
            });
            events.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
          }
          return {
            id: order.id,
            customerId: order.customer_id,
            store: order.merchant,
            orderNumber: order.order_number,
            orderedAt: order.ordered_at.toISOString(),
            totalCents: order.total_cents,
            feePercent: order.fee_basis_points / 100,
            feeBasis: order.fee_basis,
            customBasisCents: order.custom_fee_basis_cents,
            feeBasisCents,
            feeCents: calculateFeeCents(feeBasisCents, order.fee_basis_points),
            billingStatus: order.billing_status ?? 'unbilled',
            invoiceId: order.billing_invoice_id,
            isManualOverride: Boolean(order.status_override),
            overrideNote: order.override_note,
            itemCount: order.item_count,
            items: normalizeStoredOrderItems(order.items),
            currency: order.currency.trim(),
            status: effectiveStatus,
            carrier: order.carrier,
            trackingNumber: order.tracking_number,
            trackingUrl: order.tracking_url,
            expectedDelivery: order.expected_delivery?.toISOString() ?? null,
            events,
          };
        }),
      };
    });
  }

  async billing(workspaceId: string, customerId?: string): Promise<{ invoices: InvoiceRecord[] }> {
    return this.withWorkspace(workspaceId, async (client) => ({
      invoices: await this.loadInvoices(client, workspaceId, customerId),
    }));
  }

  async customerPortal(workspaceId: string, customerId: string) {
    const payload = await this.dashboard(workspaceId);
    const customer = payload.customers.find((candidate) => candidate.id === customerId);
    if (!customer) return null;
    const billing = await this.billing(workspaceId, customerId);
    return {
      customer: { id: customer.id, name: customer.name },
      workspace: payload.workspace,
      orders: payload.orders.filter((order) => order.customerId === customerId),
      invoices: billing.invoices.map((invoice) => ({ ...invoice, lastError: null })),
    };
  }

  async listActiveShipments(workspaceId: string, limit = 100): Promise<ActiveShipmentRecord[]> {
    return this.withWorkspace(workspaceId, async (client) => {
      const result = await client.query<{
        id: string;
        customer_id: string;
        order_id: string;
        carrier: string | null;
        tracking_number: string;
        tracking_url: string | null;
        status: ParsedOrderStatus;
      }>(`
        SELECT id, customer_id, order_id, carrier, tracking_number, tracking_url, status
        FROM shipments
        WHERE workspace_id = $1
          AND tracking_number IS NOT NULL
          AND status NOT IN ('delivered', 'cancelled')
        ORDER BY updated_at ASC
        LIMIT $2
      `, [workspaceId, Math.max(1, Math.min(1000, Math.floor(limit)))]);
      return result.rows.map((row) => ({
        id: row.id,
        customerId: row.customer_id,
        orderId: row.order_id,
        carrier: row.carrier,
        trackingNumber: row.tracking_number,
        trackingUrl: row.tracking_url,
        status: row.status,
      }));
    });
  }

  async updateShipmentFromCarrier(
    workspaceId: string,
    shipment: ActiveShipmentRecord,
    snapshot: TrackingSnapshot,
  ): Promise<boolean> {
    return this.withWorkspace(workspaceId, async (client) => {
      const updatedShipment = await client.query<{ order_id: string }>(`
        UPDATE shipments
        SET carrier = COALESCE($5, carrier),
            tracking_url = COALESCE($6, tracking_url),
            status = CASE WHEN status_rank($7) >= status_rank(status) THEN $7 ELSE status END,
            expected_delivery = COALESCE($8, expected_delivery),
            delivered_at = COALESCE($9, delivered_at),
            updated_at = now()
        WHERE workspace_id = $1 AND customer_id = $2 AND order_id = $3 AND id = $4
        RETURNING order_id
      `, [
        workspaceId,
        shipment.customerId,
        shipment.orderId,
        shipment.id,
        snapshot.carrier,
        snapshot.trackingUrl,
        snapshot.status,
        snapshot.expectedDelivery,
        snapshot.deliveredAt,
      ]);
      if (updatedShipment.rowCount === 0) return false;

      await client.query(`
        UPDATE orders
        SET status = CASE WHEN status_rank($4) >= status_rank(status) THEN $4 ELSE status END,
            updated_at = now()
        WHERE workspace_id = $1 AND customer_id = $2 AND id = $3
      `, [workspaceId, shipment.customerId, shipment.orderId, snapshot.status]);

      const eventCopy = statusCopy(snapshot.status, snapshot.carrier);
      await client.query(`
        INSERT INTO order_events(
          id, workspace_id, customer_id, order_id, status, label, detail, occurred_at, source_message_key
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (workspace_id, order_id, status, source_message_key) DO NOTHING
      `, [
        randomUUID(), workspaceId, shipment.customerId, shipment.orderId, snapshot.status,
        eventCopy.label, eventCopy.detail, snapshot.deliveredAt ?? new Date(),
        `carrier:${snapshot.carrier.toLowerCase()}:${snapshot.trackingNumber}:${snapshot.status}`,
      ]);
      return true;
    });
  }

  async getOrCreatePortalToken(workspaceId: string, customerId: string, secretBox: SecretBox) {
    return this.withWorkspace(workspaceId, async (client) => {
      const current = await client.query<{ token_hash: string | null; token_ciphertext: string | null; token_created_at: Date | null }>(`
        SELECT portal_token_hash AS token_hash, portal_token_ciphertext, portal_token_created_at
        FROM customers WHERE workspace_id = $1 AND id = $2
        FOR UPDATE
      `, [workspaceId, customerId]);
      const row = current.rows[0];
      if (!row) return null;
      if (row.token_ciphertext) {
        try {
          const token = secretBox.decrypt(row.token_ciphertext);
          const tokenHash = hashPortalToken(token);
          if (row.token_hash !== tokenHash) {
            await client.query(`UPDATE customers SET portal_token_hash = $3, updated_at = now() WHERE workspace_id = $1 AND id = $2`, [workspaceId, customerId, tokenHash]);
          }
          return {
            token,
            createdAt: row.token_created_at?.toISOString() ?? new Date().toISOString(),
          };
        } catch {
          // A key rotation or corrupted envelope should issue a fresh link.
        }
      }
      const token = randomBytes(32).toString('base64url');
      await client.query(`
        UPDATE customers
        SET portal_token_hash = $3,
            portal_token_ciphertext = $4,
            portal_token_created_at = now(),
            updated_at = now()
        WHERE workspace_id = $1 AND id = $2
      `, [workspaceId, customerId, hashPortalToken(token), secretBox.encrypt(token)]);
      return { token, createdAt: new Date().toISOString() };
    });
  }

  async customerPortalByStaticToken(token: string) {
    const tokenHash = hashPortalToken(token);
    const workspaces = await this.pool.query<{ id: string }>('SELECT id FROM workspaces');
    for (const workspace of workspaces.rows) {
      const customer = await this.withWorkspace(workspace.id, async (client) => {
        const result = await client.query<{ id: string }>(`
          SELECT id FROM customers WHERE workspace_id = $1 AND portal_token_hash = $2
        `, [workspace.id, tokenHash]);
        return result.rows[0] ?? null;
      });
      if (customer) return this.customerPortal(workspace.id, customer.id);
    }
    return null;
  }

  async getWorkspaceSettings(workspaceId: string): Promise<WorkspaceSettingsRecord> {
    return this.withWorkspace(workspaceId, async (client) => {
      await client.query(`INSERT INTO workspace_settings(workspace_id, display_name)
        SELECT id, name FROM workspaces WHERE id = $1 ON CONFLICT DO NOTHING`, [workspaceId]);
      const result = await client.query(`SELECT theme, display_name, logo_url, accent_color,
        notification_seller_email, venmo_payment_url FROM workspace_settings WHERE workspace_id = $1`, [workspaceId]);
      if (!result.rows[0]) throw new Error('Workspace not found.');
      return toWorkspaceSettings(result.rows[0]);
    });
  }

  async updateWorkspaceSettings(workspaceId: string, input: Partial<WorkspaceSettingsRecord>): Promise<WorkspaceSettingsRecord> {
    return this.withWorkspace(workspaceId, async (client) => {
      // Lock and merge so a theme-only PATCH never clears payment or notification settings.
      const current = await client.query(`SELECT theme, display_name, logo_url, accent_color,
        notification_seller_email, venmo_payment_url FROM workspace_settings WHERE workspace_id = $1 FOR UPDATE`, [workspaceId]);
      if (!current.rows[0]) throw new Error('Workspace settings not found.');
      const next = { ...toWorkspaceSettings(current.rows[0]), ...input };
      await client.query(`UPDATE workspace_settings SET display_name = $2, theme = $3, logo_url = $4,
        accent_color = $5, notification_seller_email = $6, venmo_payment_url = $7, updated_at = now()
        WHERE workspace_id = $1`, [workspaceId, next.displayName, next.theme, next.logoUrl,
        next.accentColor, next.notificationSellerEmail, next.venmoPaymentUrl]);
      await client.query('UPDATE workspaces SET name = $2, updated_at = now() WHERE id = $1', [workspaceId, next.displayName]);
      return next;
    });
  }

  async getCustomerBillingProfile(workspaceId: string, customerId: string): Promise<CustomerBillingProfile | null> {
    return this.withWorkspace(workspaceId, async (client) => {
      const result = await client.query<{
        id: string;
        display_name: string;
        gmail_address: string;
        stripe_customer_id: string | null;
      }>(`
        SELECT id, display_name, gmail_address, stripe_customer_id
        FROM customers
        WHERE workspace_id = $1 AND id = $2
      `, [workspaceId, customerId]);
      const row = result.rows[0];
      return row ? {
        id: row.id,
        name: row.display_name,
        gmailAddress: row.gmail_address,
        stripeCustomerId: row.stripe_customer_id,
      } : null;
    });
  }

  async setStripeCustomerId(workspaceId: string, customerId: string, stripeCustomerId: string): Promise<void> {
    await this.withWorkspace(workspaceId, async (client) => {
      await client.query(`
        UPDATE customers
        SET stripe_customer_id = $3, updated_at = now()
        WHERE workspace_id = $1 AND id = $2
      `, [workspaceId, customerId, stripeCustomerId]);
    });
  }

  async createInvoice(
    workspaceId: string,
    customerId: string,
    orderIds: string[],
    dueDays: number,
    idempotencyKey: string,
  ): Promise<InvoiceRecord> {
    return this.withWorkspace(workspaceId, async (client) => {
      const existing = await client.query<{ id: string; customer_id: string }>(`
        SELECT id, customer_id FROM invoices
        WHERE workspace_id = $1 AND idempotency_key = $2
      `, [workspaceId, idempotencyKey]);
      if (existing.rows[0]) {
        if (existing.rows[0].customer_id !== customerId) {
          throw new BillingValidationError('IDEMPOTENCY_KEY_REUSED', 'That invoice request key is already associated with another customer.');
        }
        const invoice = (await this.loadInvoices(client, workspaceId, customerId, existing.rows[0].id))[0];
        if (invoice) return invoice;
      }

      if (orderIds.length === 0) {
        throw new BillingValidationError('NO_BILLABLE_ORDERS', 'Select at least one unbilled order with a service-fee basis before creating an invoice.');
      }

      const ordersResult = await client.query<{
        id: string;
        merchant: string;
        order_number: string;
        total_cents: number | null;
        fee_basis_points: number;
        fee_basis: FeeBasis;
        custom_fee_basis_cents: number | null;
        currency: string;
      }>(`
        SELECT o.id, o.merchant, o.order_number, o.total_cents, o.fee_basis_points,
               o.fee_basis, o.custom_fee_basis_cents, o.currency
        FROM orders o
        WHERE o.workspace_id = $1
          AND o.customer_id = $2
          AND o.id = ANY($3::uuid[])
          AND o.order_number ~ '[0-9]'
          AND o.billing_invoice_id IS NULL
          AND COALESCE(o.status_override, o.status) <> 'cancelled'
          AND (o.total_cents IS NOT NULL OR (o.fee_basis = 'custom_amount' AND o.custom_fee_basis_cents IS NOT NULL))
        ORDER BY o.ordered_at ASC
        FOR UPDATE
      `, [workspaceId, customerId, orderIds]);

      if (ordersResult.rows.length !== orderIds.length) {
        // A concurrent retry can observe the selected orders after the first
        // request has committed. Re-check the idempotency key before treating
        // that normal race as a billing conflict.
        const retryExisting = await client.query<{ id: string; customer_id: string }>(`
          SELECT id, customer_id FROM invoices
          WHERE workspace_id = $1 AND idempotency_key = $2
        `, [workspaceId, idempotencyKey]);
        if (retryExisting.rows[0]) {
          if (retryExisting.rows[0].customer_id !== customerId) {
            throw new BillingValidationError('IDEMPOTENCY_KEY_REUSED', 'That invoice request key is already associated with another customer.');
          }
          const invoice = (await this.loadInvoices(client, workspaceId, customerId, retryExisting.rows[0].id))[0];
          if (invoice) return invoice;
        }
        throw new BillingValidationError('ORDER_NOT_BILLABLE', 'One or more selected orders are already invoiced, cancelled, missing a total, or outside this customer. Refresh and try again.');
      }

      const currencies = new Set(ordersResult.rows.map((order) => order.currency.trim()));
      if (currencies.size !== 1) {
        throw new BillingValidationError('MIXED_CURRENCIES', 'An invoice can only contain orders in one currency.');
      }

      const lines = ordersResult.rows.map((order) => {
        const subtotalCents = order.total_cents ?? 0;
        const feeBasisCents = resolveFeeBasisCents(order.total_cents, order.fee_basis, order.custom_fee_basis_cents);
        if (feeBasisCents === null) {
          throw new BillingValidationError('FEE_BASIS_UNAVAILABLE', 'One or more selected orders is missing its fee basis amount.');
        }
        const feeCents = calculateFeeCents(feeBasisCents, order.fee_basis_points) ?? 0;
        return {
          orderId: order.id,
          description: `${order.merchant} · Order ${order.order_number}`,
          subtotalCents,
          feeBasisPoints: order.fee_basis_points,
          feeBasis: order.fee_basis,
          feeBasisCents,
          feeCents,
          totalCents: feeCents,
          currency: order.currency.trim(),
        };
      });
      if (lines.some((line) => line.feeCents <= 0)) {
        throw new BillingValidationError('NO_SERVICE_FEES', 'Selected orders must each have a positive service fee to invoice.');
      }
      const subtotalCents = lines.reduce((sum, line) => sum + line.subtotalCents, 0);
      const feeCents = lines.reduce((sum, line) => sum + line.feeCents, 0);
      const invoiceId = randomUUID();
      const invoiceNumber = `INV-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`;
      await client.query(`
        INSERT INTO invoices(
          id, workspace_id, customer_id, invoice_number, idempotency_key, status,
          billing_model, currency, subtotal_cents, fee_cents, total_cents, due_at
        ) VALUES ($1, $2, $3, $4, $5, 'draft', 'service_fee_only', $6, $7, $8, $8, $9)
      `, [
        invoiceId, workspaceId, customerId, invoiceNumber, idempotencyKey,
        lines[0].currency, subtotalCents, feeCents,
        new Date(Date.now() + dueDays * 86_400_000),
      ]);
      for (const line of lines) {
        await client.query(`
          INSERT INTO invoice_lines(
            id, workspace_id, customer_id, invoice_id, order_id, description,
            billing_model, subtotal_cents, fee_basis_points, fee_basis, fee_basis_cents,
            fee_cents, total_cents, currency
          ) VALUES ($1, $2, $3, $4, $5, $6, 'service_fee_only', $7, $8, $9, $10, $11, $11, $12)
        `, [
          randomUUID(), workspaceId, customerId, invoiceId, line.orderId, line.description,
          line.subtotalCents, line.feeBasisPoints, line.feeBasis, line.feeBasisCents,
          line.feeCents, line.currency,
        ]);
      }
      await client.query(`
        UPDATE orders
        SET billing_invoice_id = $3, updated_at = now()
        WHERE workspace_id = $1 AND customer_id = $2 AND id = ANY($4::uuid[])
      `, [workspaceId, customerId, invoiceId, orderIds]);
      return (await this.loadInvoices(client, workspaceId, customerId, invoiceId))[0];
    });
  }

  async updateInvoiceStripeState(
    workspaceId: string,
    invoiceId: string,
    update: { status: InvoiceRecord['status']; companyName?: string | null; stripeInvoiceId?: string; paymentUrl?: string | null; paidAt?: Date | null; lastError?: string | null },
  ): Promise<InvoiceRecord | null> {
    return this.withWorkspace(workspaceId, async (client) => {
      const result = await client.query<{ id: string }>(`
        UPDATE invoices
        SET status = $3,
            company_name = CASE WHEN status = 'draft' AND $3 <> 'draft' THEN COALESCE($8, (SELECT display_name FROM workspace_settings WHERE workspace_id = $1)) ELSE company_name END,
            stripe_invoice_id = COALESCE($4, stripe_invoice_id),
            hosted_invoice_url = COALESCE($5, hosted_invoice_url),
            paid_at = COALESCE($6, paid_at),
            last_error = $7,
            updated_at = now()
        WHERE workspace_id = $1 AND id = $2
        RETURNING id
      `, [workspaceId, invoiceId, update.status, update.stripeInvoiceId ?? null, update.paymentUrl ?? null, update.paidAt ?? null, update.lastError ?? null, update.companyName ?? null]);
      if (!result.rows[0]) return null;
      return (await this.loadInvoices(client, workspaceId, undefined, invoiceId))[0] ?? null;
    });
  }

  async recordStripeEvent(workspaceId: string, eventId: string, eventType: string): Promise<boolean> {
    return this.withWorkspace(workspaceId, async (client) => {
      const result = await client.query(`
        INSERT INTO stripe_events(id, workspace_id, event_type)
        VALUES ($1, $2, $3)
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `, [eventId, workspaceId, eventType]);
      return result.rowCount !== 0;
    });
  }

  async findInvoiceByStripeId(workspaceId: string, stripeInvoiceId: string): Promise<InvoiceRecord | null> {
    return this.withWorkspace(workspaceId, async (client) => {
      return (await this.loadInvoices(client, workspaceId, undefined, undefined, stripeInvoiceId))[0] ?? null;
    });
  }

  async getInvoice(workspaceId: string, invoiceId: string): Promise<InvoiceRecord | null> {
    return this.withWorkspace(workspaceId, async (client) => {
      return (await this.loadInvoices(client, workspaceId, undefined, invoiceId))[0] ?? null;
    });
  }

  async updateOrderFee(
    workspaceId: string,
    orderId: string,
    feeBasisPoints: number,
    feeBasis: FeeBasis,
    customFeeBasisCents: number | null,
  ): Promise<OrderFeeRecord | null> {
    return this.withWorkspace(workspaceId, async (client) => {
      const current = await client.query<{
        id: string;
        total_cents: number | null;
        fee_basis_points: number;
        fee_basis: FeeBasis;
        custom_fee_basis_cents: number | null;
        billing_invoice_id: string | null;
        billing_status: InvoiceRecord['status'] | null;
      }>(`
        SELECT o.id, o.total_cents, o.fee_basis_points, o.fee_basis,
               o.custom_fee_basis_cents, o.billing_invoice_id, i.status AS billing_status
        FROM orders o
        LEFT JOIN invoices i ON i.workspace_id = o.workspace_id AND i.id = o.billing_invoice_id
        WHERE o.workspace_id = $1 AND o.id = $2
        FOR UPDATE OF o
      `, [workspaceId, orderId]);
      const row = current.rows[0];
      if (!row) return null;
      if (row.billing_invoice_id && row.billing_status && row.billing_status !== 'draft') {
        throw new OrderBillingLockedError();
      }
      const result = await client.query<{
        id: string;
        total_cents: number | null;
        fee_basis_points: number;
        fee_basis: FeeBasis;
        custom_fee_basis_cents: number | null;
      }>(`
        UPDATE orders
        SET fee_basis_points = $3,
            fee_basis = $4,
            custom_fee_basis_cents = $5,
            updated_at = now()
        WHERE workspace_id = $1 AND id = $2
        RETURNING id, total_cents, fee_basis_points, fee_basis, custom_fee_basis_cents
      `, [workspaceId, orderId, feeBasisPoints, feeBasis, customFeeBasisCents]);
      const feeBasisCents = resolveFeeBasisCents(row.total_cents, feeBasis, customFeeBasisCents);
      if (row.billing_invoice_id) {
        if (feeBasisCents === null) {
          throw new BillingValidationError('FEE_BASIS_UNAVAILABLE', 'This order is missing its checkout total.');
        }
        const feeCents = calculateFeeCents(feeBasisCents, feeBasisPoints) ?? 0;
        await client.query(`
          UPDATE invoice_lines
          SET billing_model = 'service_fee_only', fee_basis_points = $4,
              fee_basis = $5, fee_basis_cents = $6, fee_cents = $7, total_cents = $7
          WHERE workspace_id = $1 AND invoice_id = $2 AND order_id = $3
        `, [workspaceId, row.billing_invoice_id, orderId, feeBasisPoints, feeBasis, feeBasisCents, feeCents]);
        await client.query(`
          UPDATE invoices
          SET billing_model = 'service_fee_only',
              fee_cents = (SELECT COALESCE(SUM(fee_cents), 0) FROM invoice_lines WHERE workspace_id = $1 AND invoice_id = $2),
              subtotal_cents = (SELECT COALESCE(SUM(subtotal_cents), 0) FROM invoice_lines WHERE workspace_id = $1 AND invoice_id = $2),
              total_cents = (SELECT COALESCE(SUM(total_cents), 0) FROM invoice_lines WHERE workspace_id = $1 AND invoice_id = $2),
              updated_at = now()
          WHERE workspace_id = $1 AND id = $2 AND status = 'draft'
        `, [workspaceId, row.billing_invoice_id]);
      }
      return {
        orderId: result.rows[0].id,
        feePercent: result.rows[0].fee_basis_points / 100,
        feeBasis: result.rows[0].fee_basis,
        feeBasisCents,
        feeCents: calculateFeeCents(feeBasisCents, result.rows[0].fee_basis_points),
      };
    });
  }

  async updateOrderOverride(
    workspaceId: string,
    orderId: string,
    status: ParsedOrderStatus | null,
    note: string | null,
  ): Promise<OrderOverrideRecord | null> {
    return this.withWorkspace(workspaceId, async (client) => {
      const result = await client.query<{
        id: string;
        status_override: ParsedOrderStatus | null;
        override_note: string | null;
      }>(`
        UPDATE orders
        SET status_override = $3,
            override_note = CASE WHEN $3 IS NULL THEN NULL ELSE $4 END,
            override_updated_at = CASE WHEN $3 IS NULL THEN NULL ELSE now() END,
            updated_at = now()
        WHERE workspace_id = $1 AND id = $2
        RETURNING id, status_override, override_note
      `, [workspaceId, orderId, status, note?.trim() || null]);
      const row = result.rows[0];
      if (!row) return null;
      return {
        orderId: row.id,
        status: row.status_override,
        isManualOverride: Boolean(row.status_override),
        overrideNote: row.override_note,
      };
    });
  }

  async createCustomer(
    workspaceId: string,
    input: { name: string; gmailAddress: string; syncDays: number; secretCiphertext: string },
  ): Promise<CustomerRecord> {
    return this.withWorkspace(workspaceId, async (client) => {
      const customerId = randomUUID();
      const result = await client.query<{
        id: string;
        display_name: string;
        gmail_address: string;
        sync_status: CustomerRecord['syncStatus'];
        last_synced_at: Date | null;
        last_sync_error: string | null;
      }>(`
        INSERT INTO customers(id, workspace_id, display_name, gmail_address, sync_days, sync_status)
        VALUES ($1, $2, $3, $4, $5, 'syncing')
        RETURNING id, display_name, gmail_address, sync_status, last_synced_at, last_sync_error
      `, [customerId, workspaceId, input.name, input.gmailAddress, input.syncDays]);
      await client.query(`
        INSERT INTO customer_mailboxes(customer_id, workspace_id, secret_ciphertext)
        VALUES ($1, $2, $3)
      `, [customerId, workspaceId, input.secretCiphertext]);
      const customer = result.rows[0];
      return {
        id: customer.id,
        name: customer.display_name,
        emailMasked: maskEmail(customer.gmail_address),
        syncStatus: customer.sync_status,
        lastSyncedAt: null,
        syncMessage: null,
      };
    });
  }

  async getMailbox(workspaceId: string, customerId: string): Promise<MailboxRecord | null> {
    return this.withWorkspace(workspaceId, async (client) => {
      const result = await client.query<{
        customer_id: string;
        gmail_address: string;
        secret_ciphertext: string;
        sync_days: number;
        last_synced_at: Date | null;
      }>(`
        SELECT c.id AS customer_id, c.gmail_address, m.secret_ciphertext, c.sync_days, c.last_synced_at
        FROM customers c
        JOIN customer_mailboxes m ON m.workspace_id = c.workspace_id AND m.customer_id = c.id
        WHERE c.workspace_id = $1 AND c.id = $2
      `, [workspaceId, customerId]);
      const row = result.rows[0];
      return row ? {
        customerId: row.customer_id,
        gmailAddress: row.gmail_address,
        secretCiphertext: row.secret_ciphertext,
        syncDays: row.sync_days,
        lastSyncedAt: row.last_synced_at,
      } : null;
    });
  }

  async listCustomerIds(workspaceId: string): Promise<string[]> {
    return this.withWorkspace(workspaceId, async (client) => {
      const result = await client.query<{ id: string }>(
        'SELECT id FROM customers WHERE workspace_id = $1 ORDER BY created_at ASC',
        [workspaceId],
      );
      return result.rows.map((row) => row.id);
    });
  }

  async listOrderNumbers(workspaceId: string, customerId: string): Promise<string[]> {
    return this.withWorkspace(workspaceId, async (client) => {
      const result = await client.query<{ order_number: string }>(`
        SELECT order_number
        FROM orders
        WHERE workspace_id = $1 AND customer_id = $2 AND order_number ~ '[0-9]'
        ORDER BY updated_at DESC
        LIMIT 10000
      `, [workspaceId, customerId]);
      return result.rows.map((row) => row.order_number);
    });
  }

  async listProcessedMessageKeys(workspaceId: string, customerId: string): Promise<string[]> {
    return this.withWorkspace(workspaceId, async (client) => {
      const result = await client.query<{ message_key: string }>(`
        SELECT message_key
        FROM processed_messages
        WHERE workspace_id = $1 AND customer_id = $2
        ORDER BY received_at DESC
        LIMIT 50000
      `, [workspaceId, customerId]);
      return result.rows.map((row) => row.message_key);
    });
  }

  async beginSync(workspaceId: string, customerId: string): Promise<string> {
    return this.withWorkspace(workspaceId, async (client) => {
      const runId = randomUUID();
      await client.query(`
        UPDATE customers
        SET sync_status = 'syncing', last_sync_error = NULL, updated_at = now()
        WHERE workspace_id = $1 AND id = $2
      `, [workspaceId, customerId]);
      await client.query(`
        INSERT INTO sync_runs(id, workspace_id, customer_id, status)
        VALUES ($1, $2, $3, 'running')
      `, [runId, workspaceId, customerId]);
      return runId;
    });
  }

  async finishSync(
    workspaceId: string,
    customerId: string,
    runId: string,
    result: { scanned: number; matched: number; errorCode?: string; friendlyError?: string },
  ) {
    await this.withWorkspace(workspaceId, async (client) => {
      const failed = Boolean(result.errorCode);
      await client.query(`
        UPDATE sync_runs
        SET status = $4, messages_scanned = $5, orders_matched = $6,
            error_code = $7, finished_at = now()
        WHERE workspace_id = $1 AND customer_id = $2 AND id = $3
      `, [workspaceId, customerId, runId, failed ? 'failed' : 'completed', result.scanned, result.matched, result.errorCode ?? null]);
      await client.query(`
        UPDATE customers
        SET sync_status = $3,
            last_synced_at = CASE WHEN $3 = 'synced' THEN now() ELSE last_synced_at END,
            last_sync_error = $4,
            updated_at = now()
        WHERE workspace_id = $1 AND id = $2
      `, [workspaceId, customerId, failed ? 'error' : 'synced', result.friendlyError ?? null]);
    });
  }

  async recordMessage(
    workspaceId: string,
    customerId: string,
    meta: ProcessedMessageMeta,
    parsed: ParsedOrderEmail | null,
  ): Promise<boolean> {
    return this.withWorkspace(workspaceId, async (client) => {
      const processed = await client.query<{ id: string }>(`
        INSERT INTO processed_messages(
          id, workspace_id, customer_id, message_key, sender_domain, subject, received_at, matched_order
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (workspace_id, customer_id, message_key) DO NOTHING
        RETURNING id
      `, [
        randomUUID(), workspaceId, customerId, meta.messageKey,
        extractDomain(meta.fromAddress), meta.subject.slice(0, 500), meta.receivedAt, Boolean(parsed),
      ]);
      if (!parsed) return false;

      // A full-history sync may revisit a message that was already marked as
      // processed before parser rules were corrected. Reprocess identified
      // orders so historical matching, cancellation state, and newly parsed
      // fields can repair the existing customer-scoped row. Unidentified
      // messages remain idempotently skipped.
      if (processed.rowCount === 0 && !parsed.orderNumber && !parsed.trackingNumber) return false;

      let orderId: string | null = null;
      if (parsed.orderNumber) {
        const existing = await client.query<{ id: string }>(`
          SELECT id
          FROM orders
          WHERE workspace_id = $1 AND customer_id = $2 AND order_number = $3
          ORDER BY updated_at DESC
          LIMIT 1
        `, [workspaceId, customerId, parsed.orderNumber]);
        orderId = existing.rows[0]?.id ?? null;
      }
      if (!orderId && !parsed.orderNumber && parsed.trackingNumber) {
        const tracked = await client.query<{ order_id: string }>(`
          SELECT order_id FROM shipments
          WHERE workspace_id = $1 AND customer_id = $2 AND tracking_number = $3
        `, [workspaceId, customerId, parsed.trackingNumber]);
        orderId = tracked.rows[0]?.order_id ?? null;
      }

      const orderNumber = parsed.orderNumber ?? `TRACKING-${parsed.trackingNumber!.slice(-16)}`;
      if (!orderId) {
        const candidateId = randomUUID();
        const orderResult = await client.query<{ id: string }>(`
          INSERT INTO orders(
            id, workspace_id, customer_id, merchant, order_number, ordered_at,
            total_cents, item_count, items, currency, status, source_message_key
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (workspace_id, customer_id, merchant, order_number) DO UPDATE SET
            ordered_at = LEAST(orders.ordered_at, EXCLUDED.ordered_at),
            total_cents = COALESCE(EXCLUDED.total_cents, orders.total_cents),
            item_count = COALESCE(EXCLUDED.item_count, orders.item_count),
            items = CASE
              WHEN jsonb_array_length(EXCLUDED.items) > 0
                AND (jsonb_array_length(orders.items) = 0
                  OR orders.items::text ~* '(https?://|www[.]|click[.]oe[.]target[.]com|view[[:space:]]+order[[:space:]]+details|cancelled[[:space:]]+item|canceled[[:space:]]+item|item[[:space:]]+border|border[[:space:]]+(item|apple)|more[[:space:]]+items?[[:space:]]+to[[:space:]]+explore|video[[:space:]]+games|toys[[:space:]]*&[[:space:]]*games)'
                  OR COALESCE(EXCLUDED.item_count, 0) >= COALESCE(orders.item_count, 0))
                THEN EXCLUDED.items
              WHEN jsonb_array_length(EXCLUDED.items) = 0
                AND orders.items::text ~* '(https?://|www[.]|click[.]oe[.]target[.]com|view[[:space:]]+order[[:space:]]+details|cancelled[[:space:]]+item|canceled[[:space:]]+item|item[[:space:]]+border|border[[:space:]]+(item|apple)|more[[:space:]]+items?[[:space:]]+to[[:space:]]+explore|video[[:space:]]+games|toys[[:space:]]*&[[:space:]]*games)'
                THEN '[]'::jsonb
              ELSE orders.items
            END,
            status = CASE
              WHEN status_rank(EXCLUDED.status) >= status_rank(orders.status) THEN EXCLUDED.status
              ELSE orders.status
            END,
            source_message_key = EXCLUDED.source_message_key,
            updated_at = now()
          RETURNING id
        `, [
          candidateId, workspaceId, customerId, parsed.merchant, orderNumber, parsed.orderedAt,
          parsed.totalCents, parsed.itemCount, JSON.stringify(parsed.items), parsed.currency, parsed.status, parsed.messageKey,
        ]);
        orderId = orderResult.rows[0].id;
      } else {
        await client.query(`
          UPDATE orders SET
            status = CASE WHEN status_rank($4) >= status_rank(status) THEN $4 ELSE status END,
            total_cents = COALESCE($5, total_cents),
            item_count = COALESCE($6, item_count),
            items = CASE
              WHEN jsonb_array_length($7::jsonb) > 0
                AND (jsonb_array_length(items) = 0
                  OR items::text ~* '(https?://|www[.]|click[.]oe[.]target[.]com|view[[:space:]]+order[[:space:]]+details|cancelled[[:space:]]+item|canceled[[:space:]]+item|item[[:space:]]+border|border[[:space:]]+(item|apple)|more[[:space:]]+items?[[:space:]]+to[[:space:]]+explore|video[[:space:]]+games|toys[[:space:]]*&[[:space:]]*games)'
                  OR COALESCE($6, 0) >= COALESCE(item_count, 0))
                THEN $7::jsonb
              WHEN jsonb_array_length($7::jsonb) = 0
                AND items::text ~* '(https?://|www[.]|click[.]oe[.]target[.]com|view[[:space:]]+order[[:space:]]+details|cancelled[[:space:]]+item|canceled[[:space:]]+item|item[[:space:]]+border|border[[:space:]]+(item|apple)|more[[:space:]]+items?[[:space:]]+to[[:space:]]+explore|video[[:space:]]+games|toys[[:space:]]*&[[:space:]]*games)'
                THEN '[]'::jsonb
              ELSE items
            END,
            updated_at = now(), source_message_key = $8
          WHERE workspace_id = $1 AND customer_id = $2 AND id = $3
        `, [workspaceId, customerId, orderId, parsed.status, parsed.totalCents, parsed.itemCount, JSON.stringify(parsed.items), parsed.messageKey]);
      }

      if (parsed.trackingNumber) {
        await client.query(`
          INSERT INTO shipments(
            id, workspace_id, customer_id, order_id, carrier, tracking_number,
            tracking_url, status, expected_delivery, delivered_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $8 = 'delivered' THEN $10 ELSE NULL END)
          ON CONFLICT (workspace_id, customer_id, order_id) DO UPDATE SET
            carrier = COALESCE(EXCLUDED.carrier, shipments.carrier),
            tracking_number = COALESCE(EXCLUDED.tracking_number, shipments.tracking_number),
            tracking_url = COALESCE(EXCLUDED.tracking_url, shipments.tracking_url),
            status = CASE
              WHEN status_rank(EXCLUDED.status) >= status_rank(shipments.status) THEN EXCLUDED.status
              ELSE shipments.status
            END,
            expected_delivery = COALESCE(EXCLUDED.expected_delivery, shipments.expected_delivery),
            delivered_at = COALESCE(EXCLUDED.delivered_at, shipments.delivered_at),
            updated_at = now()
        `, [
          randomUUID(), workspaceId, customerId, orderId, parsed.carrier, parsed.trackingNumber,
          parsed.trackingUrl, parsed.status, parsed.expectedDelivery, parsed.orderedAt,
        ]);
      }

      const eventCopy = statusCopy(parsed.status, parsed.carrier);
      await client.query(`
        INSERT INTO order_events(
          id, workspace_id, customer_id, order_id, status, label, detail, occurred_at, source_message_key
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (workspace_id, order_id, status, source_message_key) DO NOTHING
      `, [
        randomUUID(), workspaceId, customerId, orderId, parsed.status,
        eventCopy.label, eventCopy.detail, parsed.orderedAt, parsed.messageKey,
      ]);
      return true;
    });
  }

  private async loadInvoices(
    client: PoolClient,
    workspaceId: string,
    customerId?: string,
    invoiceId?: string,
    stripeInvoiceId?: string,
  ): Promise<InvoiceRecord[]> {
    const clauses = ['i.workspace_id = $1'];
    const params: unknown[] = [workspaceId];
    if (customerId) {
      params.push(customerId);
      clauses.push(`i.customer_id = $${params.length}`);
    }
    if (invoiceId) {
      params.push(invoiceId);
      clauses.push(`i.id = $${params.length}`);
    }
    if (stripeInvoiceId) {
      params.push(stripeInvoiceId);
      clauses.push(`i.stripe_invoice_id = $${params.length}`);
    }
    const result = await client.query<{
      invoice_id: string;
      customer_id: string;
      invoice_number: string;
      company_name: string | null;
      billing_model: InvoiceRecord['billingModel'];
      status: InvoiceRecord['status'];
      currency: string;
      subtotal_cents: number;
      fee_cents: number;
      total_cents: number;
      due_at: Date | null;
      invoice_created_at: Date;
      paid_at: Date | null;
      hosted_invoice_url: string | null;
      last_error: string | null;
      line_id: string | null;
      order_id: string | null;
      description: string | null;
      line_subtotal_cents: number | null;
      fee_basis_points: number | null;
      fee_basis: FeeBasis | null;
      fee_basis_cents: number | null;
      line_fee_cents: number | null;
      line_total_cents: number | null;
      line_currency: string | null;
    }>(`
      SELECT i.id AS invoice_id, i.customer_id, i.invoice_number,
             CASE WHEN i.status = 'draft' THEN ws.display_name ELSE i.company_name END AS company_name, i.status, i.billing_model, i.currency,
             i.subtotal_cents, i.fee_cents, i.total_cents, i.due_at,
             i.created_at AS invoice_created_at, i.paid_at, i.hosted_invoice_url, i.last_error,
             l.id AS line_id, l.order_id, l.description,
             l.subtotal_cents AS line_subtotal_cents, l.fee_basis_points, l.fee_basis, l.fee_basis_cents,
             l.fee_cents AS line_fee_cents, l.total_cents AS line_total_cents,
             l.currency AS line_currency
      FROM invoices i
      LEFT JOIN workspace_settings ws ON ws.workspace_id = i.workspace_id
      LEFT JOIN invoice_lines l
        ON l.workspace_id = i.workspace_id AND l.invoice_id = i.id
      WHERE ${clauses.join(' AND ')}
      ORDER BY i.created_at DESC, l.created_at ASC
    `, params);
    const invoices = new Map<string, InvoiceRecord>();
    for (const row of result.rows) {
      let invoice = invoices.get(row.invoice_id);
      if (!invoice) {
        invoice = {
          id: row.invoice_id,
          workspaceId,
          companyName: row.company_name,
          customerId: row.customer_id,
          invoiceNumber: row.invoice_number,
          billingModel: row.billing_model,
          status: row.status,
          currency: row.currency.trim(),
          subtotalCents: row.subtotal_cents,
          feeCents: row.fee_cents,
          totalCents: row.total_cents,
          dueAt: row.due_at?.toISOString() ?? null,
          createdAt: row.invoice_created_at.toISOString(),
          paidAt: row.paid_at?.toISOString() ?? null,
          paymentUrl: row.hosted_invoice_url,
          lastError: row.last_error,
          lines: [],
        };
        invoices.set(invoice.id, invoice);
      }
      if (row.line_id && row.order_id && row.description !== null) {
        invoice.lines.push({
          id: row.line_id,
          orderId: row.order_id,
          description: row.description,
          subtotalCents: row.line_subtotal_cents ?? 0,
          feePercent: (row.fee_basis_points ?? 0) / 100,
          feeBasis: row.fee_basis ?? 'checkout_total',
          feeBasisCents: row.fee_basis_cents ?? row.line_subtotal_cents ?? 0,
          feeCents: row.line_fee_cents ?? 0,
          totalCents: row.line_total_cents ?? 0,
          currency: (row.line_currency ?? row.currency).trim(),
        });
      }
    }
    return [...invoices.values()];
  }

  private async withWorkspace<T>(workspaceId: string, callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

function statusCopy(status: ParsedOrderStatus, carrier: string | null) {
  switch (status) {
    case 'pending': return { label: 'Pending confirmation', detail: 'The retailer has not sent an explicit confirmation yet.' };
    case 'processing': return { label: 'Preparing shipment', detail: 'The order is being prepared.' };
    case 'shipped': return { label: 'Shipped', detail: carrier ? `Shipped via ${carrier}.` : 'The shipment is in transit.' };
    case 'delivered': return { label: 'Delivered', detail: 'The shipment was delivered.' };
    case 'cancelled': return { label: 'Order cancelled', detail: 'The merchant cancelled the order.' };
    default: return { label: 'Order confirmed', detail: 'Order received and confirmed.' };
  }
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '••••';
  return `${local[0]}${'•'.repeat(Math.min(4, Math.max(1, local.length - 1)))}@${domain}`;
}

function extractDomain(email: string): string | null {
  return email.split('@')[1]?.toLowerCase() ?? null;
}

function normalizeStoredOrderItems(value: unknown): ParsedOrderItem[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const item = entry as Partial<ParsedOrderItem>;
    if (typeof item.name !== 'string' || item.name.trim().length < 2) return [];
    if (isStoredNonProductName(item.name)) return [];
    const quantity = item.quantity;
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > 10_000) return [];
    const unitPriceCents = item.unitPriceCents === null || item.unitPriceCents === undefined ? null : item.unitPriceCents;
    const totalCents = item.totalCents === null || item.totalCents === undefined ? null : item.totalCents;
    if ((unitPriceCents !== null && (!Number.isInteger(unitPriceCents) || unitPriceCents < 0))
      || (totalCents !== null && (!Number.isInteger(totalCents) || totalCents < 0))) return [];
    return [{
      name: item.name.trim().slice(0, 240),
      quantity,
      unitPriceCents,
      totalCents,
    }];
  });
}

function isStoredNonProductName(value: string): boolean {
  const name = value.trim();
  return /https?:\/\/|www\.|\b(?:href|qs)=|click\.oe\.target\.com/i.test(name)
    || /^(?:view\s+(?:order|cart|details?)(?:\s+(?:order|cart|details?))?|order\s+(?:details|summary)|cancel(?:led|ed)\s+item|more\s+items?\s+to\s+explore|(?:recommended|related|suggested)\s+items?)$/i.test(name)
    || /^(?:video\s+)?games?|toys?(?:\s*&\s*games)?$/i.test(name);
}

function resolveFeeBasisCents(
  checkoutTotalCents: number | null,
  feeBasis: FeeBasis,
  customFeeBasisCents: number | null,
): number | null {
  return feeBasis === 'custom_amount' ? customFeeBasisCents : checkoutTotalCents;
}

function calculateFeeCents(feeBasisCents: number | null, feeBasisPoints: number): number | null {
  return feeBasisCents === null ? null : Math.round(feeBasisCents * feeBasisPoints / 10_000);
}

function hashPortalToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function toWorkspaceSettings(row: {
  theme: WorkspaceTheme;
  display_name: string;
  logo_url: string | null;
  accent_color: string;
  notification_seller_email: string | null;
  venmo_payment_url: string | null;
}): WorkspaceSettingsRecord {
  return {
    theme: row.theme,
    displayName: row.display_name,
    logoUrl: row.logo_url,
    accentColor: row.accent_color,
    notificationSellerEmail: row.notification_seller_email,
    venmoPaymentUrl: row.venmo_payment_url,
  };
}
