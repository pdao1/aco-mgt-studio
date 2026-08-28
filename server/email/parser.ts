import { createHash } from 'node:crypto';

export type ParsedOrderStatus = 'pending' | 'confirmed' | 'processing' | 'shipped' | 'delivered' | 'cancelled';

export interface EmailInput {
  messageId: string | null;
  fromAddress: string;
  fromName: string | null;
  subject: string;
  text: string;
  html: string | null;
  receivedAt: Date;
}

export interface ParsedOrderEmail {
  messageKey: string;
  merchant: string;
  orderNumber: string | null;
  status: ParsedOrderStatus;
  totalCents: number | null;
  currency: string;
  trackingNumber: string | null;
  carrier: string | null;
  trackingUrl: string | null;
  expectedDelivery: Date | null;
  orderedAt: Date;
  itemCount: number | null;
  items: ParsedOrderItem[];
}

export interface ParsedOrderItem {
  name: string;
  quantity: number;
  unitPriceCents: number | null;
  totalCents: number | null;
}

export interface EmailParseContext {
  /** Existing order numbers from this customer used for historical matching. */
  knownOrderNumbers?: readonly string[];
}

const orderPatterns = [
  /(?:order|purchase)\s*(?:number|no\.?|#|id)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{4,})/i,
  /(?:order|purchase)\s+confirmation\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{4,})/i,
  /confirmation\s*(?:number|no\.?|#|id)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{4,})/i,
  /(?:order|purchase)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{4,})/i,
  /(?:order|purchase)\s+(?:was|has\s+been|is(?:\s+now)?)\s+(?:cancelled|canceled)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{4,})/i,
  /(?:order|purchase)\s+(?:cancellation|cancelled|canceled)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{4,})/i,
  /(?:cancellation|cancelled|canceled|refund(?:ed)?)[^\r\n]{0,100}?\b(?:order|purchase)\s*(?:number|no\.?|#|id)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{4,})/i,
  /(?:your\s+order\s+)([A-Z0-9][A-Z0-9-]{4,})/i,
];

const trackingPatterns: Array<{ carrier: string; pattern: RegExp; capture?: number; url: (value: string) => string | null }> = [
  { carrier: 'UPS', pattern: /\b1Z[A-Z0-9]{16}\b/i, url: (value) => `https://www.ups.com/track?tracknum=${encodeURIComponent(value)}` },
  { carrier: 'Amazon Logistics', pattern: /\bTBA\d{10,15}\b/i, url: () => null },
  { carrier: 'USPS', pattern: /\b(?:9[2345]\d{18,20}|[A-Z]{2}\d{9}US)\b/i, url: (value) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(value)}` },
  { carrier: 'FedEx', pattern: /(?:tracking\s*(?:number|no\.?|#)?|fedex)[^\d]{0,24}(\d{12}|\d{15}|\d{20}|\d{22})\b/i, capture: 1, url: (value) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(value)}` },
];

const merchantAliases: Array<[RegExp, string]> = [
  [/(?:^|\.)amazon\./i, 'Amazon'],
  [/(?:^|\.)nike\./i, 'Nike'],
  [/(?:^|\.)adidas\./i, 'adidas'],
  [/(?:^|\.)target\./i, 'Target'],
  [/(?:^|\.)walmart\./i, 'Walmart'],
  [/(?:^|\.)bestbuy\./i, 'Best Buy'],
  [/(?:^|\.)footlocker\./i, 'Foot Locker'],
  [/(?:^|\.)stockx\./i, 'StockX'],
  [/(?:^|\.)supremenewyork\./i, 'Supreme'],
];

export function parseOrderEmail(input: EmailInput, context: EmailParseContext = {}): ParsedOrderEmail | null {
  const plain = normalizeText(`${input.subject}\n${input.text}\n${stripHtml(input.html ?? '')}`);
  if (!looksOrderRelated(plain)) return null;

  const status = parseStatus(input.subject, plain);
  // Prefer an exact customer-history match over a newly guessed token. This
  // is what lets a cancellation/shipment notice from a different retailer
  // sender update the existing order instead of creating a second row.
  const historicalOrderNumber = findKnownOrderNumber(plain, context.knownOrderNumbers ?? []);
  const orderNumber = historicalOrderNumber ?? firstOrderNumber(plain);
  const tracking = findTracking(plain);
  const items = parseItems(plain);
  const messageKey = input.messageId?.trim() || createHash('sha256')
    .update(`${input.fromAddress}\0${input.subject}\0${input.receivedAt.toISOString()}\0${plain.slice(0, 2000)}`)
    .digest('hex');

  if (!orderNumber && !tracking) return null;

  return {
    messageKey,
    merchant: parseMerchant(input.fromAddress, input.fromName),
    orderNumber,
    status,
    totalCents: parseTotal(plain),
    currency: 'USD',
    trackingNumber: tracking?.trackingNumber ?? null,
    carrier: tracking?.carrier ?? parseCarrierName(plain),
    trackingUrl: tracking?.trackingUrl ?? findTrackingUrl(input.html ?? input.text),
    expectedDelivery: parseExpectedDelivery(plain, input.receivedAt),
    orderedAt: input.receivedAt,
    itemCount: items.length > 0 ? items.reduce((total, item) => total + item.quantity, 0) : parseItemCount(plain),
    items,
  };
}

function looksOrderRelated(text: string): boolean {
  const signals = [
    /\border (?:confirmed|confirmation|number|#|has shipped|is on the way)\b/i,
    /\b(?:order|purchase|confirmation)\s*(?:number|no\.?|#|id)\b/i,
    /\b(?:order|purchase)\s*[:#-]?\s*[A-Z0-9][A-Z0-9-]{4,}\b/i,
    /\btracking (?:number|#|information|details)\b/i,
    /\b(?:shipment|package) (?:has shipped|is on the way|was delivered|delivered)\b/i,
    /\bthanks? for your (?:order|purchase)\b/i,
    /\bexpected delivery\b/i,
    /\b(?:order|purchase|shipment|item)\b[\s\S]{0,100}\b(?:cancelled|canceled|cancellation|refund(?:ed)?)\b/i,
    /\b(?:cancelled|canceled|cancellation|refund(?:ed)?)\b[\s\S]{0,100}\b(?:order|purchase|shipment|item)\b/i,
    /\b(?:cancelled|canceled|cancellation)\b/i,
  ];
  return signals.some((signal) => signal.test(text));
}

function parseStatus(subject: string, text: string): ParsedOrderStatus {
  const normalizedSubject = subject.toLowerCase();
  if (/cancelled|canceled|cancellation|refund(?:ed)?/.test(normalizedSubject)
    // Keep cancellation matching on one rendered line. Looking across
    // arbitrary newlines turns a product name such as "Noise Cancellation"
    // into a cancelled order simply because an order number appeared earlier
    // in the email.
    || /\b(?:order|purchase|shipment)\b[^\r\n]{0,120}\b(?:cancelled|canceled|cancellation|refund(?:ed)?)\b/i.test(text)
    || /\b(?:cancelled|canceled|cancellation|refund(?:ed)?)\b[^\r\n]{0,120}\b(?:order|purchase|shipment)\b/i.test(text)) return 'cancelled';
  if (/delivered/.test(normalizedSubject) || /\b(?:package|order|shipment) (?:was |has been )?delivered\b/i.test(text)) return 'delivered';
  if (/shipped|on the way|in transit|out for delivery/.test(normalizedSubject) || /\b(?:has shipped|shipped via|tracking number)\b/i.test(text)) return 'shipped';
  if (/processing|preparing|getting your order ready/.test(normalizedSubject) || /\bpreparing (?:your )?(?:order|shipment)\b/i.test(text)) return 'processing';
  // A generic order acknowledgement is not proof that the retailer accepted
  // the order. Keep it pending until a matching confirmation message arrives.
  // The explicit confirmation check is intentionally narrow so phrases such
  // as "confirmation link" or "order information" do not promote an order.
  if (/\border\s+(?:confirmation|confirmed)\b|\b(?:order|purchase)\s+(?:is|was|has\s+been)\s+confirmed\b|\bconfirmation\s+(?:number|#|id)\b/i.test(`${subject}\n${text}`)) {
    return 'confirmed';
  }
  return 'pending';
}

function findTracking(text: string) {
  for (const candidate of trackingPatterns) {
    const match = text.match(candidate.pattern);
    if (match) {
      const trackingNumber = match[candidate.capture ?? 0].toUpperCase();
      return { carrier: candidate.carrier, trackingNumber, trackingUrl: candidate.url(trackingNumber) };
    }
  }
  return null;
}

function parseCarrierName(text: string): string | null {
  if (/\bUPS\b/i.test(text)) return 'UPS';
  if (/\bFedEx\b/i.test(text)) return 'FedEx';
  if (/\bUSPS\b|United States Postal Service/i.test(text)) return 'USPS';
  if (/\bDHL\b/i.test(text)) return 'DHL';
  return null;
}

function parseMerchant(fromAddress: string, fromName: string | null): string {
  const domain = fromAddress.split('@')[1]?.toLowerCase() ?? '';
  const alias = merchantAliases.find(([pattern]) => pattern.test(domain));
  if (alias) return alias[1];
  const cleanedName = fromName?.replace(/(?:orders?|shipping|notifications?|customer service)/gi, '').trim();
  if (cleanedName && cleanedName.length >= 2) return cleanedName.slice(0, 80);
  const domainName = domain.split('.').slice(-2, -1)[0] || domain.split('.')[0] || 'Store';
  return domainName.charAt(0).toUpperCase() + domainName.slice(1);
}

function parseTotal(text: string): number | null {
  const matches = [...text.matchAll(/(?:order\s+total|grand\s+total|total)\s*:?\s*(?:USD\s*)?\$\s*([\d,]+\.\d{2})/gi)];
  const value = matches.at(-1)?.[1];
  if (!value) return null;
  const amount = Number.parseFloat(value.replace(/,/g, ''));
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function parseExpectedDelivery(text: string, receivedAt: Date): Date | null {
  const match = text.match(/(?:expected|estimated|scheduled)\s+(?:delivery|arrival)(?:\s+date)?\s*:?\s*(?:by\s+)?([A-Za-z]{3,9}\s+\d{1,2}(?:,\s+\d{4})?)/i);
  if (!match) return null;
  const withYear = /\d{4}/.test(match[1]) ? match[1] : `${match[1]}, ${receivedAt.getUTCFullYear()}`;
  const parsed = new Date(withYear);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.getTime() < receivedAt.getTime() - 30 * 86_400_000) parsed.setUTCFullYear(parsed.getUTCFullYear() + 1);
  return parsed;
}

function parseItems(text: string): ParsedOrderItem[] {
  const rawLines = text.split(/\n+/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const lines = boundReceiptItemSection(rawLines);
  const items: ParsedOrderItem[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const labelled = line.match(/^(?:item|product|description|title)(?:\s+\d+)?\s*[:#-]\s*(.+)$/i);
    // Retailer HTML tables often split a product, quantity, and price across
    // three separate cells/lines. Keep the look-ahead small and only use it
    // for the current product row; value-only lines are filtered below.
    const nextLines: string[] = [];
    for (const candidate of lines.slice(index + 1, index + 4)) {
      if (/^(?:item|product|description|title)(?:\s+\d+)?\s*[:#-]/i.test(candidate)) break;
      // Once quantity/price evidence has appeared, the next descriptive line
      // is a new product row. Without this boundary, the last price in the
      // look-ahead window can be borrowed from the following item.
      if (nextLines.length > 0
        && hasItemEvidence(nextLines.join(' | '))
        && (isMetadataLine(candidate) || looksLikeItemStart(candidate))) break;
      nextLines.push(candidate);
    }
    const adjacentDetails = nextLines.join(' | ');
    const parsed = parseItemLine(labelled?.[1] ?? line, Boolean(labelled), adjacentDetails);
    if (parsed) {
      items.push(parsed);
      continue;
    }
    if (labelled || isMetadataLine(line) || isNarrativeLine(line) || isValueOnlyLine(line)) continue;

    // Common retailer layout: product name on one line, followed by Qty and
    // price on the next one or two lines. Quantity is required for an
    // unlabelled row; a lone dollar amount is often recommendation/upsell
    // content rather than an item in the order.
    if (adjacentDetails && /(?:qty|quantity)\b/i.test(adjacentDetails)) {
      const following = parseItemLine(`${line} | ${adjacentDetails}`, false, '');
      if (following) items.push(following);
    }
  }

  const deduplicated = new Map<string, ParsedOrderItem>();
  for (const item of items) {
    const key = `${item.name.toLowerCase()}\0${item.quantity}\0${item.unitPriceCents ?? ''}\0${item.totalCents ?? ''}`;
    if (!deduplicated.has(key)) deduplicated.set(key, item);
  }
  return [...deduplicated.values()].slice(0, 50);
}

/**
 * Retailer receipts follow the same broad structure: order header, purchased
 * line items, then totals/fulfillment and navigation. Once an item section is
 * identifiable, do not let footer links or summary labels become candidates.
 * Fixtures without a heading continue to use the conservative row parser.
 */
function boundReceiptItemSection(lines: string[]): string[] {
  const start = lines.findIndex((line) => /^(?:items?|products?)\s*(?:purchased|ordered)?(?:\s*[:#-]?\s*\d{1,3})?$/i.test(line));
  if (start < 0) return lines;
  const end = lines.slice(start + 1).findIndex((line) => /^(?:subtotal|shipping|delivery|tax|grand\s+total|order\s+total|payment|billing|view\s+(?:order|cart|details?)|cancel(?:led|ed)\s+item)\b/i.test(line));
  return end < 0 ? lines.slice(start) : lines.slice(start, start + 1 + end);
}

function parseItemLine(value: string, labelled: boolean, adjacentDetails: string): ParsedOrderItem | null {
  const line = value.replace(/^[-*•]\s*/, '').trim();
  if (!line || (!labelled && (isMetadataLine(line) || isNarrativeLine(line)))) return null;

  const detailText = `${line}${adjacentDetails ? ` | ${adjacentDetails}` : ''}`;
  const quantityMatch = detailText.match(/(?:^|[|\s])(?:qty|quantity)\b[^\d]{0,20}(\d{1,3})\b/i)
    ?? detailText.match(/^(\d{1,3})\s*[x×]\s+/i);
  const quantity = quantityMatch ? Math.max(1, Number.parseInt(quantityMatch[1], 10)) : 1;
  const lineMoneyMatches = [...line.matchAll(/\$\s*([\d,]+\.\d{2})/g)];
  const moneyMatches = lineMoneyMatches.length > 0
    ? lineMoneyMatches
    : [...detailText.matchAll(/\$\s*([\d,]+\.\d{2})/g)];
  // Do not guess that arbitrary prose containing a price is an item. A row
  // must carry an explicit product label or quantity evidence.
  if (!labelled && !quantityMatch) return null;

  const parts = line.split('|').map((part) => part.trim()).filter(Boolean);
  let name = parts.find((part) => !/(?:qty|quantity|sku|price|total)\s*[:#=-]?/i.test(part) && !/^\$?[\d,]+(?:\.\d{2})?$/.test(part)) ?? line;
  name = name
    .replace(/^(?:\d{1,3})\s*[x×]\s*/i, '')
    .replace(/(?:qty|quantity)\s*[:#=-]?\s*\d{1,3}\b/gi, '')
    .replace(/\$\s*[\d,]+\.\d{2}/g, '')
    .replace(/^\s*[)\]}]+\s*/, '')
    // Inline styles can leak into a text-only MIME part. Remove only obvious
    // CSS property tokens at the beginning, never arbitrary words in a name.
    .replace(/^(?:border(?:-[a-z]+)?|background(?:-[a-z]+)?|padding|margin|font(?:-[a-z]+)?|color|display|width|height)\s*[:=-]?\s+/i, '')
    .replace(/\s*[-—–:]\s*$/, '')
    .replace(/[({\[]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (name.length < 2 || name.length > 240 || !/[A-Za-z]/.test(name)
    || isMetadataLine(name) || isNarrativeLine(name) || isValueOnlyLine(name)
    || isNonProductLine(name)) return null;

  const price = moneyMatches.at(-1)?.[1];
  const priceCents = price ? parseMoneyCents(price) : null;
  const hasTotalLabel = /(?:line|item|product)\s+total\s*[:#=-]?|total\s*[:#=-]?/i.test(lineMoneyMatches.length > 0 ? line : detailText);
  return {
    name,
    quantity,
    unitPriceCents: priceCents !== null && !hasTotalLabel ? priceCents : null,
    totalCents: priceCents !== null && hasTotalLabel ? priceCents : null,
  };
}

function parseItemCount(text: string): number | null {
  const match = text.match(/^(?:items?|products?)\s*(?:ordered)?\s*[:#=-]\s*(\d{1,3})\b/im)
    ?? text.match(/^(?:total\s+)?(?:qty|quantity)\s*[:#=-]\s*(\d{1,3})\b/im);
  if (!match) return null;
  const count = Number.parseInt(match[1], 10);
  return Number.isInteger(count) && count > 0 ? count : null;
}

function parseMoneyCents(value: string): number | null {
  const amount = Number.parseFloat(value.replace(/,/g, ''));
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function isMetadataLine(value: string): boolean {
  return /^(?:order|confirmation|subtotal|shipping|delivery|tax|grand\s+total|total|payment|billing|shipping\s+address|billing\s+address|tracking|status|date|email|phone|credit\s+card|qty|quantity|items?|products?)\b/i.test(value);
}

function isValueOnlyLine(value: string): boolean {
  return /^[$€£]?\s*[\d,]+(?:\.\d{2})?$/.test(value.trim());
}

function isNarrativeLine(value: string): boolean {
  return /^(?:your|we|thanks?|thank\s+you|hi|hello)\b[\s\S]*\b(?:order|purchase|shipment|delivery)\b[\s\S]*\b(?:confirmed|received|placed|ready|shipped|delivered|cancelled|canceled)\b/i.test(value.trim());
}

function isNonProductLine(value: string): boolean {
  return /^(?:more\s+items?\s+to\s+explore|(?:recommended|related|suggested)\s+items?|(?:video\s+)?games?|toys?(?:\s*&\s*games)?|shop\s+now|view\s+(?:order|cart|details?)(?:\s+(?:order|cart|details?))?|order\s+details|order\s+summary|cancel(?:led|ed)\s+item)$/i.test(value.trim())
    || /(?:item\s+border|border\s+item|background-color|font-size|padding-top)/i.test(value)
    || /^(?:border|background|padding|margin|font|color|display|width|height)\b/i.test(value.trim())
    // Links and query-string fragments are navigation/analytics content, not
    // merchandise. Reject them before quantity look-ahead can turn them into
    // a fake product row (for example Target's click.oe.target.com links).
    || /https?:\/\/|www\.|\b(?:href|qs)=/i.test(value)
    || /(?:click\.oe\.target\.com|[?&][a-z0-9_-]+=)/i.test(value);
}

function hasItemEvidence(value: string): boolean {
  return /(?:qty|quantity)\b[^\d]{0,20}\d{1,3}\b/i.test(value)
    || /\$\s*[\d,]+\.\d{2}/.test(value);
}

function looksLikeItemStart(value: string): boolean {
  return !isMetadataLine(value)
    && !isNarrativeLine(value)
    && !isValueOnlyLine(value)
    && !/^(?:color|colour|size|variant|style|sku|model|condition|each)\b/i.test(value)
    && /[A-Za-z]/.test(value);
}

function findTrackingUrl(value: string): string | null {
  const urls = value.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
  return urls.find((url) => /ups\.com|fedex\.com|usps\.com|dhl\.com|track(?:ing)?/i.test(url))?.replace(/&amp;/g, '&') ?? null;
}

function firstOrderNumber(value: string): string | null {
  for (const pattern of orderPatterns) {
    const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const match of value.matchAll(globalPattern)) {
      const candidate = normalizeOrderNumber(match[1]);
      if (candidate) return candidate;
    }
  }
  return null;
}

function findKnownOrderNumber(value: string, knownOrderNumbers: readonly string[]): string | null {
  const candidates = [...new Set(knownOrderNumbers.map(normalizeOrderNumber).filter((candidate): candidate is string => Boolean(candidate)))]
    .sort((left, right) => right.length - left.length);
  for (const candidate of candidates) {
    const pattern = new RegExp(`(?<![A-Z0-9])${escapeRegExp(candidate)}(?![A-Z0-9])`, 'i');
    if (pattern.test(value)) return candidate;
  }
  return null;
}

function normalizeOrderNumber(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toUpperCase();
  if (normalized.length < 5
    // An order identifier must contain a digit. Without this guard, prose
    // such as "order confirmation", "order ending", and "order cutoff"
    // becomes a fabricated order row.
    || !/\d/.test(normalized)
    || /^(?:ORDER|PURCHASE|NUMBER|CONFIRM(?:ED|ATION)?|CANCEL(?:LED|ED|LATION)?|REFUND(?:ED)?|WAS|HAS|BEEN|SHIPPED|SHIPPING|DELIVERED|DELIVERY|TRACKING|PACKAGE|SHIPMENT|PROCESSING|IS|NOW|YOUR|THE|THIS|THAT|FOR|FROM|WITH|ASSOCIATED|REQUEST|COMPLETE|COMPLETED)$/.test(normalized)) return null;
  return normalized;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/?(?:br|p|div|li|tr|td|th|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function normalizeText(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
