import type { WorkspaceTheme } from './lib/themes.js';

export type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'cancelled';

export type SyncStatus = 'synced' | 'syncing' | 'warning' | 'error';

export type BillingStatus = 'unbilled' | 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';

export type InvoiceStatus = Exclude<BillingStatus, 'unbilled'>;

export type FeeBasis = 'checkout_total' | 'custom_amount';

export interface WorkspaceSettings {
  theme: WorkspaceTheme;
  displayName: string;
  logoUrl: string | null;
  accentColor: string;
  notificationSellerEmail: string | null;
  venmoPaymentUrl: string | null;
}

export interface WorkspaceSummary {
  id: string;
  slug: string;
  name: string;
  nodeGroupKey: string;
  status: 'provisioning' | 'active' | 'suspended';
  settings: WorkspaceSettings;
}

export interface Customer {
  id: string;
  name: string;
  emailMasked: string;
  syncStatus: SyncStatus;
  lastSyncedAt: string | null;
  syncMessage?: string | null;
}

export interface OrderEvent {
  id: string;
  status: OrderStatus;
  label: string;
  detail: string;
  occurredAt: string;
}

export interface OrderItem {
  name: string;
  quantity: number;
  unitPriceCents: number | null;
  totalCents: number | null;
}

export interface Order {
  id: string;
  customerId: string;
  store: string;
  orderNumber: string;
  orderedAt: string;
  totalCents: number | null;
  /** Per-order customer fee percentage, represented as a decimal percentage (e.g. 8.5). */
  feePercent: number;
  feeBasis: FeeBasis;
  /** Resolved amount used to calculate the service fee. */
  feeBasisCents: number | null;
  feeCents: number | null;
  billingStatus: BillingStatus;
  invoiceId: string | null;
  isManualOverride: boolean;
  overrideNote: string | null;
  currency: string;
  status: OrderStatus;
  itemCount: number | null;
  items: OrderItem[];
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  expectedDelivery: string | null;
  events: OrderEvent[];
}

export interface DashboardPayload {
  workspace: WorkspaceSummary;
  customers: Customer[];
  orders: Order[];
}

export interface InvoiceLine {
  id: string;
  orderId: string;
  description: string;
  subtotalCents: number;
  feePercent: number;
  feeCents: number;
  totalCents: number;
  currency: string;
}

export interface Invoice {
  id: string;
  companyName: string | null;
  customerId: string;
  invoiceNumber: string;
  status: InvoiceStatus;
  currency: string;
  subtotalCents: number;
  feeCents: number;
  totalCents: number;
  dueAt: string | null;
  createdAt: string;
  paidAt: string | null;
  paymentUrl: string | null;
  lastError: string | null;
  lines: InvoiceLine[];
}

export interface BillingPayload {
  invoices: Invoice[];
}

export interface PortalPayload {
  customer: Pick<Customer, 'id' | 'name'>;
  workspace: WorkspaceSummary;
  orders: Order[];
  invoices: Invoice[];
  portalExpiresAt?: string | null;
}

export interface PortalLinkResponse {
  url: string;
  createdAt: string;
}

export interface OrderFeeUpdate {
  orderId: string;
  feePercent: number;
  feeBasis: FeeBasis;
  feeBasisCents: number | null;
  feeCents: number | null;
}

export type UpdateOrderFeeInput =
  | { feePercent: number; feeBasis: 'checkout_total' }
  | { feePercent: number; feeBasis: 'custom_amount'; customBasisCents: number };

export interface OrderOverrideUpdate {
  orderId: string;
  status: OrderStatus | null;
  isManualOverride: boolean;
  overrideNote: string | null;
}

export interface CreateInvoiceInput {
  orderIds: string[];
  dueDays: number;
}

export interface ConnectCustomerInput {
  name: string;
  gmailAddress: string;
  appPassword: string;
  syncDays: number;
}

export interface ApiErrorShape {
  error?: string;
  message?: string;
}
