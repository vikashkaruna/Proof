// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  archiveConfirmed,
  assertJournal,
  intentHash,
  journalKey,
  journalText,
  readJournal,
  writeJournal,
  locked,
} from './flow-journal';
import { fixture, id, hash, binding } from './flow.test-fixture';
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('requires durable roundtrip before any operation can be sent', () => {
  const { journal } = fixture();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => undefined);
  expect(() => writeJournal(localStorage, journal, null)).toThrow(/Nothing was sent/);
});
it('rejects foreign scope and changed original content', () => {
  const { journal } = fixture();
  localStorage.setItem(
    journalKey(id(3), id(1)),
    journalText({
      ...journal,
      actorId: id(2),
      intent: {
        phase: 'approve',
        request: {
          schemaVersion: 1,
          operationKey: id(31),
          revisionId: id(30),
          expectedContentSha256: hash,
          reason: 'Synthetic approval reason reviewed.',
        },
      },
    }),
  );
  expect(() => readJournal(localStorage, id(3), id(1))).toThrow(/changed scope/);
});
it('rereads actual storage instead of trusting an earlier tab snapshot', () => {
  const { journal } = fixture();
  if (journal.intent.phase !== 'declare') throw new Error('Synthetic request required');
  writeJournal(localStorage, journal, null);
  localStorage.setItem(
    journalKey(id(3), id(1)),
    journalText({
      ...journal,
      intent: {
        ...journal.intent,
        request: {
          ...journal.intent.request,
          reason: 'A different tab changed this original reason.',
        },
      },
    }),
  );
  expect(() => assertJournal(localStorage, journal)).toThrow(/Another tab/);
  expect(() => writeJournal(localStorage, journal, journal)).toThrow(/Another tab/);
});
it('never replaces an uncertain intent, even with an absent or foreign receipt', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const { journal } = fixture();
  writeJournal(localStorage, journal, null);
  await expect(
    archiveConfirmed(localStorage, journal, {
      ...binding(journal),
      recorded: false,
      requestSha256: await intentHash(journal),
      fenced: false,
      fenceReceiptId: null,
      challengeExpiresAt: null,
    }),
  ).rejects.toThrow(/no matching/);
  await expect(
    archiveConfirmed(localStorage, journal, {
      ...binding(journal),
      recorded: true,
      requestSha256: hash,
      revisionId: id(99),
      state: 'proposed',
      receiptId: '1',
    }),
  ).rejects.toThrow(/no matching/);
  expect(readJournal(localStorage, id(3), id(1))).toEqual(journal);
});
it('archives exact confirmed history before permitting a replacement, without assuming latest state equals phase', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const { journal } = fixture();
  writeJournal(localStorage, journal, null);
  const proof = {
    ...binding(journal),
    recorded: true,
    requestSha256: await intentHash(journal),
    revisionId: id(30),
    state: 'withdrawn',
    receiptId: '123',
  };
  await archiveConfirmed(localStorage, journal, proof);
  expect(readJournal(localStorage, id(3), id(1))).toBeNull();
  expect(localStorage.getItem(journalKey(id(3), id(1)) + ':archive:' + id(30))).toContain(
    journal.intent.request.reason,
  );
});
it('refuses browsers without cross-tab exclusive locking', async () => {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  const run = vi.fn();
  await expect(locked(id(3), id(1), run)).rejects.toThrow(/Web Locks/);
  expect(run).not.toHaveBeenCalled();
});
it.each(['tenantId', 'actorId', 'phase', 'operationKey'] as const)(
  'refuses foreign %s proof even when its intent hash and revision match',
  async (field) => {
    vi.stubGlobal('crypto', webcrypto);
    const { journal } = fixture();
    writeJournal(localStorage, journal, null);
    const proof = {
      ...binding(journal),
      recorded: true,
      requestSha256: await intentHash(journal),
      revisionId: id(30),
      state: 'proposed',
      receiptId: '123',
      [field]: field === 'phase' ? 'withdraw' : id(99),
    };
    await expect(archiveConfirmed(localStorage, journal, proof)).rejects.toThrow();
    expect(readJournal(localStorage, id(3), id(1))).toEqual(journal);
  },
);
