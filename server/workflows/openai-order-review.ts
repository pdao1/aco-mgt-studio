import { createHash } from 'node:crypto';
import type { OrderEnrichmentProvider, OrderItemReviewInput } from './order-enrichment.js';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const ITEM_REVIEW_PROMPT_VERSION = 'order-items.v1';

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
 * Low-cost, fail-soft item reviewer. It is intentionally limited to the
 * ambiguous item-list step; deterministic parsing remains authoritative for
 * merchant, order number, status, totals, and tracking.
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

  // Full-order AI enrichment remains disabled by design. If a message has no
  // deterministic order/tracking identity, it is not safe to invent one.
  async enrich(_input: Parameters<OrderEnrichmentProvider['enrich']>[0]): Promise<null> {
    return null;
  }

  async reviewItems(input: OrderItemReviewInput): Promise<unknown> {
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
          instructions: [
            `You are the item-row verifier for an order email (${ITEM_REVIEW_PROMPT_VERSION}).`,
            'Return only the JSON schema output.',
            'Extract purchasable line items from the supplied email text.',
            'Never include headings, category labels, recommendations, navigation, calls to action, policy copy, CSS/HTML fragments, or prose.',
            'Use only names, quantities, and prices explicitly present in a product row. Never infer a price or quantity.',
            'If the text is ambiguous, return an empty items array. A clean empty result is better than a false item.',
            'Prices are integer cents. Use null when a row does not explicitly provide that price.',
          ].join(' '),
          input: formatReviewInput(input),
          reasoning: { effort: 'minimal' },
          max_output_tokens: 800,
          text: {
            format: {
              type: 'json_schema',
              name: 'order_item_review',
              strict: true,
              schema: itemReviewSchema,
            },
          },
          // Keep the request attributable without sending an email address or
          // raw message identifier to the model provider.
          safety_identifier: createHash('sha256').update(input.messageKey).digest('hex').slice(0, 64),
        }),
      });
      if (!response.ok) {
        throw new Error(`OpenAI item review failed with HTTP ${response.status}.`);
      }
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

function formatReviewInput(input: OrderItemReviewInput): string {
  return [
    `Retailer domain: ${input.fromDomain ?? 'unknown'}`,
    `Retailer name: ${input.merchant}`,
    `Known order number: ${input.orderNumber ?? 'unknown'}`,
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

