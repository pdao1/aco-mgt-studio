import { createHash } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Repository } from '../database/repository.js';
import { SecretBox } from '../security/secret-box.js';
import { parseOrderEmail } from './parser.js';
import { runOrderIngestion } from '../workflows/order-ingestion.js';

const GMAIL_HOST = 'imap.gmail.com';
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;

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
    const knownOrderNumbers = new Set(await this.repository.listOrderNumbers(this.workspaceId, customerId));
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
        const searched = await client.search({
          gmraw: `after:${after} {order shipped shipment delivered delivery tracking package confirmation purchase}`,
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
          for await (const message of client.fetch(uids, { envelope: true, internalDate: true, source: true }, { uid: true })) {
            scanned += 1;
            if (!message.source || message.source.length > MAX_SOURCE_BYTES) continue;
            const parsedMail = await simpleParser(message.source, {
              skipImageLinks: true,
              skipTextToHtml: true,
              maxHtmlLengthToParse: 2_000_000,
            });
            const from = parsedMail.from?.value[0];
            const fromAddress = ('address' in (from ?? {}) ? from?.address : null) || message.envelope?.from?.[0]?.address || 'unknown@unknown.invalid';
            const fromName = ('name' in (from ?? {}) ? from?.name : null) || message.envelope?.from?.[0]?.name || null;
            const subject = parsedMail.subject || message.envelope?.subject || '(no subject)';
            const receivedValue = parsedMail.date || message.internalDate || new Date();
            const parsedReceivedAt = receivedValue instanceof Date ? receivedValue : new Date(receivedValue);
            const receivedAt = Number.isNaN(parsedReceivedAt.getTime()) ? new Date() : parsedReceivedAt;
            const html = typeof parsedMail.html === 'string' ? parsedMail.html : null;
            const email = {
              messageId: parsedMail.messageId || message.envelope?.messageId || null,
              fromAddress,
              fromName,
              subject,
              text: parsedMail.text ?? '',
              html,
              receivedAt,
            };
            const messageKey = parsedMail.messageId || message.envelope?.messageId || createHash('sha256')
              .update(message.source)
              .digest('hex');
            const parsedOrder = parseOrderEmail(email, { knownOrderNumbers: [...knownOrderNumbers] });
            const result = await runOrderIngestion(this.workspaceId, customerId, email, {
              messageKey,
              fromAddress,
              subject,
              receivedAt,
            }, {
              repository: this.repository,
              parse: () => parsedOrder,
            });
            if (parsedOrder?.orderNumber) knownOrderNumbers.add(parsedOrder.orderNumber);
            if (result.matched) matched += 1;
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
