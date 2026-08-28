import { describe, expect, it } from 'vitest';
import { buildRedactedEnrichmentInput, validateEnrichedOrder } from '../server/workflows/order-enrichment.js';

describe('order enrichment boundary', () => {
  it('redacts addresses and bounds text before a future model call', () => {
    const input = buildRedactedEnrichmentInput({
      messageKey: 'message-1',
      fromAddress: 'orders@example.com',
      subject: 'Order confirmation for buyer@example.com',
      text: 'Contact buyer@example.com for help.',
      receivedAt: new Date('2026-08-20T12:00:00Z'),
    });
    expect(input.fromDomain).toBe('example.com');
    expect(input.subject).not.toContain('buyer@example.com');
    expect(input.bodyExcerpt).not.toContain('buyer@example.com');
    expect(input.bodyExcerpt.length).toBeLessThanOrEqual(6000);
  });

  it('rejects schema-valid-looking AI output without an order identifier', () => {
    expect(validateEnrichedOrder({ merchant: 'Example', status: 'shipped', orderNumber: null, trackingNumber: null }, {
      messageKey: 'message-1',
      receivedAt: new Date('2026-08-20T12:00:00Z'),
    })).toBeNull();
  });
});
