import { describe, expect, it } from 'vitest';
import { isCancellationNotice, isLikelyOrderMessage, isOneTimePinEmail, parseOrderEmail, shouldSkipOversizedMessage, shouldSkipOversizedText } from '../server/email/parser.js';

const receivedAt = new Date('2026-08-20T12:00:00.000Z');

describe('parseOrderEmail', () => {
  it('matches an atypical retailer update to a known order without inventing another order', () => {
    const email = {
      messageId: '<update@target.com>', fromAddress: 'orders@oe.target.com', fromName: 'Target',
      subject: "It's here!", text: '912003774472093\nYour items have arrived.', html: null, receivedAt,
    };
    expect(parseOrderEmail(email, { knownOrderNumbers: ['912003774472093'] }))
      .toMatchObject({ merchant: 'Target', orderNumber: '912003774472093' });
    expect(parseOrderEmail({ ...email, subject: 'Your one-time PIN', text: `${email.text}\nVerification code: 123456` },
      { knownOrderNumbers: ['912003774472093'] })).toBeNull();
  });

  it('admits broad purchase/receipt language for review but still requires identity to create an order', () => {
    const email = { messageId: '<receipt@target.com>', fromAddress: 'orders@target.com', fromName: 'Target',
      subject: 'Your receipt', text: 'Thanks for shopping with us.', html: null, receivedAt };
    expect(isLikelyOrderMessage(email)).toBe(true);
    expect(parseOrderEmail(email)).toBeNull();
  });

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

  it('keeps a promised future tracking number at the confirmed status', () => {
    const parsed = parseOrderEmail({
      messageId: '<tracking-placeholder@example>',
      fromAddress: 'orders@target.com',
      fromName: 'Target',
      subject: 'Your order is confirmed',
      text: 'Order number: TG-12002\nWe will email your tracking number when your package ships.',
      html: null,
      receivedAt,
    });

    expect(parsed).toMatchObject({ status: 'confirmed', trackingNumber: null });
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

  it('does not treat a USPS-shaped numeric order number as tracking without tracking context', () => {
    const parsed = parseOrderEmail({
      messageId: '<numeric-order-not-tracking@example>',
      fromAddress: 'orders@example-store.com',
      fromName: 'Example Store Orders',
      subject: 'Your order is confirmed',
      text: 'Order number: 94001112025558883342\nOrder total: $42.00',
      html: null,
      receivedAt,
    });

    expect(parsed).toMatchObject({
      orderNumber: '94001112025558883342',
      status: 'confirmed',
      trackingNumber: null,
      trackingUrl: null,
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

  it('does not treat a product with Noise Cancellation in the subject as a cancellation notice', () => {
    const email = {
      messageId: '<cancellation-product-subject@example>',
      fromAddress: 'orders@walmart.com',
      fromName: 'Walmart',
      subject: 'Order confirmed: Headphones with Active Noise Cancellation',
      text: 'Order number: WM-847202\nProduct: Headphones with Active Noise Cancellation\nQty: 1\nOrder total: $179.00',
      html: null,
      receivedAt,
    };

    expect(isCancellationNotice(email)).toBe(false);
    expect(parseOrderEmail(email)?.status).toBe('confirmed');
  });

  it('does not send cancellation-policy marketing through the order review gate', () => {
    const email = {
      subject: 'Changes to our cancellation policy',
      text: 'Review the new cancellation policy and refund options before your next purchase.',
      html: null,
    };

    expect(isCancellationNotice(email)).toBe(false);
    expect(isLikelyOrderMessage(email)).toBe(false);
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

  it('keeps a generic retailer acknowledgement pending until confirmation is explicit', () => {
    const parsed = parseOrderEmail({
      messageId: '<pending@example>',
      fromAddress: 'orders@target.com',
      fromName: 'Target Orders',
      subject: 'We received your order',
      text: 'Order number: 102003715051916\nWe are reviewing your order.',
      html: null,
      receivedAt,
    });

    expect(parsed?.status).toBe('pending');
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

  it('removes trailing separators from an otherwise explicit order number', () => {
    const parsed = parseOrderEmail({
      messageId: '<trailing-order-separator@example>',
      fromAddress: 'orders@example-store.com',
      fromName: 'Example Store',
      subject: 'Your order is confirmed',
      text: 'Order number: AB-12345-\nOrder total: $12.00',
      html: null,
      receivedAt,
    });

    expect(parsed?.orderNumber).toBe('AB-12345');
  });

  it('does not use subtotal as the purchase total when no total is present', () => {
    const parsed = parseOrderEmail({
      messageId: '<subtotal-only@example>',
      fromAddress: 'orders@example-store.com',
      fromName: 'Example Store',
      subject: 'Your order is confirmed',
      text: 'Order number: EX-12001\nSubtotal: $40.00\nShipping: $2.00\nTax: $1.68',
      html: null,
      receivedAt,
    });

    expect(parsed?.totalCents).toBeNull();
  });

  it('parses yearless delivery dates in UTC and rolls them into the next year', () => {
    const parsed = parseOrderEmail({
      messageId: '<yearless-delivery@example>',
      fromAddress: 'orders@example-store.com',
      fromName: 'Example Store',
      subject: 'Your order is confirmed',
      text: 'Order number: EX-12002\nExpected delivery by Friday, January 3',
      html: null,
      receivedAt: new Date('2026-12-20T23:30:00.000Z'),
    });

    expect(parsed?.expectedDelivery?.toISOString()).toBe('2027-01-03T00:00:00.000Z');
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

  it('keeps legitimate product names that resemble shipping, address, or total metadata', () => {
    const parsed = parseOrderEmail({
      messageId: '<metadata-word-products@example>',
      fromAddress: 'orders@example-store.co.uk',
      fromName: 'Orderly Notifications',
      subject: 'Your order is confirmed',
      text: [
        'Order number: EX-12003',
        'Items purchased (3)',
        'Shipping Label Printer',
        'Qty 1',
        'Sesame Street 123 Figure',
        'Qty 1',
        'Product: Total War Collector Edition | Qty: 1 | $59.99',
        'Subtotal: $99.99',
      ].join('\n'),
      html: null,
      receivedAt,
    });

    expect(parsed?.merchant).toBe('Orderly');
    expect(parsed?.items).toEqual([
      { name: 'Shipping Label Printer', quantity: 1, unitPriceCents: null, totalCents: null },
      { name: 'Sesame Street 123 Figure', quantity: 1, unitPriceCents: null, totalCents: null },
      { name: 'Total War Collector Edition', quantity: 1, unitPriceCents: 5999, totalCents: null },
    ]);
  });

  it('uses the registrable merchant label for common country-code domains', () => {
    const parsed = parseOrderEmail({
      messageId: '<country-code-domain@example>',
      fromAddress: 'orders@shop.example.co.uk',
      fromName: null,
      subject: 'Your order is confirmed',
      text: 'Order number: EX-12006\nOrder total: $10.00',
      html: null,
      receivedAt,
    });

    expect(parsed?.merchant).toBe('Example');
  });

  it('does not turn a price after a quantity label into the item quantity', () => {
    const parsed = parseOrderEmail({
      messageId: '<quantity-price-confusion@example>',
      fromAddress: 'orders@example-store.com',
      fromName: 'Example Store',
      subject: 'Your order is confirmed',
      text: [
        'Order number: EX-12004',
        'Items purchased',
        'Mystery Product',
        'Qty: $12.99',
        'Order total: $12.99',
      ].join('\n'),
      html: null,
      receivedAt,
    });

    expect(parsed?.items).toEqual([]);
    expect(parsed?.itemCount).toBeNull();
  });

  it('drops explicit zero-quantity rows instead of coercing them to one', () => {
    const parsed = parseOrderEmail({
      messageId: '<zero-quantity@example>',
      fromAddress: 'orders@example-store.com',
      fromName: 'Example Store',
      subject: 'Your order is confirmed',
      text: 'Order number: EX-12005\nProduct: Removed Item\nQty: 0\nOrder total: $0.00',
      html: null,
      receivedAt,
    });

    expect(parsed?.items).toEqual([]);
    expect(parsed?.itemCount).toBeNull();
  });

  it('does not treat fulfillment labels or delivery addresses as purchased items', () => {
    const parsed = parseOrderEmail({
      messageId: '<target-address-block@example>',
      fromAddress: 'orders@target.com',
      fromName: 'Target',
      subject: 'Your Target order is ready',
      text: [
        'Order number: 912003774472093',
        'Items purchased',
        'Pokémon Trading Card Game: 30th Celebration Tin (Sylveon or Greninja)- Styles May Vary',
        'Qty 2',
        'Delivers to',
        'Anh Dao, 3600 AOLELE ST, UNIT #30234, Honolulu, HI 96820',
        'Qty 2',
        'Order timeline',
      ].join('\n'),
      html: null,
      receivedAt: new Date('2026-09-15T10:15:00.000Z'),
    });

    expect(parsed?.items).toEqual([{
      name: 'Pokémon Trading Card Game: 30th Celebration Tin (Sylveon or Greninja)- Styles May Vary',
      quantity: 2,
      unitPriceCents: null,
      totalCents: null,
    }]);
    expect(parsed?.itemCount).toBe(2);
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

  it('drops retailer links and order-page labels from the item overview', () => {
    const parsed = parseOrderEmail({
      messageId: '<target-link-items@example>',
      fromAddress: 'orders@target.com',
      fromName: 'Target',
      subject: 'Your order is confirmed',
      text: [
        'Order number: 102003715051916',
        'https://click.oe.target.com/?qs=ABCD1234',
        'Qty 1',
        'https://click.oe.target.com/?qs=EFGH5678',
        'Qty 1',
        'Pokémon Trading Card Game: Mega Zygarde ex Premium Collection',
        'Qty 1',
        'View order details',
        'Qty 1',
        'Canceled item',
        'Qty 1',
      ].join('\n'),
      html: null,
      receivedAt,
    });

    expect(parsed?.items).toEqual([{
      name: 'Pokémon Trading Card Game: Mega Zygarde ex Premium Collection',
      quantity: 1,
      unitPriceCents: null,
      totalCents: null,
    }]);
  });

  it('bounds standard receipt item sections before totals and navigation', () => {
    const parsed = parseOrderEmail({
      messageId: '<receipt-sections@example>',
      fromAddress: 'orders@target.com',
      fromName: 'Target',
      subject: 'Order confirmation',
      text: [
        'Order number: 102003715051916',
        'Items 2',
        'https://click.oe.target.com/?qs=ABCD1234',
        'Qty 1',
        'Pokémon Trading Card Game: Mega Zygarde ex Premium Collection',
        'Qty 1',
        'Subtotal $46.43',
        'View order details',
        'https://click.oe.target.com/?qs=footer',
      ].join('\n'),
      html: null,
      receivedAt,
    });

    expect(parsed?.items).toEqual([{
      name: 'Pokémon Trading Card Game: Mega Zygarde ex Premium Collection',
      quantity: 1,
      unitPriceCents: null,
      totalCents: null,
    }]);
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

  it('ignores one-time PIN messages before order parsing', () => {
    const email = {
      messageId: '<pin@example>',
      fromAddress: 'security@example.com',
      fromName: 'Example Security',
      subject: 'Your one-time verification code',
      text: 'Use 482913 to sign in. This code expires in 10 minutes.',
      html: null,
      receivedAt,
    };
    expect(isOneTimePinEmail(email)).toBe(true);
    expect(parseOrderEmail(email)).toBeNull();
  });

  it('skips oversized messages only when their subject is not order-like', () => {
    expect(shouldSkipOversizedMessage('This week in sneakers', 751 * 1024)).toBe(true);
    expect(shouldSkipOversizedMessage('Your order confirmation', 751 * 1024)).toBe(false);
    expect(shouldSkipOversizedText({ subject: 'Newsletter', text: 'news '.repeat(30_000), html: null })).toBe(true);
  });
});
