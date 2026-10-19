import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, expect, it, vi } from 'vitest';
import { canonicalJson } from '@axiom/ledger';
import { coverageProducerAssignment } from '@axiom/types';
import { ScheduledCoverageProducer } from './scheduled-coverage-producer.js';
const seal = vi.hoisted(() => vi.fn());
vi.mock('./dispatch-payload.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./dispatch-payload.js')>()),
  sealDispatch: seal,
}));
const id = (n: number) => `17510000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sha = 'a'.repeat(64),
  ref = { tenantId: id(14), fireId: id(17) };
const custody = {
  custodyPolicyId: id(7),
  custodyPolicySha256: sha,
  keyPolicySha256: sha,
  activationEventId: id(8),
  activationEpoch: 1,
  deploymentBindingSha256: sha,
};
function assigned() {
  const inputText = canonicalJson({
    tenant_id: ref.tenantId,
    engagement_id: id(18),
    library_version: '0.1.1',
    answers: {},
    sdf_self_attested: null,
    processes_children: null,
    processes_health: null,
  });
  return coverageProducerAssignment.parse({
    ...ref,
    state: 'runnable',
    ownerId: id(15),
    scopeId: id(13),
    scopeReceiptId: '25',
    source: {
      scheduleId: id(1),
      readScopeId: id(2),
      estateId: id(3),
      connectorId: id(4),
      grantId: id(5),
      configurationSha256: sha,
      cadence: '*/5 * * * *',
      workloadId: id(6),
      custodyPolicyId: id(7),
      custodyPolicySha256: sha,
      keyPolicySha256: sha,
      custodyActivationEventId: id(8),
      custodyEpoch: 1,
      deploymentBindingSha256: sha,
      baselineRunId: id(9),
      baselineResultSha256: sha,
      preflightFireId: id(10),
      preflightDiscoveryRequestId: id(11),
      preflightDiscoveryId: id(12),
      preflightResultSha256: sha,
      catalogue: {
        libraryVersion: '0.1.1',
        rowsSha256: sha,
        questionnaireDigest: sha,
        manifestSha256: sha,
        selectionOperationKey: null,
      },
    },
    discoveryFireId: id(21),
    discoveryRequestId: id(22),
    discoveryId: id(23),
    discoveryResultSha256: sha,
    discoveryCompletedAt: '2026-01-01T00:00:00Z',
    engagementId: id(18),
    jobId: id(19),
    expiresAt: '2099-01-01T00:00:00Z',
    inputText,
    inputSha256: createHash('sha256').update(inputText).digest('hex'),
  });
}
const outcome = {
  ...ref,
  state: 'dispatched',
  engagementId: id(18),
  jobId: id(19),
  runId: id(20),
  receiptId: '26',
  resultDigest: null,
};
function setup(claim: unknown = assigned(), failedWrite = false) {
  const calls: { name: string; args: unknown; signal: AbortSignal }[] = [];
  const rpc = vi.fn((name: string, args: unknown) => ({
    abortSignal: async (signal: AbortSignal) => {
      calls.push({ name, args, signal });
      return {
        name,
        data:
          name === 'claim_scheduled_coverage_fire'
            ? claim
            : name === 'reserve_scheduled_coverage_fire'
              ? { fires: [ref] }
              : outcome,
        error: failedWrite && name === 'enqueue_scheduled_coverage_dispatch' ? {} : null,
      };
    },
  }));
  const producer = new ScheduledCoverageProducer({ rpc } as unknown as SupabaseClient, [
    { tenantId: ref.tenantId, workloadId: id(6), custody, wrapper: { wrap: vi.fn() } },
  ]);
  return { producer, calls };
}
beforeEach(() =>
  seal
    .mockReset()
    .mockResolvedValue({
      key_ref: 'axiom-local-dispatch://fixture/key',
      nonce: '01'.repeat(12),
      ciphertext: '02'.repeat(32),
      wrapped_key: '03'.repeat(48),
    }),
);
it('uses only original server-derived identity, new engagement and unknown declarations', async () => {
  const { producer, calls } = setup();
  expect(await producer.request(ref)).toEqual(outcome);
  expect(calls.map((c) => c.name)).toEqual([
    'claim_scheduled_coverage_fire',
    'enqueue_scheduled_coverage_dispatch',
  ]);
  expect(seal).toHaveBeenCalledTimes(1);
  expect(seal.mock.calls[0]![0]).toEqual({
    jobId: id(19),
    tenantId: ref.tenantId,
    actorId: id(15),
    workloadId: id(6),
    estateId: id(3),
    engagementId: id(18),
    correlationId: id(19),
    inputHash: assigned().inputSha256,
  });
  expect(seal.mock.calls[0]![1]).toEqual(assigned().inputText);
  expect(Object.keys(calls[1]!.args as object).sort()).toEqual([
    'p_ciphertext',
    'p_fire_id',
    'p_key_ref',
    'p_nonce',
    'p_proof_hash',
    'p_tenant_id',
    'p_wrapped_key',
  ]);
  expect(calls.every((c) => c.signal instanceof AbortSignal)).toBe(true);
});
it('a lost enqueue reply performs original readback without a second mutation/wrap', async () => {
  const { producer, calls } = setup(assigned(), true);
  expect(await producer.request(ref)).toEqual(outcome);
  expect(calls.map((c) => c.name)).toEqual([
    'claim_scheduled_coverage_fire',
    'enqueue_scheduled_coverage_dispatch',
    'read_scheduled_coverage_fire',
  ]);
  expect(seal).toHaveBeenCalledTimes(1);
});
it('already claimed original work is readback only, not relaunch authority', async () => {
  const { producer, calls } = setup({
    ...outcome,
    state: 'unconfirmed',
    runId: null,
    receiptId: null,
  });
  expect((await producer.request(ref)).state).toBe('unconfirmed');
  expect(calls).toHaveLength(1);
  expect(seal).not.toHaveBeenCalled();
});
it.each(['answers', 'sdf_self_attested', 'processes_children', 'processes_health'])(
  'rejects injected business facts %s before wrapping',
  async (field) => {
    const c = assigned(),
      input = JSON.parse(c.inputText) as Record<string, unknown>;
    input[field] = field === 'answers' ? { consent: { yes: true } } : true;
    c.inputText = canonicalJson(input);
    c.inputSha256 = createHash('sha256').update(c.inputText).digest('hex');
    const { producer, calls } = setup(c);
    await producer.request(ref);
    expect(seal).not.toHaveBeenCalled();
    expect(calls.map((c) => c.name)).toEqual([
      'claim_scheduled_coverage_fire',
      'read_scheduled_coverage_fire',
    ]);
  },
);
it.each([
  'custodyEpoch',
  'workloadId',
  'deploymentBindingSha256',
  'custodyPolicySha256',
  'keyPolicySha256',
])('refuses stale deployment %s before key wrapping', async (field) => {
  const c = assigned();
  const source = c.source as unknown as Record<string, unknown>;
  source[field] = field === 'custodyEpoch' ? 2 : field === 'workloadId' ? id(99) : 'b'.repeat(64);
  const { producer } = setup(c);
  await producer.request(ref);
  expect(seal).not.toHaveBeenCalled();
});
it('refuses cross-tenant or extra browser-selected fields before any RPC', async () => {
  const { producer, calls } = setup();
  await expect(producer.request({ ...ref, tenantId: id(99) })).rejects.toThrow();
  await expect(producer.request({ ...ref, actorId: id(15) })).rejects.toThrow();
  expect(calls).toHaveLength(0);
});
it('does no new work once caller deadline is already aborted', async () => {
  const { producer, calls } = setup();
  await expect(producer.request(ref, AbortSignal.abort())).rejects.toThrow();
  expect(calls).toHaveLength(0);
  expect(seal).not.toHaveBeenCalled();
});
it('rejects a source input hash mismatch before wrapping', async () => {
  const c = assigned();
  c.inputSha256 = 'b'.repeat(64);
  const { producer } = setup(c);
  await producer.request(ref);
  expect(seal).not.toHaveBeenCalled();
});
