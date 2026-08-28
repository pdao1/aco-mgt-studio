import type { ParsedOrderEmail, ParsedOrderItem } from '../email/parser.js';

export interface OrderEnrichmentInput {
  messageKey: string;
  fromDomain: string | null;
  subject: string;
  receivedAt: Date;
  bodyExcerpt: string;
}

/**
 * A deliberately narrower input used when the deterministic parser already
 * established the order identity/status and only the item rows are unclear.
 * The model never receives the mailbox credential, full headers, or raw HTML.
 */
export interface OrderItemReviewInput {
  messageKey: string;
  fromDomain: string | null;
  subject: string;
  merchant: string;
  orderNumber: string | null;
  receivedAt: Date;
  bodyExcerpt: string;
}

export interface OrderEnrichmentProvider {
  readonly name: string;
  enrich(input: OrderEnrichmentInput): Promise<unknown>;
  reviewItems?(input: OrderItemReviewInput): Promise<unknown>;
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
  if (!candidate.status || !['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'].includes(candidate.status)) return null;
  if (candidate.orderNumber !== null && candidate.orderNumber !== undefined && typeof candidate.orderNumber !== 'string') return null;
  if (candidate.trackingNumber !== null && candidate.trackingNumber !== undefined && typeof candidate.trackingNumber !== 'string') return null;
  if (candidate.totalCents !== null && candidate.totalCents !== undefined && (!Number.isInteger(candidate.totalCents) || candidate.totalCents < 0)) return null;
  if (candidate.itemCount !== null && candidate.itemCount !== undefined && (!Number.isInteger(candidate.itemCount) || candidate.itemCount < 0 || candidate.itemCount > 10_000)) return null;
  if (candidate.items !== null && candidate.items !== undefined && !Array.isArray(candidate.items)) return null;
  const items = normalizeEnrichedItems(candidate.items);
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
    itemCount: items.length > 0 ? items.reduce((total, item) => total + item.quantity, 0) : candidate.itemCount ?? null,
    items,
  };
}

/** Validate a model response without allowing it to alter order identity. */
export function validateEnrichedItems(value: unknown): ParsedOrderItem[] | null {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { items?: unknown }).items)) return null;
  return normalizeEnrichedItems((value as { items: unknown[] }).items);
}

function normalizeEnrichedItems(value: unknown): ParsedOrderItem[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const item = entry as Partial<ParsedOrderItem>;
    if (typeof item.name !== 'string' || item.name.trim().length < 2) return [];
    const quantity = item.quantity === undefined ? 1 : item.quantity;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000) return [];
    const unitPriceCents = item.unitPriceCents === null || item.unitPriceCents === undefined ? null : item.unitPriceCents;
    const totalCents = item.totalCents === null || item.totalCents === undefined ? null : item.totalCents;
    if ((unitPriceCents !== null && (!Number.isInteger(unitPriceCents) || unitPriceCents < 0))
      || (totalCents !== null && (!Number.isInteger(totalCents) || totalCents < 0))) return [];
    return [{
      name: item.name.trim().slice(0, 240),
      quantity,
      unitPriceCents,
      totalCents,
    }];
  });
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
  const bodyExcerpt = redactMailboxText(`${subject}\n${input.text}`).slice(0, 6_000);
  return {
    messageKey: input.messageKey,
    fromDomain,
    subject,
    receivedAt: input.receivedAt,
    bodyExcerpt,
  };
}

export function buildRedactedItemReviewInput(input: {
  messageKey: string;
  fromAddress: string;
  subject: string;
  text: string;
  receivedAt: Date;
  merchant: string;
  orderNumber: string | null;
}): OrderItemReviewInput {
  const fromDomain = input.fromAddress.split('@')[1]?.toLowerCase() ?? null;
  return {
    messageKey: input.messageKey,
    fromDomain,
    subject: redactMailboxText(input.subject).slice(0, 500),
    merchant: input.merchant.slice(0, 120),
    orderNumber: input.orderNumber,
    receivedAt: input.receivedAt,
    // Keep line breaks: they are often the only signal separating a product
    // row from a retailer's navigation/recommendation copy.
    bodyExcerpt: redactMailboxText(input.text).slice(0, 6_000),
  };
}

function redactMailboxText(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => !/(?:app\s+password|password|passcode|credit\s+card|card\s+(?:ending|number)|cvv|security\s+code|billing\s+address|shipping\s+address)/i.test(line))
    .join('\n')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi, '[redacted-email]')
    .replace(/(?:\+?\d[\d\s().-]{8,}\d)/g, '[redacted-phone]')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
