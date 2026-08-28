import type { ParsedOrderEmail } from '../email/parser.js';

export interface OrderEnrichmentInput {
  messageKey: string;
  fromDomain: string | null;
  subject: string;
  receivedAt: Date;
  bodyExcerpt: string;
}

export interface OrderEnrichmentProvider {
  readonly name: string;
  enrich(input: OrderEnrichmentInput): Promise<unknown>;
}

/** The safe default keeps every mailbox sync deterministic and network-free. */
export class NoopOrderEnrichmentProvider implements OrderEnrichmentProvider {
  readonly name = 'none';

  async enrich(_input: OrderEnrichmentInput): Promise<null> {
    return null;
  }
}

/**
 * AI adapters return unknown data on purpose. The workflow validates it before
 * any repository call, and only the normalized order is ever persisted.
 */
export function validateEnrichedOrder(value: unknown, fallback: { messageKey: string; receivedAt: Date }): ParsedOrderEmail | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<ParsedOrderEmail>;
  if (typeof candidate.merchant !== 'string' || candidate.merchant.trim().length < 2) return null;
  if (!candidate.status || !['confirmed', 'processing', 'shipped', 'delivered', 'cancelled'].includes(candidate.status)) return null;
  if (candidate.orderNumber !== null && candidate.orderNumber !== undefined && typeof candidate.orderNumber !== 'string') return null;
  if (candidate.trackingNumber !== null && candidate.trackingNumber !== undefined && typeof candidate.trackingNumber !== 'string') return null;
  if (candidate.totalCents !== null && candidate.totalCents !== undefined && (!Number.isInteger(candidate.totalCents) || candidate.totalCents < 0)) return null;
  const orderedAt = candidate.orderedAt instanceof Date ? candidate.orderedAt : new Date(String(candidate.orderedAt ?? fallback.receivedAt.toISOString()));
  if (Number.isNaN(orderedAt.getTime())) return null;
  const orderNumber = typeof candidate.orderNumber === 'string' ? candidate.orderNumber.trim().toUpperCase() : null;
  const trackingNumber = typeof candidate.trackingNumber === 'string' ? candidate.trackingNumber.trim().toUpperCase() : null;
  if (!orderNumber && !trackingNumber) return null;
  return {
    messageKey: fallback.messageKey,
    merchant: candidate.merchant.trim().slice(0, 120),
    orderNumber,
    status: candidate.status,
    totalCents: candidate.totalCents ?? null,
    currency: typeof candidate.currency === 'string' && /^[A-Z]{3}$/.test(candidate.currency.toUpperCase())
      ? candidate.currency.toUpperCase()
      : 'USD',
    trackingNumber,
    carrier: typeof candidate.carrier === 'string' ? candidate.carrier.trim().slice(0, 80) || null : null,
    trackingUrl: typeof candidate.trackingUrl === 'string' && /^https?:\/\//i.test(candidate.trackingUrl) ? candidate.trackingUrl.slice(0, 1000) : null,
    expectedDelivery: candidate.expectedDelivery instanceof Date && !Number.isNaN(candidate.expectedDelivery.getTime()) ? candidate.expectedDelivery : null,
    orderedAt,
  };
}

export function buildRedactedEnrichmentInput(input: {
  messageKey: string;
  fromAddress: string;
  subject: string;
  text: string;
  receivedAt: Date;
}): OrderEnrichmentInput {
  const fromDomain = input.fromAddress.split('@')[1]?.toLowerCase() ?? null;
  const redactEmails = (value: string) => value.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi, '[redacted-email]');
  const subject = redactEmails(input.subject).slice(0, 500);
  const bodyExcerpt = `${subject}\n${input.text}`
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi, '[redacted-email]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 6_000);
  return {
    messageKey: input.messageKey,
    fromDomain,
    subject,
    receivedAt: input.receivedAt,
    bodyExcerpt,
  };
}
