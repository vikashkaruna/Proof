import { beforeEach, expect, it, vi } from 'vitest';
import { canonicalJson, sha256 } from '@axiom/ledger';
import {
  archiveConfirmedOwnedRequest,
  recoverOwnedOriginalOutcome,
  ownedJournalSchema,
  ownedRequestJournalKey,
  readOwnedRequestJournal,
  retainOwnedCancellation,
  retainOwnedRequestJournal,
  submitOwnedCancellation,
  submitOwnedOriginal,
  withOwnedRequestLock,
} from './owned-target-request';
const id = (n: number) => `89130000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let values: Map<string, string>;
let storage: {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};
const lockRequest = vi.fn(
  async (
    _name: string,
    _options: unknown,
    work: (lock: { name: string; mode: 'exclusive' } | null) => Promise<unknown>,
  ) => work({ name: 'owned-fixture-lock', mode: 'exclusive' }),
);
beforeEach(() => {
  values = new Map();
  storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  lockRequest.mockClear();
  lockRequest.mockImplementation(async (_name, _options, work) =>
    work({ name: 'owned-fixture-lock', mode: 'exclusive' }),
  );
  vi.stubGlobal('navigator', { locks: { request: lockRequest } });
});
function journal() {
  return ownedJournalSchema.parse({
    version: 1,
    tenantId: id(1),
    actorId: id(2),
    request: {
      operationKey: id(3),
      bindingId: id(4),
      engagementId: id(5),
      expectedSnapshotHash: 'a'.repeat(64),
      reason: 'Enable audit logging on the owned synthetic target.',
      acknowledgeOwnedSynthetic: true,
      actionType: 'config.audit_log_enable',
      desiredEnabled: true,
    },
  });
}
async function plan() {
  const j = journal();
  return {
    tenantId: j.tenantId,
    actorId: j.actorId,
    operationKey: j.request.operationKey,
    requestHash: await sha256(
      canonicalJson({ tenantId: j.tenantId, actorId: j.actorId, request: j.request }),
    ),
    bindingId: j.request.bindingId,
    engagementId: j.request.engagementId,
    planId: id(6),
    actionId: id(7),
    purpose: 'remediation',
    generatedBy: 'human',
    status: 'review',
    actionCount: 1,
    closesFindingCount: 0,
    approvalTokenId: null,
    executionAllowed: false,
    humanReceipt: '101',
    snapshotHash: j.request.expectedSnapshotHash,
    validationHash: 'b'.repeat(64),
  };
}
async function stopReceipt() {
  const p = await plan();
  return {
    tenantId: p.tenantId,
    actorId: p.actorId,
    operationKey: p.operationKey,
    requestHash: p.requestHash,
    cancellationKey: id(8),
    reason: 'Stop the unrecorded original owned target request.',
    state: 'cancelled',
    humanReceipt: '102',
    planId: null,
    executionAllowed: false,
  };
}
function retainedStop() {
  const j = retainOwnedRequestJournal(storage, journal());
  return retainOwnedCancellation(storage, j, {
    cancellationKey: id(8),
    reason: 'Stop the unrecorded original owned target request.',
  });
}
it('retains exact original across refresh and refuses replacement until confirmed', () => {
  const j = retainOwnedRequestJournal(storage, journal());
  expect(readOwnedRequestJournal(storage, j.tenantId, j.actorId)).toEqual(j);
  expect(() =>
    retainOwnedRequestJournal(storage, { ...j, request: { ...j.request, operationKey: id(99) } }),
  ).toThrow('Resolve the original');
});
it('failed durable readback refuses before any transport write', async () => {
  storage.setItem = () => {};
  const write = vi.fn();
  expect(() => retainOwnedRequestJournal(storage, journal())).toThrow('could not be retained');
  await expect(submitOwnedOriginal(storage, journal(), write)).rejects.toThrow('changed original');
  expect(write).not.toHaveBeenCalled();
});
it('interrupted plan reply retains exact source and retries the same body', async () => {
  const j = retainOwnedRequestJournal(storage, journal()),
    p = await plan();
  const write = vi.fn().mockRejectedValueOnce(Error('Lost committed reply')).mockResolvedValue(p);
  await expect(submitOwnedOriginal(storage, j, write)).rejects.toThrow('Lost committed reply');
  expect(readOwnedRequestJournal(storage, j.tenantId, j.actorId)).toEqual(j);
  const confirmed = await submitOwnedOriginal(storage, j, write);
  expect(write.mock.calls[0]).toEqual(write.mock.calls[1]);
  archiveConfirmedOwnedRequest(storage, j, confirmed);
  expect(values.size).toBe(0);
});
it.each([
  { tenantId: id(99) },
  { actorId: id(99) },
  { operationKey: id(99) },
  { requestHash: 'c'.repeat(64) },
  { bindingId: id(99) },
  { snapshotHash: 'c'.repeat(64) },
  { approvalTokenId: id(99) },
  { executionAllowed: true },
  { humanReceipt: '0' },
  { humanReceipt: '9223372036854775808' },
  { humanReceipt: '9999999999999999999' },
  { closesFindingCount: 1 },
])('rejects forged or escalated plan receipt %j without losing original', async (change) => {
  const j = retainOwnedRequestJournal(storage, journal());
  await expect(
    submitOwnedOriginal(storage, j, vi.fn().mockResolvedValue({ ...(await plan()), ...change })),
  ).rejects.toThrow();
  expect(readOwnedRequestJournal(storage, j.tenantId, j.actorId)).toEqual(j);
});
it('cancellation must be durably appended before dispatch, then blocks new plan dispatch', async () => {
  const j = retainOwnedRequestJournal(storage, journal()),
    write = vi.fn();
  await expect(submitOwnedCancellation(storage, j, write)).rejects.toThrow('Retain the exact');
  const stopped = retainedStop();
  await expect(submitOwnedOriginal(storage, stopped, write)).rejects.toThrow(
    'Resolve the retained cancellation',
  );
  expect(write).not.toHaveBeenCalled();
});
it('interrupted cancellation retains both original and exact stop body', async () => {
  const j = retainedStop(),
    write = vi
      .fn()
      .mockRejectedValueOnce(Error('Stop reply lost'))
      .mockResolvedValue(await stopReceipt());
  await expect(submitOwnedCancellation(storage, j, write)).rejects.toThrow('Stop reply lost');
  expect(readOwnedRequestJournal(storage, j.tenantId, j.actorId)).toEqual(j);
  const result = await submitOwnedCancellation(storage, j, write);
  expect(write.mock.calls[0]).toEqual(write.mock.calls[1]);
  archiveConfirmedOwnedRequest(storage, j, result);
  expect(values.size).toBe(0);
});
it('changed stop keys or reason cannot replace uncertain cancellation', () => {
  const j = retainedStop();
  expect(() =>
    retainOwnedCancellation(storage, j, {
      cancellationKey: id(99),
      reason: j.cancellation!.reason,
    }),
  ).toThrow('Retry the exact');
  expect(readOwnedRequestJournal(storage, j.tenantId, j.actorId)).toEqual(j);
});
it.each([
  { cancellationKey: id(99) },
  { reason: 'Another human stop request with different reason.' },
  { planId: id(99) },
])('rejects changed cancellation response %j and preserves stop journal', async (change) => {
  const j = retainedStop();
  await expect(
    submitOwnedCancellation(
      storage,
      j,
      vi.fn().mockResolvedValue({ ...(await stopReceipt()), ...change }),
    ),
  ).rejects.toThrow();
  expect(readOwnedRequestJournal(storage, j.tenantId, j.actorId)).toEqual(j);
});
it('already-recorded plan can be confirmed by read-only recovery when a stop was pending', async () => {
  const j = retainedStop(),
    outcome = await recoverOwnedOriginalOutcome(storage, j, async () => ({
      state: 'recorded',
      receipt: await plan(),
    }));
  archiveConfirmedOwnedRequest(storage, j, outcome);
  expect(values.size).toBe(0);
});
it('copied or mutated verified outcome cannot archive original source', async () => {
  const j = retainOwnedRequestJournal(storage, journal()),
    outcome = await recoverOwnedOriginalOutcome(storage, j, async () => ({
      state: 'recorded',
      receipt: await plan(),
    }));
  expect(() => archiveConfirmedOwnedRequest(storage, j, { ...outcome })).toThrow(
    'Nothing was archived',
  );
  outcome.receipt.humanReceipt = '999';
  expect(() => archiveConfirmedOwnedRequest(storage, j, outcome)).toThrow('Nothing was archived');
  expect(values.size).toBe(1);
});
it('cross-tab source replacement during reply prevents archive', async () => {
  const j = retainOwnedRequestJournal(storage, journal()),
    outcome = await recoverOwnedOriginalOutcome(storage, j, async () => ({
      state: 'recorded',
      receipt: await plan(),
    }));
  values.set(
    ownedRequestJournalKey(j.tenantId, j.actorId),
    JSON.stringify({
      ...j,
      request: { ...j.request, reason: 'Changed original reason in another browser tab.' },
    }),
  );
  expect(() => archiveConfirmedOwnedRequest(storage, j, outcome)).toThrow('Nothing was archived');
});
it('browser lock missing or held in another tab prevents manual dispatch', async () => {
  const work = vi.fn(async () => true);
  lockRequest.mockImplementation(async (_n, _o, callback) => callback(null));
  await expect(withOwnedRequestLock(id(1), id(2), work)).rejects.toThrow('Another tab');
  vi.stubGlobal('navigator', {});
  await expect(withOwnedRequestLock(id(1), id(2), work)).rejects.toThrow(
    'coordination is unavailable',
  );
  expect(work).not.toHaveBeenCalled();
});
it('browser lock namespaces actor and tenant and permits one explicit operation', async () => {
  const work = vi.fn(async () => true);
  expect(await withOwnedRequestLock(id(1), id(2), work)).toBe(true);
  expect(lockRequest.mock.calls[0]?.slice(0, 2)).toEqual([
    ownedRequestJournalKey(id(1), id(2)),
    { mode: 'exclusive', ifAvailable: true },
  ]);
  expect(work).toHaveBeenCalledOnce();
});
it('accepts exact signed-int64 receipts as strings for both verified outcomes', async () => {
  const j = retainOwnedRequestJournal(storage, journal());
  expect(
    (
      await recoverOwnedOriginalOutcome(storage, j, async () => ({
        state: 'recorded',
        receipt: { ...(await plan()), humanReceipt: '9223372036854775807' },
      }))
    ).receipt.humanReceipt,
  ).toBe('9223372036854775807');
  const stop = retainedStop();
  expect(
    (
      await recoverOwnedOriginalOutcome(storage, stop, async () => ({
        state: 'cancelled',
        receipt: { ...(await stopReceipt()), humanReceipt: '9223372036854775807' },
      }))
    ).receipt.humanReceipt,
  ).toBe('9223372036854775807');
});
it('pending read-only outcome cannot archive or start a new write during uncertain cancellation', async () => {
  const j = retainedStop();
  await expect(
    recoverOwnedOriginalOutcome(storage, j, async () => ({ state: 'pending', receipt: null })),
  ).rejects.toThrow();
  expect(readOwnedRequestJournal(storage, j.tenantId, j.actorId)).toEqual(j);
  const write = vi.fn();
  await expect(submitOwnedOriginal(storage, j, write)).rejects.toThrow();
  expect(write).not.toHaveBeenCalled();
});
