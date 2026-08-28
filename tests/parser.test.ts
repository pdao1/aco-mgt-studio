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
