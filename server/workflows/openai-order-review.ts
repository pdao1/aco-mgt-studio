import { createHash } from 'node:crypto';
import type { OrderEnrichmentInput, OrderEnrichmentProvider, OrderItemReviewInput } from './order-enrichment.js';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const ORDER_REVIEW_PROMPT_VERSION = 'order-repair.v1';
const ITEM_REVIEW_PROMPT_VERSION = 'order-items-repair.v2';

const orderReviewSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    merchant: { type: 'string', minLength: 2, maxLength: 120 },
    orderNumber: { type: ['string', 'null'], maxLength: 120 },
    status: { type: 'string', enum: ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'] },
    totalCents: { type: ['integer', 'null'], minimum: 0 },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    trackingNumber: { type: ['string', 'null'], maxLength: 120 },
    carrier: { type: ['string', 'null'], maxLength: 80 },
    trackingUrl: { type: ['string', 'null'], maxLength: 1000 },
    expectedDelivery: { type: ['string', 'null'], maxLength: 80 },
    orderedAt: { type: 'string', maxLength: 80 },
    itemCount: { type: ['integer', 'null'], minimum: 0, maximum: 10_000 },
    items: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 240 },
          quantity: { type: 'integer', minimum: 1, maximum: 10_000 },
          unitPriceCents: { type: ['integer', 'null'], minimum: 0 },
          totalCents: { type: ['integer', 'null'], minimum: 0 },
        },
        required: ['name', 'quantity', 'unitPriceCents', 'totalCents'],
      },
    },
  },
  required: [
    'merchant', 'orderNumber', 'status', 'totalCents', 'currency',
    'trackingNumber', 'carrier', 'trackingUrl', 'expectedDelivery',
    'orderedAt', 'itemCount', 'items',
  ],
} as const;

const itemReviewSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          quantity: { type: 'integer', minimum: 1, maximum: 10_000 },
          unitPriceCents: { type: ['integer', 'null'], minimum: 0 },
          totalCents: { type: ['integer', 'null'], minimum: 0 },
        },
        required: ['name', 'quantity', 'unitPriceCents', 'totalCents'],
      },
    },
  },
  required: ['items'],
} as const;

/**
 * Low-cost, fail-soft order repair. Deterministic parsing is always attempted
 * first; this provider only receives a redacted excerpt for an order-like
 * message that needs help or a structured item correction.
 */
export class OpenAIOrderEnrichmentProvider implements OrderEnrichmentProvider {
  readonly name: string;

  constructor(
    private readonly apiKey: string,
    private readonly model = 'gpt-5-nano',
    private readonly timeoutMs = 10_000,
  ) {
    this.name = `openai:${model}`;
  }

  async enrich(input: OrderEnrichmentInput): Promise<unknown> {
    return this.requestStructuredOutput({
      schema: orderReviewSchema,
      schemaName: 'order_repair',
      instructions: [
        `You are the bounded order parser repairer (${ORDER_REVIEW_PROMPT_VERSION}).`,
        'Return only the JSON schema output.',
        'Extract one purchase order only when the order identifier is explicitly present in the supplied email text.',
        'Use null for any field that is not explicit or is ambiguous; never invent an order number, total, status, tracking number, item, quantity, or price.',
        'Ignore login codes, one-time PINs, marketing copy, recommendations, navigation, links, CSS/HTML fragments, and policy text.',
        'The order number must be copied from the email, not generated from a date, amount, or message identifier.',
        'A generic acknowledgement is pending; only explicit confirmation language is confirmed.',
        'Dates must be ISO 8601 strings when present. Prices are integer cents.',
        input.repairFeedback || 'No previous repair feedback. Prefer a clean empty result over a false order.',
      ].join(' '),
      input: formatOrderReviewInput(input),
      messageKey: input.messageKey,
      maxOutputTokens: 1_200,
    });
  }

  async reviewItems(input: OrderItemReviewInput): Promise<unknown> {
    const candidateItems = input.deterministicItems?.slice(0, 50) ?? [];
    return this.requestStructuredOutput({
      schema: itemReviewSchema,
      schemaName: 'order_item_review',
      instructions: [
        `You are the item-row repairer for an order email (${ITEM_REVIEW_PROMPT_VERSION}).`,
        'Return only the JSON schema output.',
        'Extract purchasable line items from the supplied email text and correct the deterministic candidate when it contains links or template noise.',
        'Never include headings, category labels, recommendations, navigation, calls to action, policy copy, CSS/HTML fragments, or prose.',
        'Use only names, quantities, and prices explicitly present in a product row. Never infer a price or quantity.',
        'If the text is ambiguous, return an empty items array. A clean empty result is better than a false item.',
        'Prices are integer cents. Use null when a row does not explicitly provide that price.',
        input.repairFeedback || 'No previous repair feedback. Keep only actual purchased rows.',
      ].join(' '),
      input: formatItemReviewInput(input, candidateItems),
      messageKey: input.messageKey,
      maxOutputTokens: 800,
    });
  }

  private async requestStructuredOutput(options: {
    schema: unknown;
    schemaName: string;
    instructions: string;
    input: string;
    messageKey: string;
    maxOutputTokens: number;
  }): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(OPENAI_RESPONSES_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          store: false,
          instructions: options.instructions,
          input: options.input,
          reasoning: { effort: 'minimal' },
          max_output_tokens: options.maxOutputTokens,
          text: {
            format: {
              type: 'json_schema',
              name: options.schemaName,
              strict: true,
              schema: options.schema,
            },
          },
          // Keep the request attributable without sending an email address or
          // raw message identifier to the model provider.
          safety_identifier: createHash('sha256').update(options.messageKey).digest('hex').slice(0, 64),
        }),
      });
      if (!response.ok) throw new Error(`OpenAI ${options.schemaName} failed with HTTP ${response.status}.`);
      const payload = await response.json() as unknown;
      const outputText = extractOutputText(payload);
      if (!outputText) return null;
      try {
        return JSON.parse(outputText) as unknown;
      } catch {
        return null;
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

function formatOrderReviewInput(input: OrderEnrichmentInput): string {
  return [
    `Retailer domain: ${input.fromDomain ?? 'unknown'}`,
    `Repair attempt: ${input.repairAttempt ?? 1}`,
    `Subject: ${input.subject}`,
    'Email text begins:',
    input.bodyExcerpt,
    'Email text ends.',
  ].join('\n');
}

function formatItemReviewInput(input: OrderItemReviewInput, candidateItems: readonly unknown[]): string {
  return [
    `Retailer domain: ${input.fromDomain ?? 'unknown'}`,
    `Retailer name: ${input.merchant}`,
    `Known order number: ${input.orderNumber ?? 'unknown'}`,
    `Repair attempt: ${input.repairAttempt ?? 1}`,
    `Deterministic candidate rows: ${JSON.stringify(candidateItems)}`,
    `Subject: ${input.subject}`,
    'Email text begins:',
    input.bodyExcerpt,
    'Email text ends.',
  ].join('\n');
}

function extractOutputText(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const response = value as { output_text?: unknown; output?: unknown };
  if (typeof response.output_text === 'string') return response.output_text;
  if (!Array.isArray(response.output)) return null;
  const chunks: string[] = [];
  for (const outputItem of response.output) {
    if (!outputItem || typeof outputItem !== 'object') continue;
    const content = (outputItem as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const contentItem of content) {
      if (!contentItem || typeof contentItem !== 'object') continue;
      const candidate = contentItem as { type?: unknown; text?: unknown };
      if (candidate.type === 'output_text' && typeof candidate.text === 'string') chunks.push(candidate.text);
    }
  }
  return chunks.join('').trim() || null;
}
