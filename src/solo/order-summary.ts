import type { SoloOrder } from './types.js';

export function summarizePurchases(orders: SoloOrder[]) {
  const totals = new Map<string, number>();
  let unknownTotal = 0;
  for (const order of orders) {
    if (order.status === 'cancelled') continue;
    if (order.totalCents === null) { unknownTotal++; continue; }
    totals.set(order.currency, (totals.get(order.currency) ?? 0) + order.totalCents);
  }
  return {count:orders.length, inTransit:orders.filter(o=>o.status==='shipped').length,
    delivered:orders.filter(o=>o.status==='delivered').length, totals:[...totals],unknownTotal};
}
