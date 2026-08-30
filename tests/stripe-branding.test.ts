import { describe, expect, it, vi } from 'vitest';
import type { InvoiceRecord } from '../server/database/repository.js';

const stripe = vi.hoisted(() => ({
  createInvoice: vi.fn(async () => ({ id: 'in_test', status: 'open', hosted_invoice_url: 'https://example.com/invoice' })),
  createItem: vi.fn(async () => ({})),
}));
vi.mock('stripe', () => ({ default: class {
  invoices = { create: stripe.createInvoice };
  invoiceItems = { create: stripe.createItem };
} }));

import { StripeBillingGateway } from '../server/billing/stripe.js';

describe('Stripe invoice company identity', () => {
  it('sends the workspace company name and routing metadata without changing fee-only charges', async () => {
    const invoice: InvoiceRecord = {
      id: 'invoice-a', workspaceId: 'workspace-a', companyName: 'Example ACO & Company',
      customerId: 'customer-a', invoiceNumber: 'INV-1', billingModel: 'service_fee_only', status: 'draft',
      currency: 'USD', subtotalCents: 10000, feeCents: 1000, totalCents: 1000,
      dueAt: null, createdAt: new Date().toISOString(), paidAt: null, paymentUrl: null, lastError: null,
      lines: [{ id: 'line-a', orderId: 'order-a', description: 'Order 123', subtotalCents: 10000,
        feePercent: 10, feeBasis: 'checkout_total', feeBasisCents: 10000, feeCents: 1000, totalCents: 1000, currency: 'USD' }],
    };
    await new StripeBillingGateway('local-test-key').issueInvoice({ id: 'customer-a', name: 'Customer', gmailAddress: 'customer@example.com', stripeCustomerId: 'cus_test' }, invoice, 7);
    expect(stripe.createInvoice).toHaveBeenCalledWith(expect.objectContaining({
      description: 'Example ACO & Company — ACO service fees', footer: 'Example ACO & Company',
      metadata: expect.objectContaining({ aco_workspace_id: 'workspace-a', aco_invoice_id: 'invoice-a' }),
    }), expect.anything());
    expect(stripe.createItem).toHaveBeenCalledWith(expect.objectContaining({ amount: 1000 }), expect.anything());
  });
});
