import type { ParsedOrderEmail, EmailInput } from '../email/parser.js';
import type { ProcessedMessageMeta, Repository } from '../database/repository.js';
import { buildRedactedEnrichmentInput, NoopOrderEnrichmentProvider, validateEnrichedOrder, type OrderEnrichmentProvider } from './order-enrichment.js';

export const ORDER_INGESTION_WORKFLOW_VERSION = 'orders.ingestion.v1';

export interface OrderIngestionDependencies {
  repository: Repository;
  parse: (input: EmailInput) => ParsedOrderEmail | null;
  enricher?: OrderEnrichmentProvider;
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
    const matched = await dependencies.repository.recordMessage(workspaceId, customerId, meta, deterministic);
    return { matched, source: 'deterministic', validation: matched ? 'accepted' : 'skipped' };
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
