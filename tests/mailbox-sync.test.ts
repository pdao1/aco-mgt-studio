import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { Repository } from '../server/database/repository.js';
import type { SecretBox } from '../server/security/secret-box.js';
import { MAILBOX_PARSER_VERSION, orderDiscoveryQuery, selectMessageBatch } from '../server/email/discovery.js';

const mock = vi.hoisted(() => ({ client: {} as Record<string, unknown> }));
vi.mock('imapflow', () => ({ ImapFlow: class { constructor() { return mock.client; } } }));
import { MailboxSyncCoordinator } from '../server/email/imap.js';

const receivedAt = new Date('2026-09-20T12:00:00Z');
function message(uid: number, subject = 'Your order confirmation', messageId: string | null = `<${uid}@target.com>`) {
  return {
    uid, internalDate: receivedAt,
    envelope: { messageId, subject, from: [{ address: 'orders@oe.target.com', name: 'Target' }] },
    source: Buffer.from(`From: Target <orders@oe.target.com>\r\n${messageId ? `Message-ID: ${messageId}\r\n` : ''}Subject: ${subject}\r\nDate: ${receivedAt.toUTCString()}\r\nContent-Type: text/plain\r\n\r\nOrder number: TG-${10000 + uid}\r\nOrder total: $12.00\r\n`),
  };
}

function setup(messages: ReturnType<typeof message>[], processed: string[] = [], limit = 2) {
  const keys = new Set(processed);
  let backfillDays = 0;
  const sourceFetches: number[][] = [];
  mock.client = {
    usable: true, connect: vi.fn(), logout: vi.fn(),
    list: vi.fn(async () => [{ specialUse: '\\All', path: '[Gmail]/All Mail' }]),
    getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
    search: vi.fn(async () => messages.map((m) => m.uid)),
    fetch: async function* (uids: number[], query: { source?: boolean }) {
      if (query.source) sourceFetches.push(uids);
      for (const m of messages.filter((m) => uids.includes(m.uid))) yield m;
    },
  };
  const repository = {
    getMailbox: vi.fn(async () => ({ gmailAddress: 'buyer@gmail.com', secretCiphertext: 'secret', syncDays: 90, backfillDays, lastSyncedAt: receivedAt })),
    setMailboxBackfillDays: vi.fn(async (_w, _c, days: number) => { backfillDays = days; }),
    beginSync: vi.fn(async () => 'run'), finishSync: vi.fn(),
    listOrderNumbers: vi.fn(async () => []),
    listProcessedMessageKeys: vi.fn(async () => [...keys]),
    recordMessage: vi.fn(async (_w, _c, meta, parsed) => { keys.add(meta.messageKey); return Boolean(parsed); }),
  };
  const sync = new MailboxSyncCoordinator(repository as unknown as Repository,
    { decrypt: () => 'password' } as unknown as SecretBox, 'workspace', limit);
  async function run(fullHistory = false) {
    expect(sync.enqueue('customer', { fullHistory })).toBe(true);
    await vi.waitFor(() => expect(sync.isActive('customer')).toBe(false));
    expect(repository.finishSync).toHaveBeenLastCalledWith('workspace', 'customer', 'run', expect.not.objectContaining({ errorCode: expect.anything() }));
  }
  return { repository, sourceFetches, run };
}

beforeEach(() => vi.clearAllMocks());

describe('mailbox discovery and replay', () => {
  it('searches body keywords and retailer subdomain mail without category exclusions', () => {
    const query = orderDiscoveryQuery(new Date('2025-09-23Z'));
    expect(query).toContain('after:2025/09/23');
    for (const term of ['order', 'purchase', 'receipt', 'refund', 'pickup', 'from:target.com']) expect(query).toContain(term);
    expect(query).not.toMatch(/subject:|category:|in:inbox/);
  });

  it('splits old/new work without slice(-0) overrunning a one-message cap', () => {
    expect(selectMessageBatch([5, 4, 3, 2, 1, 1], 1)).toEqual([1]);
    expect(selectMessageBatch([5, 4, 3, 2, 1], 3)).toEqual([1, 2, 5]);
  });

  it('deduplicates before the cap and drains historical backlog across runs', async () => {
    const { repository, sourceFetches, run } = setup([1, 2, 3, 4, 5, 6].map((uid) => message(uid)), ['<5@target.com>', '<6@target.com>']);
    await run();
    expect(sourceFetches[0]).toEqual([1, 4]);
    await run();
    expect(sourceFetches[1]).toEqual([2, 3]);
    await run();
    expect(sourceFetches).toHaveLength(2);
    expect(repository.listProcessedMessageKeys).toHaveBeenCalledWith('workspace', 'customer', MAILBOX_PARSER_VERSION);
    expect(repository.recordMessage.mock.calls.every((call) => call[2].parserVersion === MAILBOX_PARSER_VERSION)).toBe(true);
  });

  it('excludes PINs before source download without using the order quota', async () => {
    const { sourceFetches, repository, run } = setup([message(1, 'Your one-time code'), message(2), message(3)]);
    await run();
    expect(sourceFetches).toEqual([[2, 3]]);
    expect(repository.recordMessage).toHaveBeenCalledWith('workspace', 'customer', expect.objectContaining({ messageKey: '<1@target.com>' }), null);
  });

  it('deduplicates mail without Message-ID using the same stable header key', async () => {
    const noId = message(1, 'Order confirmation', null);
    const key = createHash('sha256').update(`1\0orders@oe.target.com\0Order confirmation\0${receivedAt.toISOString()}`).digest('hex');
    const { sourceFetches, run } = setup([noId, message(2)], [key]);
    await run();
    expect(sourceFetches).toEqual([[2]]);
  });

  it('manual repair searches a year, polling searches the saved window regardless of last sync', async () => {
    const { run } = setup([]);
    await run(true);
    const year = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10).replace(/-/g, '/');
    expect(mock.client.search).toHaveBeenLastCalledWith({ gmraw: expect.stringContaining(`after:${year}`) }, { uid: true });
    await run();
    const saved = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10).replace(/-/g, '/');
    expect(mock.client.search).toHaveBeenLastCalledWith({ gmraw: expect.stringContaining(`after:${saved}`) }, { uid: true });
  });

  it('keeps the deep-scan window for subsequent polls until all batches are drained', async () => {
    const { run, repository, sourceFetches } = setup([1, 2, 3].map((uid) => message(uid)), [], 1);
    await run(true);
    const deepQuery = vi.mocked(mock.client.search as (...args: unknown[]) => unknown).mock.calls[0][0];
    await run();
    expect(mock.client.search).toHaveBeenLastCalledWith(deepQuery, { uid: true });
    expect(repository.setMailboxBackfillDays).not.toHaveBeenCalledWith('workspace', 'customer', 0);
    await run();
    expect(repository.setMailboxBackfillDays).toHaveBeenLastCalledWith('workspace', 'customer', 0);
    expect(sourceFetches).toEqual([[1], [2], [3]]);
  });
});
