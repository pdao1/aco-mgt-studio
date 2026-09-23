import type { SoloOrder } from './types.js';

export function summarizePurchases(orders: SoloOrder[]) {
  const totals = new Map<string, number>();
  let unknownTotal = 0;
  for (const order of orders) {
    if (order.status === 'cancelled') continue;
    if (order.totalCents === null) { unknownTotal++; continue; }
    totals.set(order.currency, (totals.get(order.currency) ?? 0) + order.totalCents);
  }
  const cancelled=orders.filter(o=>o.status==='cancelled').length;
  const total=orders.length;
  return {count:total, cancelled, inTransit:orders.filter(o=>o.status==='shipped').length,
    delivered:orders.filter(o=>o.status==='delivered').length, totals:[...totals],unknownTotal,
    stickRate:total?Math.round(((total-cancelled)/total)*100):null,
    cancelRate:total?Math.round((cancelled/total)*100):null};
}
