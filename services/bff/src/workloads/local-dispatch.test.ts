import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { TaskProof } from './tasks.js';
import { AssessmentDispatch, type LocalCustodyPins } from './assessment-dispatch.js';
import { sealDispatch, type DispatchContext, type DispatchKeyWrapper } from './dispatch-payload.js';

const id = (n: number) => `67670000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const input = JSON.stringify({
  tenant_id: id(1),
  engagement_id: id(2),
  library_version: 'synthetic-v1',
  answers: { X: { Q: 'synthetic-private-answer' } },
});
const context: DispatchContext = {
  jobId: id(3),
  tenantId: id(1),
  actorId: id(4),
  workloadId: id(5),
  estateId: null,
  engagementId: id(2),
  correlationId: id(3),
  inputHash: createHash('sha256').update(input).digest('hex'),
};
const pins: LocalCustodyPins = {
  custodyPolicyId: id(10),
  custodyPolicySha256: 'a'.repeat(64),
  keyPolicySha256: 'b'.repeat(64),
  activationEventId: id(11),
  activationEpoch: 1,
  deploymentBindingSha256: 'c'.repeat(64),
};
const reviewRef = {
  reviewId: id(12),
  requestSha256: 'd'.repeat(64),
  snapshotSha256: 'e'.repeat(64),
};
const keyRef = `axiom-local-dispatch://${id(1)}/${id(10)}/versions/1`;

function fakeWrapper(): DispatchKeyWrapper {
  const master = randomBytes(32);
  return {
    async wrap(aad, key) {
      const nonce = randomBytes(12),
        c = createCipheriv('aes-256-gcm', master, nonce);
      c.setAAD(aad);
      return {
        keyRef,
        wrappedKey: Buffer.concat([nonce, c.update(key), c.final(), c.getAuthTag()]),
      };
    },
    async unwrap(aad, _ref, bytes) {
      const b = Buffer.from(bytes),
        d = createDecipheriv('aes-256-gcm', master, b.subarray(0, 12));
      d.setAAD(aad);
      d.setAuthTag(b.subarray(-16));
      return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]);
    },
  };
}
function client(handler: (url: string, body: Record<string, unknown>) => unknown) {
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    return new Response(JSON.stringify(handler(String(url), body)));
  });
  return {
    fetcher,
    db: createClient('https://local.invalid', 'key', {
      global: { fetch: fetcher },
      auth: { persistSession: false },
    }),
  };
}

describe('local custody dispatch mode', () => {
  it('is exclusive with cloud KMS policy bindings', () => {
    const { db } = client(() => null);
    expect(
      () =>
        new AssessmentDispatch(db, fakeWrapper(), new Map([[context.tenantId, 1]]), () => db, pins),
    ).toThrow();
    expect(
      () =>
        new AssessmentDispatch(
          db,
          { ...fakeWrapper(), policyFingerprint: () => 'f'.repeat(64) },
          new Map(),
          () => db,
          pins,
        ),
    ).toThrow();
    expect(
      () =>
        new AssessmentDispatch(db, fakeWrapper(), new Map(), () => db, {
          ...pins,
          activationEpoch: 0,
        }),
    ).toThrow();
  });

  it('admits only reviewed public-control work, before any key wrap', async () => {
    const wrapper = fakeWrapper();
    const wrap = vi.spyOn(wrapper, 'wrap');
    const { db, fetcher } = client(() => null);
    await expect(
      new AssessmentDispatch(db, wrapper, new Map(), () => db, pins).enqueue(context, input),
    ).rejects.toThrow();
    expect(wrap).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.every((c) => !String(c[0]).includes('enqueue_local'))).toBe(true);
  });

  it('enqueues through the 0147 local RPC with the exact custody pins and review', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const { db } = client((url, body) => {
      calls.push({ url, body });
      return url.includes('recover_public_control_assessment_dispatch')
        ? null
        : {
            job_id: context.jobId,
            run_id: id(7),
            expires_at: new Date(Date.now() + 200000).toISOString(),
          };
    });
    const row = await new AssessmentDispatch(db, fakeWrapper(), new Map(), () => db, pins).enqueue(
      context,
      input,
      undefined,
      reviewRef,
    );
    expect(row.run_id).toBe(id(7));
    expect(calls.map((c) => c.url.split('/rpc/')[1])).toEqual([
      'recover_public_control_assessment_dispatch',
      'enqueue_local_public_control_assessment_dispatch',
    ]);
    expect(calls[1]!.body).toMatchObject({
      p_custody_policy_id: pins.custodyPolicyId,
      p_custody_policy_sha256: pins.custodyPolicySha256,
      p_key_policy_sha256: pins.keyPolicySha256,
      p_activation_event_id: pins.activationEventId,
      p_activation_epoch: pins.activationEpoch,
      p_deployment_binding_sha256: pins.deploymentBindingSha256,
      p_review_id: reviewRef.reviewId,
      p_key_ref: keyRef,
    });
    expect(calls[1]!.body).not.toHaveProperty('p_policy_revision');
    expect(JSON.stringify(calls[1]!.body)).not.toContain('synthetic-private-answer');
  });

  it('claims through the local RPC and opens the payload only for the pinned policy', async () => {
    const wrapper = fakeWrapper();
    const proof = new TaskProof(randomBytes(32).toString('base64url'));
    const sealed = await sealDispatch(context, input, proof, wrapper);
    const reply = (custody: Partial<Record<string, unknown>> = {}) => ({
      ...sealed,
      job_id: context.jobId,
      tenant_id: context.tenantId,
      run_id: id(7),
      actor_id: context.actorId,
      workload_id: context.workloadId,
      estate_id: null,
      engagement_id: context.engagementId,
      correlation_id: context.correlationId,
      input_hash: context.inputHash,
      proof_hash: createHash('sha256').update(proof.reveal()).digest('hex'),
      expires_at: new Date(Date.now() + 200000).toISOString(),
      local_custody: {
        policy_id: pins.custodyPolicyId,
        policy_sha256: pins.custodyPolicySha256,
        key_policy_sha256: pins.keyPolicySha256,
        grant_sha256: '1'.repeat(64),
        context_sha256: '2'.repeat(64),
        activation_event_id: pins.activationEventId,
        activation_epoch: 1,
        original_expires_at: new Date(Date.now() + 200000).toISOString(),
        ...custody,
      },
    });
    let next = reply();
    const { db, fetcher } = client(() => next);
    const dispatch = new AssessmentDispatch(db, wrapper, new Map(), () => db, pins);
    const claimed = await dispatch.claim(context.tenantId, context.jobId);
    expect(claimed.payload.reveal().inputJson).toBe(input);
    expect(String(fetcher.mock.calls[0]![0])).toContain('/rpc/claim_local_assessment_dispatch');
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({
      p_tenant_id: context.tenantId,
      p_job_id: context.jobId,
      p_custody_policy_id: pins.custodyPolicyId,
      p_custody_policy_sha256: pins.custodyPolicySha256,
      p_key_policy_sha256: pins.keyPolicySha256,
    });
    next = reply({ key_policy_sha256: 'f'.repeat(64) });
    await expect(dispatch.claim(context.tenantId, context.jobId)).rejects.toThrow();
    next = { ...reply() } as ReturnType<typeof reply>;
    delete (next as Record<string, unknown>).local_custody;
    await expect(dispatch.claim(context.tenantId, context.jobId)).rejects.toThrow();
  });
});
