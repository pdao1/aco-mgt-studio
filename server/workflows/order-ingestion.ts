import type { ParsedOrderEmail, EmailInput } from '../email/parser.js';
import { isCancellationNotice, isLikelyOrderMessage, isOneTimePinEmail } from '../email/parser.js';
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
const MAX_REPAIR_ATTEMPTS_PER_MESSAGE = 2;

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
      && shouldReviewItems(deterministic, `${email.text}\n${email.html ?? ''}`)
      && deterministic.status !== 'cancelled'
      && (!budget || budget.remaining > 0)) {
      let repairFeedback: string | undefined;
      for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS_PER_MESSAGE; attempt += 1) {
        if (budget && budget.remaining <= 0) break;
        if (budget) budget.remaining -= 1;
        let reviewed: unknown;
        try {
          reviewed = await enricher.reviewItems(buildRedactedItemReviewInput({
            messageKey: meta.messageKey,
            fromAddress: meta.fromAddress,
            subject: meta.subject,
            text: email.text,
            receivedAt: meta.receivedAt,
            merchant: deterministic.merchant,
            orderNumber: deterministic.orderNumber,
            deterministicItems: deterministic.items,
            repairAttempt: attempt,
            repairFeedback,
          }));
        } catch (error) {
          // AI is an optional quality pass. A timeout/provider failure must not
          // prevent the deterministic order/status from being persisted.
          console.warn(`[order-enrichment] item review skipped provider=${enricher.name} reason=${safeErrorMessage(error)}`);
          break;
        }
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
          break;
        }
        repairFeedback = 'The previous response was not valid structured item data. Retry with only explicit purchasable rows, or return an empty items array.';
      }
    }
    const matched = await dependencies.repository.recordMessage(workspaceId, customerId, meta, normalized);
    return { matched, source: itemReviewAccepted ? 'ai' : 'deterministic', validation: matched ? 'accepted' : 'skipped' };
  }

  const enricher = dependencies.enricher ?? new NoopOrderEnrichmentProvider();
  // Do not call the model for newsletters, one-time PINs, or other messages
  // the deterministic parser already classified as unrelated.
  if (enricher.name === 'none' || isOneTimePinEmail(email) || isCancellationNotice(email) || !isLikelyOrderMessage(email)) {
    await dependencies.repository.recordMessage(workspaceId, customerId, meta, null);
    return { matched: false, source: enricher.name === 'none' ? 'none' : 'ai', validation: 'skipped' };
  }

  const budget = dependencies.itemReviewBudget;
  let repairFeedback: string | undefined;
  for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS_PER_MESSAGE; attempt += 1) {
    if (budget && budget.remaining <= 0) break;
    if (budget) budget.remaining -= 1;
    let enriched: unknown;
    try {
      enriched = await enricher.enrich(buildRedactedEnrichmentInput({
        messageKey: meta.messageKey,
        fromAddress: meta.fromAddress,
        subject: meta.subject,
        text: email.text,
        receivedAt: meta.receivedAt,
        repairAttempt: attempt,
        repairFeedback,
      }));
    } catch (error) {
      console.warn(`[order-enrichment] order repair skipped provider=${enricher.name} reason=${safeErrorMessage(error)}`);
      break;
    }
    const normalized = validateEnrichedOrder(enriched, { messageKey: meta.messageKey, receivedAt: meta.receivedAt });
    if (normalized && isGroundedOrderNumber(normalized.orderNumber, email)) {
      const matched = await dependencies.repository.recordMessage(workspaceId, customerId, meta, normalized);
      return { matched, source: 'ai', validation: matched ? 'accepted' : 'skipped' };
    }
    repairFeedback = normalized
      ? 'The order identifier was not copied exactly from the email text. Retry only if an explicit order number is present; otherwise return null for orderNumber.'
      : 'The previous response failed validation. Retry with the exact structured schema and return null fields instead of guessing.';
  }

  await dependencies.repository.recordMessage(workspaceId, customerId, meta, null);
  return { matched: false, source: 'ai', validation: 'rejected' };
}

function isGroundedOrderNumber(orderNumber: string | null, email: EmailInput): boolean {
  if (!orderNumber) return false;
  const compact = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const candidate = compact(orderNumber);
  if (candidate.length < 5) return false;
  const source = `${email.subject}\n${email.text}`.replace(/https?:\/\/\S+/gi, ' ');
  const lines = source.split(/\r?\n/);
  return lines.some((line, index) => {
    if (!compact(line).includes(candidate)) return false;
    const context = lines.slice(Math.max(0, index - 1), index + 2).join(' ');
    return /\b(?:order|purchase|confirmation|cancellation|cancelled|canceled|shipment|package|tracking)\b/i.test(context);
  });
}

function shouldReviewItems(order: ParsedOrderEmail, sourceText: string): boolean {
  // Navigation/analytics rows are filtered deterministically, but their
  // presence is still a useful signal that the retailer's template needs a
  // cheap second pass. The nano reviewer sees a redacted excerpt and can
  // return only the actual purchasable rows.
  if (/https?:\/\/|click\.oe\.target\.com|\bview\s+order\s+details\b|\bcancel(?:led|ed)\s+item\b/i.test(sourceText)) return true;
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
