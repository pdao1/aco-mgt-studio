import { describe, expect, it } from 'vitest';
import { filterOrders, listRetailers } from '../src/lib/orders.js';

const orders = [
  { status: 'confirmed' as const, store: 'Nike', orderNumber: 'NK-100', trackingNumber: null },
  { status: 'shipped' as const, store: 'Target', orderNumber: 'TG-200', trackingNumber: 'TRACK-200' },
  { status: 'delivered' as const, store: 'nike', orderNumber: 'NK-300', trackingNumber: 'TRACK-300' },
];

describe('order list filters', () => {
  it('derives sorted, case-insensitive retailer choices from real orders', () => {
    expect(listRetailers(orders)).toEqual(['Nike', 'Target']);
  });

  it('composes retailer, status, and search filters', () => {
    expect(filterOrders(orders, { retailer: 'NIKE', status: 'delivered', query: '300' }))
      .toEqual([orders[2]]);
    expect(filterOrders(orders, { retailer: 'Target', status: 'in-transit', query: 'track' }))
      .toEqual([orders[1]]);
    expect(filterOrders(orders, { retailer: 'Target', status: 'cancelled' })).toEqual([]);
  });
});
