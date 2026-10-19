import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { standingPolicyDelegation, encodeStandingRevisionIntent } from '@axiom/types';
import { ApprovalEngine } from '@axiom/approval-engine';
import { StandingCoordinator, StandingReadinessRefused } from './standing-coordinator.js';
const id = (n: number) => `17310000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
function fixture() {
  const request = {
    schemaVersion: 1 as const,
    operationKey: id(1),
    tenantId: id(2),
    ownerId: id(3),
    reviewerId: id(4),
    previousRevisionId: null,
    expiresAt: '2030-01-01T00:00:00Z',
    maxAuthorizations: 1 as const,
    mode: 'individual' as const,
    concurrency: 1 as const,
    stopOnFailure: true as const,
    reason: 'Explicit isolated synthetic standing delegation',
    source: {
      policyId: id(5),
      policyVersion: 1,
      policySha256: '9'.repeat(64),
      policyExpiresAt: '2030-01-01T00:00:00Z',
      planId: id(6),
      planVersion: 1,
      actionId: id(7),
      contentDigest: 'a'.repeat(64),
      bindingId: id(8),
      connectorId: id(9),
      engagementId: id(10),
      fixtureId: id(11),
      resourceId: id(12),
      deploymentRequestId: id(13),
      deploymentApprovalId: id(14),
      deploymentExpiresAt: '2030-01-01T00:00:00Z',
      environment: 'local' as const,
      engineSha256: 'b'.repeat(64),
      capabilitySha256: 'c'.repeat(64),
      snapshotSha256: 'd'.repeat(64),
      rollbackSha256: 'e'.repeat(64),
      roundtripSha256: 'f'.repeat(64),
      dryRunId: id(15),
      dryRunExpiresAt: '2030-01-01T00:00:00Z',
      custodyPolicyId: id(16),
      custodyEpoch: 1,
      custodyActivationEventId: id(17),
      nominatedOperatorId: id(18),
      planInitiatorId: id(3),
      actionType: 'config.audit_log_enable' as const,
      desiredEnabled: true as const,
    },
  };
  const value = standingPolicyDelegation.parse({
    schemaVersion: 1,
    purpose: 'axiom.standing-policy-delegation.v1',
    tenantId: id(2),
    revisionId: id(1),
    requestSha256: createHash('sha256')
      .update(encodeStandingRevisionIntent({ phase: 'request', request }))
      .digest('hex'),
    request,
    ownerDecision: { actorId: id(3), challengeId: id(30), receiptId: '10' },
    reviewerDecision: { actorId: id(4), challengeId: id(31), receiptId: '11' },
  });
  const engine = new ApprovalEngine();
  engine.setTenantSecret(id(2), 'Synthetic 173 first signing key');
  engine.setTenantSecret(id(99), 'Synthetic 173 other signing key');
  return { engine, value };
}

function harness(responses: Array<{ data?: unknown; error?: unknown }>) {
  const { engine, value } = fixture();
  const calls: Array<{ name: string; args: Record<string, unknown>; signal: AbortSignal }> = [];
  const db = {
    rpc: (name: string, args: Record<string, unknown>) => ({
      abortSignal: async (signal: AbortSignal) => {
        calls.push({ name, args, signal });
        const next = responses.shift();
        if (!next) throw Error('Unplanned RPC');
        return { data: next.data ?? null, error: next.error ?? null };
      },
    }),
  } as unknown as SupabaseClient;
  const ready = vi.fn(async () => {});
  const coordinator = new StandingCoordinator(db, engine, { requireReady: ready });
  const ref = { tenantId: id(2), workId: id(40), kind: 'approval' as const };
  const issued = { ...ref, state: 'issued', receiptId: '100', tokenId: id(50) };
  const claim = {
    ...ref,
    state: 'claimed',
    delegation: value,
    delegationSignature: engine.signStandingDelegation(id(2), value),
    currentSource: value.request.source,
    nonce: '1'.repeat(32),
    tokenExpiresAt: '2029-01-01T00:00:00.000000Z',
  };
  return { engine, value, calls, ready, coordinator, ref, issued, claim };
}
it('issues exactly the frozen one-action payload with original named human/delegation receipts', async () => {
  const h = harness([]);
  const replies = [{ data: h.claim }, { data: h.issued }];
  // Responses are intentionally mutable only in this test transport.
  const q = harness(replies);
  q.claim.delegationSignature = q.engine.signStandingDelegation(id(2), q.value);
  replies[0] = { data: q.claim };
  expect(await q.coordinator.perform(q.ref)).toEqual(q.issued);
  expect(q.calls.map((c) => c.name)).toEqual([
    'claim_standing_policy_work',
    'issue_standing_policy_approval',
  ]);
  expect(q.ready).toHaveBeenCalledOnce();
  const args = q.calls[1]!.args;
  expect(args.p_signed_payload).toMatchObject({
    actionIds: [id(7)],
    approverId: id(4),
    mode: 'individual',
    concurrency: 1,
    stopOnFailure: true,
    nonce: q.claim.nonce,
    expiresAt: q.claim.tokenExpiresAt,
    contentDigest: 'a'.repeat(64),
    conditions: {
      purpose: 'remediation_execution_v1',
      standingPolicy: {
        revisionId: id(1),
        ownerReceiptId: '10',
        reviewerReceiptId: '11',
        fireId: id(40),
      },
    },
  });
  expect(args).not.toHaveProperty('p_actor_id');
  expect(q.calls.every((c) => c.signal instanceof AbortSignal)).toBe(true);
});
it('lost issuance reply reads original outcome once without signing/issuing a fresh nonce', async () => {
  const q = harness([]);
  const r = [{ data: q.claim }, { error: { code: 'timeout' } }, { data: q.issued }];
  const h = harness(r);
  expect(await h.coordinator.perform(h.ref)).toEqual(h.issued);
  expect(h.calls.map((c) => c.name)).toEqual([
    'claim_standing_policy_work',
    'issue_standing_policy_approval',
    'read_standing_policy_work',
  ]);
});
it('lost claim reply performs only readback and never launches again', async () => {
  const h = harness([
    { error: { code: 'timeout' } },
    {
      data: {
        tenantId: id(2),
        workId: id(40),
        kind: 'approval',
        state: 'unconfirmed',
        receiptId: null,
        tokenId: null,
      },
    },
  ]);
  expect((await h.coordinator.perform(h.ref)).state).toBe('unconfirmed');
  expect(h.calls.map((c) => c.name)).toEqual([
    'claim_standing_policy_work',
    'read_standing_policy_work',
  ]);
  expect(h.ready).not.toHaveBeenCalled();
});
it('a prior claimed orphan returns unconfirmed without ever issuing', async () => {
  const outcome = {
    tenantId: id(2),
    workId: id(40),
    kind: 'approval',
    state: 'unconfirmed',
    receiptId: null,
    tokenId: null,
  };
  const h = harness([{ data: outcome }]);
  expect(await h.coordinator.perform(h.ref)).toEqual(outcome);
  expect(h.calls).toHaveLength(1);
});
it.each(['tenantId', 'workId'] as const)(
  'refuses cross-boundary %s assignments before any signing/readiness',
  async (field) => {
    const q = harness([]);
    const h = harness([{ data: { ...q.claim, [field]: id(98) } }]);
    expect((await h.coordinator.perform(h.ref)).state).toBe('unconfirmed');
    expect(h.calls).toHaveLength(1);
    expect(h.ready).not.toHaveBeenCalled();
  },
);
it.each(['signature', 'source'] as const)(
  'durably escalates changed %s without token issuance',
  async (field) => {
    const q = harness([]);
    const invalid =
      field === 'signature'
        ? { ...q.claim, delegationSignature: '0'.repeat(64) }
        : { ...q.claim, currentSource: { ...q.claim.currentSource, custodyEpoch: 2 } };
    const outcome = { ...q.ref, state: 'escalated', receiptId: '101', tokenId: null };
    const h = harness([{ data: invalid }, { data: outcome }]);
    expect(await h.coordinator.perform(h.ref)).toEqual(outcome);
    expect(h.calls.map((c) => c.name)).toEqual([
      'claim_standing_policy_work',
      'refuse_standing_policy_work',
    ]);
    expect(h.ready).not.toHaveBeenCalled();
  },
);
it('known BR2 refusal is durable; unavailable readiness remains uncertain and never issues', async () => {
  for (const known of [true, false]) {
    const q = harness([]);
    const h = harness([
      { data: q.claim },
      { data: { ...q.ref, state: 'escalated', receiptId: '101', tokenId: null } },
    ]);
    h.ready.mockRejectedValueOnce(
      known
        ? new StandingReadinessRefused('Recorded rollback is invalid')
        : new Error('Backend read unavailable'),
    );
    expect((await h.coordinator.perform(h.ref)).state).toBe(known ? 'escalated' : 'unconfirmed');
    expect(h.calls.map((c) => c.name)).toEqual(
      known
        ? ['claim_standing_policy_work', 'refuse_standing_policy_work']
        : ['claim_standing_policy_work'],
    );
  }
});
it('seals only a validated typed human delegation, never an execution payload', async () => {
  const q = harness([]);
  const ref = { ...q.ref, kind: 'seal' };
  const outcome = { ...ref, state: 'sealed', receiptId: '102', tokenId: null };
  const h = harness([
    { data: { ...ref, state: 'claimed', delegation: q.value } },
    { data: outcome },
  ]);
  expect(await h.coordinator.perform(ref)).toEqual(outcome);
  expect(h.calls[1]!.name).toBe('seal_standing_policy_delegation');
  expect(h.calls[1]!.args.p_signature).toBe(h.engine.signStandingDelegation(id(2), q.value));
  expect(h.ready).not.toHaveBeenCalled();
});
it('abort before claim has no side effects', async () => {
  const h = harness([]);
  const a = new AbortController();
  a.abort();
  expect((await h.coordinator.perform(h.ref, a.signal)).state).toBe('unconfirmed');
  expect(h.calls).toHaveLength(0);
});
it('polls at most one strict durable assignment and reports unavailable honestly', async () => {
  const h = harness([
    {
      data: {
        work: [
          { tenantId: id(2), workId: id(40), kind: 'approval' },
          { tenantId: id(2), workId: id(41), kind: 'approval' },
        ],
      },
    },
  ]);
  await h.coordinator.once();
  expect(h.coordinator.health().phase).toBe('unavailable');
  expect(h.calls).toHaveLength(1);
});
