import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRedactedEnrichmentInput, validateEnrichedOrder } from '../server/workflows/order-enrichment.js';
import { runOrderIngestion } from '../server/workflows/order-ingestion.js';
import type { ParsedOrderEmail } from '../server/email/parser.js';
import type { Repository } from '../server/database/repository.js';
import { OpenAIOrderEnrichmentProvider } from '../server/workflows/openai-order-review.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it('uses AI only to fill ambiguous items and keeps deterministic status/identity', async () => {
    const deterministic: ParsedOrderEmail = {
      messageKey: 'message-1',
      merchant: 'Walmart',
      orderNumber: '200001234567890',
      status: 'confirmed',
      totalCents: 17900,
      currency: 'USD',
      trackingNumber: null,
      carrier: null,
      trackingUrl: null,
      expectedDelivery: null,
      orderedAt: new Date('2026-08-20T12:00:00Z'),
      itemCount: null,
      items: [],
    };
    let stored: ParsedOrderEmail | null = null;
    const repository = {
      recordMessage: async (_workspaceId: string, _customerId: string, _meta: unknown, order: ParsedOrderEmail | null) => {
        stored = order;
        return true;
      },
    } as unknown as Repository;
    const result = await runOrderIngestion('workspace', 'customer', {
      messageId: 'message-1',
      fromAddress: 'orders@walmart.com',
      fromName: 'Walmart',
      subject: 'Your order is confirmed',
      text: 'Order number: 200001234567890',
      html: null,
      receivedAt: deterministic.orderedAt,
    }, {
      messageKey: 'message-1',
      fromAddress: 'orders@walmart.com',
      subject: 'Your order is confirmed',
      receivedAt: deterministic.orderedAt,
    }, {
      repository,
      parse: () => deterministic,
      itemReviewBudget: { remaining: 1 },
      enricher: {
        name: 'test-reviewer',
        enrich: async () => null,
        reviewItems: async () => ({
          items: [{ name: 'Apple AirPods 4', quantity: 1, unitPriceCents: 17900, totalCents: null }],
        }),
      },
    });

    expect(result).toMatchObject({ matched: true, source: 'ai', validation: 'accepted' });
    expect(stored).toMatchObject({
      merchant: 'Walmart',
      orderNumber: '200001234567890',
      status: 'confirmed',
      items: [{ name: 'Apple AirPods 4', quantity: 1, unitPriceCents: 17900 }],
    });
  });

  it('runs the nano item review when a retailer template includes link chrome', async () => {
    const deterministic: ParsedOrderEmail = {
      messageKey: 'message-link-noise',
      merchant: 'Target',
      orderNumber: '102003715051916',
      status: 'confirmed',
      totalCents: 4643,
      currency: 'USD',
      trackingNumber: null,
      carrier: null,
      trackingUrl: null,
      expectedDelivery: null,
      orderedAt: new Date('2026-08-20T12:00:00Z'),
      itemCount: 1,
      items: [{ name: 'Pokémon Trading Card Game', quantity: 1, unitPriceCents: null, totalCents: null }],
    };
    let reviewCalls = 0;
    const repository = {
      recordMessage: async () => true,
    } as unknown as Repository;
    const result = await runOrderIngestion('workspace', 'customer', {
      messageId: 'message-link-noise',
      fromAddress: 'orders@target.com',
      fromName: 'Target',
      subject: 'Your order is confirmed',
      text: 'Order number: 102003715051916\nhttps://click.oe.target.com/?qs=redacted\nPokémon Trading Card Game\nQty 1',
      html: null,
      receivedAt: deterministic.orderedAt,
    }, {
      messageKey: 'message-link-noise',
      fromAddress: 'orders@target.com',
      subject: 'Your order is confirmed',
      receivedAt: deterministic.orderedAt,
    }, {
      repository,
      parse: () => deterministic,
      itemReviewBudget: { remaining: 1 },
      enricher: {
        name: 'test-reviewer',
        enrich: async () => null,
        reviewItems: async () => {
          reviewCalls += 1;
          return { items: [{ name: 'Pokémon Trading Card Game', quantity: 1, unitPriceCents: null, totalCents: null }] };
        },
      },
    });

    expect(result.source).toBe('ai');
    expect(reviewCalls).toBe(1);
  });

  it('sends a structured, redacted item-review request and reads Responses output', async () => {
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('gpt-5-nano');
      expect(body.store).toBe(false);
      expect(body.text.format.type).toBe('json_schema');
      expect(body.input).not.toContain('buyer@example.com');
      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          items: [{ name: 'Air Max 90', quantity: 1, unitPriceCents: 12000, totalCents: null }],
        }),
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIOrderEnrichmentProvider('test-key');
    const result = await provider.reviewItems({
      messageKey: 'message-1',
      fromDomain: 'example.com',
      subject: 'Order confirmation',
      merchant: 'Example',
      orderNumber: 'EX-12001',
      receivedAt: new Date('2026-08-20T12:00:00Z'),
      bodyExcerpt: 'Product: Air Max 90\nQty: 1\n$120.00',
    });

    expect(result).toEqual({ items: [{ name: 'Air Max 90', quantity: 1, unitPriceCents: 12000, totalCents: null }] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
