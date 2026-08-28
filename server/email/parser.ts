import { createHash } from 'node:crypto';

export type ParsedOrderStatus = 'confirmed' | 'processing' | 'shipped' | 'delivered' | 'cancelled';

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
}

export interface EmailParseContext {
  /** Existing order numbers from this customer's mailbox used for cancellation matching. */
  knownOrderNumbers?: readonly string[];
}

const orderPatterns = [
  /(?:order|purchase)\s*(?:number|no\.?|#|id)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{4,})/i,
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
  const orderNumber = firstOrderNumber(plain) ?? findKnownOrderNumber(plain, context.knownOrderNumbers ?? []);
  const tracking = findTracking(plain);
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
  };
}

function looksOrderRelated(text: string): boolean {
  const signals = [
    /\border (?:confirmed|confirmation|number|#|has shipped|is on the way)\b/i,
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
    || /\b(?:order|purchase|shipment|item)\b[\s\S]{0,100}\b(?:cancelled|canceled|cancellation|refund(?:ed)?)\b/i.test(text)
    || /\b(?:cancelled|canceled|cancellation|refund(?:ed)?)\b[\s\S]{0,100}\b(?:order|purchase|shipment|item)\b/i.test(text)) return 'cancelled';
  if (/delivered/.test(normalizedSubject) || /\b(?:package|order|shipment) (?:was |has been )?delivered\b/i.test(text)) return 'delivered';
  if (/shipped|on the way|in transit|out for delivery/.test(normalizedSubject) || /\b(?:has shipped|shipped via|tracking number)\b/i.test(text)) return 'shipped';
  if (/processing|preparing|getting your order ready/.test(normalizedSubject) || /\bpreparing (?:your )?(?:order|shipment)\b/i.test(text)) return 'processing';
  return 'confirmed';
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

function findTrackingUrl(value: string): string | null {
  const urls = value.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
  return urls.find((url) => /ups\.com|fedex\.com|usps\.com|dhl\.com|track(?:ing)?/i.test(url))?.replace(/&amp;/g, '&') ?? null;
}

function firstOrderNumber(value: string): string | null {
  for (const pattern of orderPatterns) {
    const match = value.match(pattern);
    const candidate = normalizeOrderNumber(match?.[1]);
    if (candidate) return candidate;
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
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function normalizeText(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
