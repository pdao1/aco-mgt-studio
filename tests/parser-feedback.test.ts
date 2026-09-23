import { readFile, readdir } from 'node:fs/promises';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { Repository } from '../server/database/repository.js';
import type { ParsedOrderEmail } from '../server/email/parser.js';
import { parseOrderEmail } from '../server/email/parser.js';
import { MAILBOX_PARSER_VERSION } from '../server/email/discovery.js';

describe('parser feedback persistence', () => {
  let db: PGlite;
  let repository: Repository;
  let workspaceId: string;
  let customerId: string;
  let orderId: string;

  beforeAll(async () => {
    db = new PGlite();
    const directory = new URL('../server/database/migrations/', import.meta.url);
    for (const file of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
      await db.exec(await readFile(new URL(file, directory), 'utf8'));
    }
    repository = new Repository('postgres://unused');
    const query = async (text: string, values?: unknown[]) => {
      const result = await db.query(text, values);
      return { rows: result.rows, rowCount: result.affectedRows || result.rows.length };
    };
    Object.assign(repository, {
      pool: {
        query,
        connect: async () => ({ query, release: () => undefined }),
        end: async () => undefined,
      },
    });
    workspaceId = await repository.ensureWorkspace('feedback-test', 'Feedback Test');
    const customer = await repository.createCustomer(workspaceId, {
      name: 'Buyer',
      gmailAddress: 'buyer@example.com',
      syncDays: 30,
      secretCiphertext: 'encrypted-test-value',
    });
    customerId = customer.id;
    const parsed: ParsedOrderEmail = {
      messageKey: 'feedback-message',
      merchant: 'Target',
      orderNumber: '912003774472093',
      status: 'confirmed',
      totalCents: 5998,
      currency: 'USD',
      trackingNumber: null,
      carrier: null,
      trackingUrl: null,
      expectedDelivery: null,
      orderedAt: new Date('2026-09-15T10:15:00.000Z'),
      itemCount: 2,
      items: [
        { name: 'Pokémon Trading Card Game', quantity: 2, unitPriceCents: null, totalCents: null },
        { name: 'Delivers to', quantity: 2, unitPriceCents: null, totalCents: null },
      ],
    };
    await repository.recordMessage(workspaceId, customerId, {
      messageKey: parsed.messageKey,
      fromAddress: 'orders@target.com',
      subject: 'Your order is confirmed',
      receivedAt: parsed.orderedAt,
      redactedExcerpt: 'Items purchased\nPokémon Trading Card Game\nQty 2\n[redacted fulfillment block]',
    }, parsed);
    const dashboard = await repository.dashboard(workspaceId);
    orderId = dashboard.orders[0].id;
  }, 30_000);

  afterAll(async () => {
    await repository.close();
    await db.close();
  });

  it('persists hidden item corrections and uses them in visible item counts', async () => {
    const initial = await repository.dashboard(workspaceId);
    expect(initial.orders[0].itemCount).toBe(4);
    expect(initial.orders[0].items[1].hidden).toBe(false);

    await repository.hideOrderItem(workspaceId, orderId, 1, true);
    const corrected = await repository.dashboard(workspaceId);
    expect(corrected.orders[0].itemCount).toBe(2);
    expect(corrected.orders[0].items[1].hidden).toBe(true);
    expect(corrected.orders[0].hiddenItemCount).toBe(1);
    expect(await repository.listParserFeedbackExamples(workspaceId, 'Target')).toEqual([
      { itemName: 'Delivers to', quantity: 2 },
    ]);
  });

  it('archives orders without deleting them and exports redacted feedback', async () => {
    await repository.archiveOrder(workspaceId, orderId, true);
    const archived = await repository.dashboard(workspaceId);
    expect(archived.orders[0].isArchived).toBe(true);
    const feedback = await repository.listParserFeedback(workspaceId);
    expect(feedback.some((row) => row.feedbackType === 'archive_order')).toBe(true);
    expect(feedback.find((row) => row.feedbackType === 'hide_item')?.sourceExcerpt).not.toContain('buyer@example.com');
  });

  it('replays legacy decisions once, updates existing orders, and preserves manual corrections', async () => {
    expect(await repository.listProcessedMessageKeys(workspaceId, customerId, MAILBOX_PARSER_VERSION)).toEqual([]);
    const email = { messageId: 'feedback-message', fromAddress: 'orders@target.com', fromName: 'Target',
      subject: 'Order confirmed', text: 'Order # 912003774472093', html: null,
      receivedAt: new Date('2026-09-14T10:15:00Z') };
    const parsed = parseOrderEmail(email)!;
    const meta = { messageKey: email.messageId, fromAddress: email.fromAddress, subject: email.subject,
      receivedAt: email.receivedAt, parserVersion: MAILBOX_PARSER_VERSION };
    await repository.recordMessage(workspaceId, customerId, meta, parsed);
    await repository.recordMessage(workspaceId, customerId, meta, parsed);
    expect(await repository.listProcessedMessageKeys(workspaceId, customerId, MAILBOX_PARSER_VERSION)).toEqual(['feedback-message']);
    const dashboard = await repository.dashboard(workspaceId);
    expect(dashboard.orders).toHaveLength(1);
    expect(dashboard.orders[0]).toMatchObject({ id: orderId, isArchived: true, hiddenItemCount: 1 });
    expect(new Date(dashboard.orders[0].orderedAt).toISOString()).toBe(email.receivedAt.toISOString());

    const repairMeta = { ...meta, messageKey: 'legacy-no-match' };
    await repository.recordMessage(workspaceId, customerId, { ...repairMeta, parserVersion: undefined }, null);
    expect(await repository.listProcessedMessageKeys(workspaceId, customerId, MAILBOX_PARSER_VERSION)).not.toContain('legacy-no-match');
    await repository.recordMessage(workspaceId, customerId, repairMeta, { ...parsed, messageKey: repairMeta.messageKey, status: 'delivered' });
    const { rows } = await db.query<{ matched_order: boolean }>('SELECT matched_order FROM processed_messages WHERE message_key = $1', ['legacy-no-match']);
    expect(rows[0].matched_order).toBe(true);
    expect((await repository.dashboard(workspaceId)).orders[0].status).toBe('delivered');
  });

  it('removes inbox-scoped deduplication and order data before reconnection', async () => {
    const input = { name: 'Reconnect test', gmailAddress: 'reconnect@gmail.com', syncDays: 365, secretCiphertext: 'test' };
    const old = await repository.createCustomer(workspaceId, input);
    const email = { messageId: '<reconnect>', fromAddress: 'orders@target.com', fromName: 'Target',
      subject: 'Your order shipped', text: 'Order # TG-99999\nTracking number: 1Z7W9A7Y03ABCD9827', html: null,
      receivedAt: new Date('2026-09-20Z') };
    const meta = { messageKey: email.messageId, fromAddress: email.fromAddress, subject: email.subject, receivedAt: email.receivedAt };
    await repository.recordMessage(workspaceId, old.id, meta, parseOrderEmail(email));
    await repository.beginSync(workspaceId, old.id);
    expect(await repository.removeCustomer(workspaceId, old.id)).toBe(true);
    for (const table of ['customer_mailboxes', 'orders', 'shipments', 'order_events', 'processed_messages', 'sync_runs']) {
      const { rows } = await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table} WHERE customer_id = $1`, [old.id]);
      expect(rows[0].count, table).toBe(0);
    }
    const reconnected = await repository.createCustomer(workspaceId, input);
    expect(reconnected.id).not.toBe(old.id);
    expect(await repository.listProcessedMessageKeys(workspaceId, reconnected.id)).toEqual([]);
    expect(await repository.recordMessage(workspaceId, reconnected.id, meta, parseOrderEmail(email))).toBe(true);
  });
});
