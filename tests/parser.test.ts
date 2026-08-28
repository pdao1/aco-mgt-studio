import { describe, expect, it } from 'vitest';
import { parseOrderEmail } from '../server/email/parser.js';

const receivedAt = new Date('2026-08-20T12:00:00.000Z');

describe('parseOrderEmail', () => {
  it('extracts a confirmation without inventing tracking from a numeric order number', () => {
    const parsed = parseOrderEmail({
      messageId: '<confirmation@example>',
      fromAddress: 'orders@walmart.com',
      fromName: 'Walmart Orders',
      subject: 'Your order is confirmed',
      text: 'Thanks for your order. Order # 200010763845678\nOrder total: $67.21',
      html: null,
      receivedAt,
    });

    expect(parsed).toMatchObject({
      merchant: 'Walmart',
      orderNumber: '200010763845678',
      status: 'confirmed',
      totalCents: 6721,
      trackingNumber: null,
    });
  });

  it('extracts UPS tracking and shipment status', () => {
    const parsed = parseOrderEmail({
      messageId: '<shipping@example>',
      fromAddress: 'shipping@nike.com',
      fromName: 'Nike',
      subject: 'Your Nike order has shipped',
      text: 'Order number: C001245681\nTracking number: 1Z7W9A7Y03ABCD9827\nExpected delivery: August 24, 2026',
      html: null,
      receivedAt,
    });

    expect(parsed).toMatchObject({
      merchant: 'Nike',
      orderNumber: 'C001245681',
      status: 'shipped',
      carrier: 'UPS',
      trackingNumber: '1Z7W9A7Y03ABCD9827',
    });
    expect(parsed?.trackingUrl).toContain('ups.com');
    expect(parsed?.expectedDelivery?.toISOString()).toContain('2026-08-24');
  });

  it('recognizes delivered USPS mail', () => {
    const parsed = parseOrderEmail({
      messageId: '<delivered@example>',
      fromAddress: 'tracking@target.com',
      fromName: 'Target',
      subject: 'Your package was delivered',
      text: 'Order 9021012345678\nUSPS tracking number 94001112025558883342\nPackage was delivered.',
      html: null,
      receivedAt,
    });

    expect(parsed).toMatchObject({
      status: 'delivered',
      carrier: 'USPS',
      trackingNumber: '94001112025558883342',
    });
  });

  it('recognizes cancellation notices and extracts the order number after the cancellation wording', () => {
    const parsed = parseOrderEmail({
      messageId: '<cancelled@example>',
      fromAddress: 'support@retailer.example',
      fromName: 'Retailer Support',
      subject: 'Cancellation confirmation',
      text: 'Your order was canceled - R-847201. No payment was captured.',
      html: null,
      receivedAt,
    });

    expect(parsed).toMatchObject({
      orderNumber: 'R-847201',
      status: 'cancelled',
    });
  });

  it('matches a cancellation email against a known order number when the notice omits an order label', () => {
    const parsed = parseOrderEmail({
      messageId: '<cancelled-without-label@example>',
      fromAddress: 'notifications@retailer.example',
      fromName: 'Retailer',
      subject: 'Your cancellation is complete',
      text: 'The purchase associated with 200010763845678 was cancelled at your request.',
      html: null,
      receivedAt,
    }, { knownOrderNumbers: ['200010763845678'] });

    expect(parsed).toMatchObject({
      orderNumber: '200010763845678',
      status: 'cancelled',
    });
  });

  it('extracts a compact item overview from labelled retailer lines', () => {
    const parsed = parseOrderEmail({
      messageId: '<items@example>',
      fromAddress: 'orders@nike.com',
      fromName: 'Nike Orders',
      subject: 'Your order is confirmed',
      text: 'Order number: NK-12001\nProduct: Air Max 90\nQty: 2\n$120.00\nProduct: Crew Socks | Qty: 1 | Line total: $18.00\nOrder total: $258.00',
      html: null,
      receivedAt,
    });

    expect(parsed?.itemCount).toBe(3);
    expect(parsed?.items).toEqual([
      { name: 'Air Max 90', quantity: 2, unitPriceCents: 12000, totalCents: null },
      { name: 'Crew Socks', quantity: 1, unitPriceCents: null, totalCents: 1800 },
    ]);
  });

  it('handles item, quantity, and price split across retailer table lines', () => {
    const parsed = parseOrderEmail({
      messageId: '<table-items@example>',
      fromAddress: 'orders@target.com',
      fromName: 'Target',
      subject: 'Order confirmation',
      text: 'Order number: TG-12001\nAir Max 90\nQty\n2\n$120.00\nCrew Socks\nQty\n1\n$18.00\nOrder total: $258.00',
      html: null,
      receivedAt,
    });

    expect(parsed?.items).toEqual([
      { name: 'Air Max 90', quantity: 2, unitPriceCents: 12000, totalCents: null },
      { name: 'Crew Socks', quantity: 1, unitPriceCents: 1800, totalCents: null },
    ]);
  });

  it('only treats long numeric values as FedEx tracking when tracking context is present', () => {
    const parsed = parseOrderEmail({
      messageId: '<fedex@example>',
      fromAddress: 'shipping@example-store.com',
      fromName: 'Example Store Shipping',
      subject: 'Your order has shipped',
      text: 'Order number: 123456789012345\nFedEx tracking number: 782612345678',
      html: null,
      receivedAt,
    });

    expect(parsed).toMatchObject({
      orderNumber: '123456789012345',
      carrier: 'FedEx',
      trackingNumber: '782612345678',
    });
  });

  it('ignores unrelated messages', () => {
    expect(parseOrderEmail({
      messageId: '<newsletter@example>',
      fromAddress: 'news@example.com',
      fromName: 'Example',
      subject: 'This week in sneakers',
      text: 'Read the latest release news.',
      html: null,
      receivedAt,
    })).toBeNull();
  });
});
