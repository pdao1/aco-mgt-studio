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

  it('prefers the customer history order number over another numeric reference', () => {
    const parsed = parseOrderEmail({
      messageId: '<historical-match@example>',
      fromAddress: 'notifications@target.com',
      fromName: 'Target',
      subject: 'Your order has been canceled',
      text: 'Cancellation reference: 9999999999999\nThe purchase associated with 200010763845678 was cancelled.',
      html: null,
      receivedAt,
    }, { knownOrderNumbers: ['200010763845678'] });

    expect(parsed?.orderNumber).toBe('200010763845678');
    expect(parsed?.status).toBe('cancelled');
  });

  it('does not create an order from prose after the word order', () => {
    const parsed = parseOrderEmail({
      messageId: '<prose@example>',
      fromAddress: 'orders@target.com',
      fromName: 'Target Orders',
      subject: 'Your order confirmation',
      text: 'Your order is ending soon. Order confirmation is available before the cutoff. Order totaling is shown at checkout.',
      html: null,
      receivedAt,
    });

    expect(parsed).toBeNull();
  });

  it('continues past a subject phrase to find an unlabelled order number in the body', () => {
    const parsed = parseOrderEmail({
      messageId: '<unlabelled-body@example>',
      fromAddress: 'orders@target.com',
      fromName: 'Target Orders',
      subject: 'Your order is confirmed',
      text: 'Your order 102003715051916 is confirmed.',
      html: null,
      receivedAt,
    });

    expect(parsed?.orderNumber).toBe('102003715051916');
  });

  it('accepts an order confirmation label without treating the label as the number', () => {
    const parsed = parseOrderEmail({
      messageId: '<confirmation-label@example>',
      fromAddress: 'orders@target.com',
      fromName: 'Target Orders',
      subject: 'Your order is confirmed',
      text: 'Order confirmation: 102003715051916',
      html: null,
      receivedAt,
    });

    expect(parsed?.orderNumber).toBe('102003715051916');
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

  it('does not promote recommendation headings or CSS fragments to purchased items', () => {
    const parsed = parseOrderEmail({
      messageId: '<noisy-items@example>',
      fromAddress: 'orders@walmart.com',
      fromName: 'Walmart',
      subject: 'Your order is confirmed',
      text: [
        'Order number: 200001234567890',
        'border Apple AirPods 4 with Active Noise Cancellation ( $179.00',
        ') Item border Item border',
        'More items to explore $35.00',
        '(2 pack) Apple 30W USB-C Power Adapter ( $35.00',
        'Apple 20W USB-C Power Adapter - iPhone Charger ( $19.00',
        'Video games',
        'Toys & games',
        'Order total: $233.00',
      ].join('\n'),
      html: null,
      receivedAt,
    });

    expect(parsed?.items).toEqual([]);
    expect(parsed?.itemCount).toBeNull();
  });

  it('does not mark an order cancelled because a product name contains cancellation', () => {
    const parsed = parseOrderEmail({
      messageId: '<noise-cancellation-product@example>',
      fromAddress: 'orders@walmart.com',
      fromName: 'Walmart',
      subject: 'Your order is confirmed',
      text: 'Order number: 200001234567890\nApple AirPods with Active Noise Cancellation\nQty: 1\nOrder total: $179.00',
      html: null,
      receivedAt,
    });

    expect(parsed?.status).toBe('confirmed');
  });

  it('keeps each split-row price attached to its own product', () => {
    const parsed = parseOrderEmail({
      messageId: '<split-noisy-items@example>',
      fromAddress: 'orders@walmart.com',
      fromName: 'Walmart',
      subject: 'Your order is confirmed',
      text: [
        'Order number: 200001234567890',
        'border Apple AirPods 4 with Active Noise Cancellation (',
        'Qty 1 · $179.00 each',
        'More items to explore',
        'Qty 1 · $35.00 each',
        '(2 pack) Apple 30W USB-C Power Adapter (',
        'Qty 1 · $35.00 each',
        'Apple 20W USB-C Power Adapter - iPhone Charger (',
        'Qty 1 · $19.00 each',
        'Video games',
        'Qty 1',
        'Toys & games',
        'Qty 1',
        'Order total: $233.00',
      ].join('\n'),
      html: null,
      receivedAt,
    });

    expect(parsed?.items).toEqual([
      { name: 'Apple AirPods 4 with Active Noise Cancellation', quantity: 1, unitPriceCents: 17900, totalCents: null },
      { name: '(2 pack) Apple 30W USB-C Power Adapter', quantity: 1, unitPriceCents: 3500, totalCents: null },
      { name: 'Apple 20W USB-C Power Adapter - iPhone Charger', quantity: 1, unitPriceCents: 1900, totalCents: null },
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
