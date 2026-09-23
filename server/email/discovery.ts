// Bump when extraction/discovery rules change so saved no-match decisions do
// not permanently hide mail from an improved parser.
export const MAILBOX_PARSER_VERSION = 'mailbox.v2';

const retailerDomains = [
  'target.com', 'amazon.com', 'walmart.com', 'bestbuy.com', 'nike.com',
  'adidas.com', 'footlocker.com', 'stockx.com', 'supremenewyork.com',
  'supreme.com', 'pokemoncenter.com', 'gamestop.com', 'costco.com',
  'fedex.com', 'ups.com', 'usps.com', 'dhl.com',
];

/** Broad discovery only; neither sender nor a keyword is proof of an order. */
export function orderDiscoveryQuery(since: Date): string {
  const after = since.toISOString().slice(0, 10).replace(/-/g, '/');
  // Search bodies as well as subjects. Include all known-retailer mail to
  // catch unusual templates ("It's here!", "A change to your items", etc.).
  // Do not exclude promotions/categories: Gmail can misclassify receipts.
  return `after:${after} {order orders purchase purchases receipt invoice confirmation shipment shipped shipping package tracking delivery delivered pickup cancelled canceled cancellation refund refunded ${retailerDomains.map((domain) => `from:${domain}`).join(' ')}}`;
}

/** Make progress at both ends: old backfill and recent status updates. */
export function selectMessageBatch(uids: number[], limit: number): number[] {
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  if (sorted.length <= limit) return sorted;
  const oldest = Math.ceil(limit / 2);
  const newest = limit - oldest;
  return [...sorted.slice(0, oldest), ...(newest ? sorted.slice(-newest) : [])];
}
