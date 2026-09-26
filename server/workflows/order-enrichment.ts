import type { ParsedOrderEmail, ParsedOrderItem } from '../email/parser.js';

export interface OrderEnrichmentInput {
  messageKey: string;
  fromDomain: string | null;
  subject: string;
  receivedAt: Date;
  bodyExcerpt: string;
  repairAttempt?: number;
  repairFeedback?: string;
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
  deterministicItems?: readonly ParsedOrderItem[];
  /** Compact operator corrections for this retailer; never raw email text. */
  feedbackExamples?: readonly { itemName: string; quantity: number | null }[];
  repairAttempt?: number;
  repairFeedback?: string;
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
export function validateEnrichedOrder(value: unknown, fallback: {
  messageKey: string;
  receivedAt: Date;
  emailTo?: string | null;
  shippingAddress?: string | null;
  paymentMethodType?: string | null;
  paymentLast4?: string | null;
}): ParsedOrderEmail | null {
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
  const expectedDelivery = candidate.expectedDelivery instanceof Date
    ? candidate.expectedDelivery
    : typeof candidate.expectedDelivery === 'string'
      ? new Date(candidate.expectedDelivery)
      : null;
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
    expectedDelivery: expectedDelivery && !Number.isNaN(expectedDelivery.getTime()) ? expectedDelivery : null,
    orderedAt,
    itemCount: items.length > 0 ? items.reduce((total, item) => total + item.quantity, 0) : candidate.itemCount ?? null,
    items,
    emailTo: fallback.emailTo ?? null,
    shippingAddress: fallback.shippingAddress ?? null,
    paymentMethodType: fallback.paymentMethodType ?? null,
    paymentLast4: fallback.paymentLast4 ?? null,
  };
}

/** Validate a model response without allowing it to alter order identity. */
export function validateEnrichedItems(
  value: unknown,
  sourceText?: string,
  deterministicItems: readonly ParsedOrderItem[] = [],
): ParsedOrderItem[] | null {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { items?: unknown }).items)) return null;
  const normalized = normalizeEnrichedItems((value as { items: unknown[] }).items);
  if (sourceText === undefined) return normalized;
  return normalized.filter((item) => isItemGroundedInSource(item, sourceText, deterministicItems));
}

function normalizeEnrichedItems(value: unknown): ParsedOrderItem[] {
  if (!Array.isArray(value)) return [];
  const items = value.slice(0, 50).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const item = entry as Partial<ParsedOrderItem>;
    if (typeof item.name !== 'string' || item.name.trim().length < 2 || isNonProductItemName(item.name)) return [];
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
  const unique = new Map<string, ParsedOrderItem>();
  for (const item of items) {
    const key = item.name.toLowerCase() + '\0' + item.quantity + '\0'
      + (item.unitPriceCents ?? '') + '\0' + (item.totalCents ?? '');
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
}

function isNonProductItemName(value: string): boolean {
  const name = value.trim();
  return /https?:\/\/|www\.|\b(?:href|qs)=|click\.oe\.target\.com/i.test(name)
    || /^(?:view\s+(?:order|cart|details?)(?:\s+(?:order|cart|details?))?|order\s+(?:details|summary)|cancel(?:led|ed)\s+item|more\s+items?\s+to\s+explore|(?:recommended|related|suggested)\s+items?)$/i.test(name)
    || /^(?:video\s+)?games?|toys?(?:\s*&\s*games)?$/i.test(name)
    || /^\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s+[A-Z]{2,5})?$/i.test(name)
    || /^(?:your\s+)?product\s+and\s+delivery\s+information\b|^(?:item\s+subtotal|purchase\s+total|order\s+total|subtotal|estimated\s+delivery|payment\s+method|status)\b/i.test(name)
    || /^(?:shipment\s+arriving|rewards?\s+summary|order\s+created\s+on|need\s+help\b|questions?\s*\?|important\s+information\b|get\s+your\s+order\s+details|your\s+purchase\s+receipt|thanks?\s+for\s+shopping\b)/i.test(name);
}

function isItemGroundedInSource(
  item: ParsedOrderItem,
  sourceText: string,
  deterministicItems: readonly ParsedOrderItem[],
): boolean {
  const normalizedName = normalizeItemEvidenceText(item.name);
  if (!normalizedName) return false;
  if (deterministicItems.some((candidate) =>
    normalizeItemEvidenceText(candidate.name) === normalizedName && candidate.quantity === item.quantity)) return true;

  const lines = sourceText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const namePrefix = normalizedName.split(' ').slice(0, 3).join(' ');
  for (let index = 0; index < lines.length; index += 1) {
    if (!normalizeItemEvidenceText(lines[index]).includes(namePrefix)) continue;
    const nearbyRows = lines.slice(index, index + 3).join(' ');
    if (!normalizeItemEvidenceText(nearbyRows).includes(normalizedName)) continue;
    // New or quantity-corrected AI rows are accepted only when the same row
    // block explicitly contains that exact quantity. This prevents nearby
    // timestamps, subtotals, and delivery headings from donating quantities.
    const details = lines.slice(index, index + 4).join(' ');
    const quantities = [...details.matchAll(/(?:qty|quantity)(?:\s+ordered)?\s*[:#=.-]?\s*(\d{1,3})\b/gi)]
      .map((match) => Number.parseInt(match[1], 10));
    if (quantities.includes(item.quantity)) return true;
  }
  return false;
}

function normalizeItemEvidenceText(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function buildRedactedEnrichmentInput(input: {
  messageKey: string;
  fromAddress: string;
  subject: string;
  text: string;
  receivedAt: Date;
  repairAttempt?: number;
  repairFeedback?: string;
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
    repairAttempt: input.repairAttempt,
    repairFeedback: input.repairFeedback,
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
  deterministicItems?: readonly ParsedOrderItem[];
  feedbackExamples?: readonly { itemName: string; quantity: number | null }[];
  repairAttempt?: number;
  repairFeedback?: string;
}): OrderItemReviewInput {
  const fromDomain = input.fromAddress.split('@')[1]?.toLowerCase() ?? null;
  return {
    messageKey: input.messageKey,
    fromDomain,
    subject: redactMailboxText(input.subject).slice(0, 500),
    merchant: input.merchant.slice(0, 120),
    orderNumber: input.orderNumber,
    deterministicItems: input.deterministicItems,
    feedbackExamples: input.feedbackExamples,
    repairAttempt: input.repairAttempt,
    repairFeedback: input.repairFeedback,
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
    .filter((line) => !/(?:^|,)\s*\d{1,6}\s+[^,]+\b(?:street|st\.?|road|rd\.?|avenue|ave\.?|boulevard|blvd\.?|drive|dr\.?|lane|ln\.?|unit|suite|apt\.?)\b/i.test(line))
    .filter((line) => !/,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/.test(line))
    .filter((line) => !/^(?:delivers?|delivered|ships?|shipping|delivery)\s+to\b/i.test(line))
    .join('\n')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi, '[redacted-email]')
    .replace(/(?:\+?\d[\d\s().-]{8,}\d)/g, '[redacted-phone]')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
