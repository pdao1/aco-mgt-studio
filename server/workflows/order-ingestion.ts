import type { ParsedOrderEmail, EmailInput } from '../email/parser.js';
import type { ProcessedMessageMeta, Repository } from '../database/repository.js';
import {
  buildRedactedEnrichmentInput,
  buildRedactedItemReviewInput,
  NoopOrderEnrichmentProvider,
  validateEnrichedItems,
  validateEnrichedOrder,
  type OrderEnrichmentProvider,
} from './order-enrichment.js';

export const ORDER_INGESTION_WORKFLOW_VERSION = 'orders.ingestion.v1';

export interface OrderIngestionDependencies {
  repository: Repository;
  parse: (input: EmailInput) => ParsedOrderEmail | null;
  enricher?: OrderEnrichmentProvider;
  /** Mutable per-sync budget; protects against one mailbox generating a large AI bill. */
  itemReviewBudget?: { remaining: number };
}

export interface OrderIngestionResult {
  matched: boolean;
  source: 'deterministic' | 'ai' | 'none';
  validation: 'accepted' | 'rejected' | 'skipped';
}

/**
 * The workflow keeps extract/normalize/enrich/load separate. Raw source is
 * owned by the caller and is never returned or written by this function.
 */
export async function runOrderIngestion(
  workspaceId: string,
  customerId: string,
  email: EmailInput,
  meta: ProcessedMessageMeta,
  dependencies: OrderIngestionDependencies,
): Promise<OrderIngestionResult> {
  const deterministic = dependencies.parse(email);
  if (deterministic) {
    const enricher = dependencies.enricher;
    let normalized = deterministic;
    let itemReviewAccepted = false;
    const budget = dependencies.itemReviewBudget;
    if (enricher?.reviewItems
      && shouldReviewItems(deterministic)
      && deterministic.status !== 'cancelled'
      && (!budget || budget.remaining > 0)) {
      if (budget) budget.remaining -= 1;
      try {
        const reviewed = await enricher.reviewItems(buildRedactedItemReviewInput({
          messageKey: meta.messageKey,
          fromAddress: meta.fromAddress,
          subject: meta.subject,
          text: email.text,
          receivedAt: meta.receivedAt,
          merchant: deterministic.merchant,
          orderNumber: deterministic.orderNumber,
        }));
        const items = validateEnrichedItems(reviewed);
        if (items) {
          normalized = {
            ...deterministic,
            items,
            itemCount: items.length > 0
              ? items.reduce((total, item) => total + item.quantity, 0)
              : deterministic.itemCount,
          };
          itemReviewAccepted = true;
        }
      } catch (error) {
        // AI is an optional quality pass. A timeout/provider failure must not
        // prevent the deterministic order/status from being persisted.
        console.warn(`[order-enrichment] item review skipped provider=${enricher.name} reason=${safeErrorMessage(error)}`);
      }
    }
    const matched = await dependencies.repository.recordMessage(workspaceId, customerId, meta, normalized);
    return { matched, source: itemReviewAccepted ? 'ai' : 'deterministic', validation: matched ? 'accepted' : 'skipped' };
  }

  const enricher = dependencies.enricher ?? new NoopOrderEnrichmentProvider();
  const enriched = await enricher.enrich(buildRedactedEnrichmentInput({
    messageKey: meta.messageKey,
    fromAddress: meta.fromAddress,
    subject: meta.subject,
    text: email.text,
    receivedAt: meta.receivedAt,
  }));
  const normalized = validateEnrichedOrder(enriched, { messageKey: meta.messageKey, receivedAt: meta.receivedAt });
  if (!normalized) {
    await dependencies.repository.recordMessage(workspaceId, customerId, meta, null);
    return { matched: false, source: enricher.name === 'none' ? 'none' : 'ai', validation: enricher.name === 'none' ? 'skipped' : 'rejected' };
  }
  const matched = await dependencies.repository.recordMessage(workspaceId, customerId, meta, normalized);
  return { matched, source: enricher.name === 'none' ? 'none' : 'ai', validation: matched ? 'accepted' : 'skipped' };
}

function shouldReviewItems(order: ParsedOrderEmail): boolean {
  if (order.items.length === 0) {
    // Confirmation/processing mail is where item rows normally live. Avoid
    // paying for a review on shipment/delivery notices that carry only a
    // tracking update unless the parser found an explicit item count.
    return order.status === 'confirmed' || order.status === 'processing' || order.itemCount !== null;
  }
  return order.items.some((item) => {
    const name = item.name.trim();
    return /(?:^|\b)(?:border|background|padding|margin|font|color)\b/i.test(name)
      || /(?:item\s+border|more\s+items?\s+to\s+explore|recommended|related\s+items?)/i.test(name)
      || /[({\[]$/.test(name);
  });
}

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'provider error';
  return error.message.replace(/[\r\n]+/g, ' ').slice(0, 160);
}
