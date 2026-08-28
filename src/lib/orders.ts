import type { Order, OrderStatus } from '../types.js';

export type OrderListStatusFilter = 'all' | 'in-transit' | OrderStatus;

interface OrderFilterOptions {
  status?: OrderListStatusFilter;
  query?: string;
  retailer?: string;
}

export function listRetailers(orders: Pick<Order, 'store'>[]): string[] {
  const retailers = new Map<string, string>();
  for (const order of orders) {
    const label = order.store.trim();
    const key = label.toLowerCase();
    if (label && !retailers.has(key)) retailers.set(key, label);
  }
  return [...retailers.values()].sort((left, right) => left.localeCompare(right));
}

export function filterOrders<T extends Pick<Order, 'status' | 'store' | 'orderNumber' | 'trackingNumber'>>(
  orders: T[],
  { status = 'all', query = '', retailer = '' }: OrderFilterOptions,
): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedRetailer = retailer.trim().toLowerCase();

  return orders.filter((order) => {
    const matchesStatus = status === 'all'
      || (status === 'in-transit' ? order.status === 'shipped' : order.status === status);
    const matchesRetailer = !normalizedRetailer || order.store.trim().toLowerCase() === normalizedRetailer;
    const matchesQuery = !normalizedQuery || [order.store, order.orderNumber, order.trackingNumber ?? '']
      .some((value) => value.toLowerCase().includes(normalizedQuery));
    return matchesStatus && matchesRetailer && matchesQuery;
  });
}
