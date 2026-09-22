import { readFile, readdir } from 'node:fs/promises';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { Repository } from '../server/database/repository.js';
import type { ParsedOrderEmail } from '../server/email/parser.js';

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
});
