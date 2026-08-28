import { describe, expect, it } from 'vitest';
import { calculateInvoiceTotals, isBillableOrder } from '../src/lib/billing.js';

describe('invoice previews', () => {
  it('keeps purchase subtotals informational and invoices service fees only', () => {
    expect(calculateInvoiceTotals([
      { totalCents: 10_000, feeCents: 850, currency: 'USD' },
      { totalCents: 2_500, feeCents: 125, currency: 'USD' },
    ])).toEqual({ subtotalCents: 12_500, feeCents: 975, totalCents: 975, currency: 'USD' });
  });

  it('rejects mixed currencies and keeps cancelled or already billed orders out', () => {
    expect(calculateInvoiceTotals([
      { totalCents: 100, feeCents: 10, currency: 'USD' },
      { totalCents: 100, feeCents: 10, currency: 'CAD' },
    ])).toBeNull();
    expect(isBillableOrder({ status: 'cancelled', billingStatus: 'unbilled', totalCents: 100 })).toBe(false);
    expect(isBillableOrder({ status: 'delivered', billingStatus: 'open', totalCents: 100 })).toBe(false);
    expect(isBillableOrder({ status: 'delivered', billingStatus: 'unbilled', totalCents: 100 })).toBe(true);
  });

  it('allows a custom amount basis when a retailer total is unavailable', () => {
    expect(isBillableOrder({
      status: 'confirmed', billingStatus: 'unbilled', totalCents: null,
      feeBasis: 'custom_amount', feeBasisCents: 20_000, feeCents: 1_000,
    })).toBe(true);
    expect(calculateInvoiceTotals([{ totalCents: null, feeCents: 1_000, currency: 'USD' }]))
      .toMatchObject({ subtotalCents: 0, feeCents: 1_000, totalCents: 1_000 });
  });
});
