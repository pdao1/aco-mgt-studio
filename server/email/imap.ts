import { createHash } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Repository } from '../database/repository.js';
import { SecretBox } from '../security/secret-box.js';
import {
  isOneTimePinEmail,
  MAX_EMAIL_SOURCE_BYTES,
  parseOrderEmail,
  shouldSkipOversizedMessage,
  shouldSkipOversizedText,
} from './parser.js';
import { runOrderIngestion } from '../workflows/order-ingestion.js';
import type { OrderEnrichmentProvider } from '../workflows/order-enrichment.js';

const GMAIL_HOST = 'imap.gmail.com';

function createClient(user: string, password: string) {
  return new ImapFlow({
    host: GMAIL_HOST,
    port: 993,
    secure: true,
    auth: { user, pass: password },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 90_000,
  });
}

export async function verifyGmailConnection(gmailAddress: string, appPassword: string): Promise<void> {
  const client = createClient(gmailAddress, normalizeAppPassword(appPassword));
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX', { readOnly: true, description: 'credential verification' });
    lock.release();
  } catch (error) {
    throw new Error(friendlyImapError(error));
  } finally {
    if (client.usable) await client.logout().catch(() => undefined);
  }
}

export class MailboxSyncCoordinator {
  private readonly active = new Set<string>();
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repository: Repository,
    private readonly secretBox: SecretBox,
    private readonly workspaceId: string,
    private readonly maxMessages: number,
    private readonly enricher?: OrderEnrichmentProvider,
    private readonly maxAiReviewsPerSync = 25,
  ) {}

  startPolling(intervalMinutes: number) {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.syncAll(), intervalMinutes * 60_000);
    this.pollTimer.unref();
  }

  stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async syncAll() {
    const customerIds = await this.repository.listCustomerIds(this.workspaceId);
    for (const customerId of customerIds) this.enqueue(customerId);
  }

  enqueue(customerId: string, options: { fullHistory?: boolean } = {}): boolean {
    if (this.active.has(customerId)) return false;
    this.active.add(customerId);
    void this.syncOne(customerId, options.fullHistory === true).finally(() => this.active.delete(customerId));
    return true;
  }

  isActive(customerId: string) {
    return this.active.has(customerId);
  }

  private async syncOne(customerId: string, fullHistory = false) {
    const mailbox = await this.repository.getMailbox(this.workspaceId, customerId);
    if (!mailbox) return;

    const runId = await this.repository.beginSync(this.workspaceId, customerId);
    let scanned = 0;
    let matched = 0;
    const itemReviewBudget = { remaining: this.maxAiReviewsPerSync };
    const knownOrderNumbers = new Set(await this.repository.listOrderNumbers(this.workspaceId, customerId));
    const processedMessageKeys = new Set(await this.repository.listProcessedMessageKeys(this.workspaceId, customerId));
    const client = createClient(mailbox.gmailAddress, this.secretBox.decrypt(mailbox.secretCiphertext));

    try {
      await client.connect();
      const mailboxes = await client.list();
      const allMail = mailboxes.find((candidate) => candidate.specialUse === '\\All');
      const mailboxPath = allMail?.path ?? 'INBOX';
      const lock = await client.getMailboxLock(mailboxPath, { readOnly: true, description: 'order synchronization' });
      try {
        const since = !fullHistory && mailbox.lastSyncedAt
          ? new Date(mailbox.lastSyncedAt.getTime() - 24 * 60 * 60 * 1000)
          : new Date(Date.now() - mailbox.syncDays * 24 * 60 * 60 * 1000);
        const after = since.toISOString().slice(0, 10).replace(/-/g, '/');
        // Search the bounded customer mailbox window rather than relying on a
        // subject-keyword allowlist. Retailer cancellation and fulfillment
        // notices use many different subjects; parsing is the order-related
        // filter and only durable matches are loaded into the order table.
        const searched = await client.search({
          gmraw: `after:${after}`,
        }, { uid: true });
        // Cancellation notices were previously ignored. Search the full
        // configured history on every sync so an already-processed mailbox can
        // be repaired without resetting its incremental cursor.
        const cancellationSince = new Date(Date.now() - mailbox.syncDays * 24 * 60 * 60 * 1000);
        const cancellationAfter = cancellationSince.toISOString().slice(0, 10).replace(/-/g, '/');
        const cancellationSearched = await client.search({
          gmraw: `after:${cancellationAfter} {cancelled canceled cancellation refund}`,
        }, { uid: true });
        const cancellationUids = [...new Set(cancellationSearched || [])]
          .sort((left, right) => left - right)
          .slice(-this.maxMessages);
        const regularUids = [...new Set(searched || [])].sort((left, right) => left - right);
        const remainingCapacity = Math.max(0, this.maxMessages - cancellationUids.length);
        const uids = [...new Set([
          ...cancellationUids,
          ...regularUids.slice(-remainingCapacity),
        ])]
          .sort((left, right) => left - right)
          .slice(-this.maxMessages);
        if (uids.length > 0) {
          // Fetch headers first. Message-ID is the durable de-duplication key,
          // so previously processed messages do not need their full MIME
          // source downloaded and parsed on every refresh.
          const candidateUids: number[] = [];
          for await (const message of client.fetch(uids, { envelope: true, internalDate: true }, { uid: true })) {
            const messageKey = message.envelope?.messageId?.trim() || null;
            if (messageKey && processedMessageKeys.has(messageKey)) continue;
            const subject = message.envelope?.subject || '(no subject)';
            const fromAddress = message.envelope?.from?.[0]?.address || 'unknown@unknown.invalid';
            const receivedValue = message.internalDate || new Date();
            const parsedReceivedAt = receivedValue instanceof Date ? receivedValue : new Date(receivedValue);
            const receivedAt = Number.isNaN(parsedReceivedAt.getTime()) ? new Date() : parsedReceivedAt;
            const metadata = {
              messageKey: messageKey || createHash('sha256')
                .update(`${message.uid}\0${fromAddress}\0${subject}\0${receivedAt.toISOString()}`)
                .digest('hex'),
              fromAddress,
              subject,
              receivedAt,
            };
            if (isOneTimePinEmail({ subject, text: '', html: null })) {
              await this.repository.recordMessage(this.workspaceId, customerId, metadata, null);
              processedMessageKeys.add(metadata.messageKey);
              continue;
            }
            candidateUids.push(message.uid);
          }

          if (candidateUids.length > 0) {
            for await (const message of client.fetch(candidateUids, { envelope: true, internalDate: true, source: true }, { uid: true })) {
              scanned += 1;
              const envelopeMessageKey = message.envelope?.messageId?.trim() || null;
              if (envelopeMessageKey && processedMessageKeys.has(envelopeMessageKey)) continue;
              const subject = message.envelope?.subject || '(no subject)';
              const fromAddress = message.envelope?.from?.[0]?.address || 'unknown@unknown.invalid';
              const fromName = message.envelope?.from?.[0]?.name || null;
              const receivedValue = message.internalDate || new Date();
              const parsedInternalDate = receivedValue instanceof Date ? receivedValue : new Date(receivedValue);
              const receivedAt = Number.isNaN(parsedInternalDate.getTime()) ? new Date() : parsedInternalDate;
              const messageKey = envelopeMessageKey || createHash('sha256')
                // Gmail UIDs are stable within the selected mailbox and give
                // messages without a Message-ID the same key in both the
                // header-only and source fetches.
                .update(`${message.uid}\0${fromAddress}\0${subject}\0${receivedAt.toISOString()}`)
                .digest('hex');
              const metadata = { messageKey, fromAddress, subject, receivedAt };

              if (!message.source || message.source.length > MAX_EMAIL_SOURCE_BYTES || shouldSkipOversizedMessage(subject, message.source.length)) {
                await this.repository.recordMessage(this.workspaceId, customerId, metadata, null);
                processedMessageKeys.add(messageKey);
                continue;
              }
              const parsedMail = await simpleParser(message.source, {
                skipImageLinks: true,
                skipTextToHtml: true,
                maxHtmlLengthToParse: 2_000_000,
              });
              const from = parsedMail.from?.value[0];
              const parsedFromAddress = ('address' in (from ?? {}) ? from?.address : null) || fromAddress;
              const parsedFromName = ('name' in (from ?? {}) ? from?.name : null) || fromName;
              const parsedSubject = parsedMail.subject || subject;
              const parsedReceivedValue = parsedMail.date || receivedAt;
              const parsedReceivedDate = parsedReceivedValue instanceof Date ? parsedReceivedValue : new Date(parsedReceivedValue);
              const parsedReceivedAt = Number.isNaN(parsedReceivedDate.getTime()) ? receivedAt : parsedReceivedDate;
              const html = typeof parsedMail.html === 'string' ? parsedMail.html : null;
              const email = {
                messageId: parsedMail.messageId || message.envelope?.messageId || null,
                fromAddress: parsedFromAddress,
                fromName: parsedFromName,
                subject: parsedSubject,
                text: parsedMail.text ?? '',
                html,
                receivedAt: parsedReceivedAt,
              };
              const finalMessageKey = parsedMail.messageId || messageKey;
              const finalMetadata = {
                messageKey: finalMessageKey,
                fromAddress: parsedFromAddress,
                subject: parsedSubject,
                receivedAt: parsedReceivedAt,
              };
              if (isOneTimePinEmail(email) || shouldSkipOversizedText(email)) {
                await this.repository.recordMessage(this.workspaceId, customerId, finalMetadata, null);
                processedMessageKeys.add(finalMessageKey);
                processedMessageKeys.add(messageKey);
                continue;
              }
              const parsedOrder = parseOrderEmail(email, { knownOrderNumbers: [...knownOrderNumbers] });
              const result = await runOrderIngestion(this.workspaceId, customerId, email, {
                messageKey: finalMessageKey,
                fromAddress: parsedFromAddress,
                subject: parsedSubject,
                receivedAt: parsedReceivedAt,
              }, {
                repository: this.repository,
                parse: () => parsedOrder,
                enricher: this.enricher,
                itemReviewBudget,
              });
              if (parsedOrder?.orderNumber) knownOrderNumbers.add(parsedOrder.orderNumber);
              processedMessageKeys.add(finalMessageKey);
              processedMessageKeys.add(messageKey);
              if (result.matched) matched += 1;
            }
          }
        }
      } finally {
        lock.release();
      }
      await this.repository.finishSync(this.workspaceId, customerId, runId, { scanned, matched });
    } catch (error) {
      const friendlyError = friendlyImapError(error);
      await this.repository.finishSync(this.workspaceId, customerId, runId, {
        scanned,
        matched,
        errorCode: classifyImapError(error),
        friendlyError,
      });
      console.error(`[mailbox-sync] customer=${customerId} failed: ${friendlyError}`);
    } finally {
      if (client.usable) await client.logout().catch(() => undefined);
    }
  }
}

function normalizeAppPassword(value: string): string {
  return value.replace(/\s/g, '');
}

function classifyImapError(error: unknown): string {
  const text = error instanceof Error ? error.message.toLowerCase() : '';
  if (/auth|credential|login|password/.test(text)) return 'AUTHENTICATION_FAILED';
  if (/timeout|timed out|socket/.test(text)) return 'CONNECTION_TIMEOUT';
  if (/rate|too many|limit/.test(text)) return 'RATE_LIMITED';
  return 'IMAP_ERROR';
}

function friendlyImapError(error: unknown): string {
  switch (classifyImapError(error)) {
    case 'AUTHENTICATION_FAILED': return 'Gmail rejected the app password. Create a new Google app password and try again.';
    case 'CONNECTION_TIMEOUT': return 'Gmail did not respond in time. The next sync will retry automatically.';
    case 'RATE_LIMITED': return 'Gmail temporarily rate-limited this inbox. The next sync will retry automatically.';
    default: return 'Gmail could not be reached. Check the inbox connection and try again.';
  }
}
