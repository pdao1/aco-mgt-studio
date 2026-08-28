import type { BillingPayload, ConnectCustomerInput, CreateInvoiceInput, Customer, DashboardPayload, Invoice, OrderFeeUpdate, OrderOverrideUpdate, PortalLinkResponse, PortalPayload, UpdateOrderFeeInput, WorkspaceSettings } from '../types';

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(body.message || body.error || 'Request failed.', response.status);
  }
  return body as T;
}

export const api = {
  activateService: (serial: string) => request<{ ok: true }>('/api/access/activate', {
    method: 'POST', body: JSON.stringify({ serial }),
  }),
  login: (password: string) => request<{ ok: true }>('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ password }),
  }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  dashboard: () => request<DashboardPayload>('/api/dashboard'),
  billing: () => request<BillingPayload>('/api/billing'),
  settings: () => request<{ settings: WorkspaceSettings }>('/api/settings'),
  updateSettings: (input: Partial<WorkspaceSettings>) => request<{ settings: WorkspaceSettings }>('/api/settings', {
    method: 'PATCH', body: JSON.stringify(input),
  }),
  connectCustomer: (input: ConnectCustomerInput) => request<{ customer: Customer }>('/api/customers', {
    method: 'POST', body: JSON.stringify(input),
  }),
  syncCustomer: (customerId: string) => request<{ accepted: true }>(`/api/customers/${customerId}/sync`, {
    method: 'POST',
  }),
  updateOrderFee: (orderId: string, input: UpdateOrderFeeInput) => request<OrderFeeUpdate>(`/api/orders/${orderId}/fee`, {
    method: 'PATCH', body: JSON.stringify(input),
  }),
  updateOrderOverride: (orderId: string, status: OrderOverrideUpdate['status'], note: string | null) => request<OrderOverrideUpdate>(`/api/orders/${orderId}/override`, {
    method: 'PATCH', body: JSON.stringify({ status, note }),
  }),
  createInvoice: (customerId: string, input: CreateInvoiceInput) => request<{ invoice: Invoice }>(`/api/customers/${customerId}/invoices`, {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify(input),
  }),
  issueInvoice: (invoiceId: string) => request<{ invoice: Invoice }>(`/api/invoices/${invoiceId}/issue`, {
    method: 'POST', body: JSON.stringify({}),
  }),
  createPortalLink: (customerId: string) => request<PortalLinkResponse>(`/api/customers/${customerId}/portal-link`, {
    method: 'POST',
  }),
  customerPortal: (token: string) => request<PortalPayload>(`/api/public/portal/${encodeURIComponent(token)}`),
};
