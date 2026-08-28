import type { Order } from '../types.js';

export interface InvoiceTotals {
  subtotalCents: number;
  feeCents: number;
  totalCents: number;
  currency: string;
}

/**
 * Billing is intentionally based on integer cents and the fee snapshot that
 * is already stored on each order. The same function is mirrored by the
 * server repository so a browser can preview totals without becoming the
 * authority for an invoice.
 */
export function calculateInvoiceTotals(orders: Pick<Order, 'totalCents' | 'feeCents' | 'currency'>[]): InvoiceTotals | null {
  const billable = orders.filter((order) => order.totalCents !== null || (order.feeCents !== null && order.feeCents > 0));
  if (billable.length === 0) return null;
  const currencies = new Set(billable.map((order) => order.currency));
  if (currencies.size !== 1) return null;
  const subtotalCents = billable.reduce((sum, order) => sum + (order.totalCents ?? 0), 0);
  const feeCents = billable.reduce((sum, order) => sum + (order.feeCents ?? 0), 0);
  return {
    subtotalCents,
    feeCents,
    // Retailer purchases are paid with the customer's card. The invoice
    // collects only the ACO service fees.
    totalCents: feeCents,
    currency: billable[0].currency,
  };
}

export function isBillableOrder(order: Pick<Order, 'status' | 'billingStatus' | 'totalCents'> & { feeCents?: number | null; feeBasis?: 'checkout_total' | 'custom_amount'; feeBasisCents?: number | null }): boolean {
  const basisReady = order.feeBasis === 'custom_amount' ? order.feeBasisCents !== null && order.feeBasisCents !== undefined : order.totalCents !== null;
  return basisReady && (order.feeCents === undefined || (order.feeCents !== null && order.feeCents > 0)) && order.billingStatus === 'unbilled' && order.status !== 'cancelled';
}
