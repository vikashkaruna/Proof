import { it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { encodeLocalCustodyPolicy } from '@axiom/types';
import { LocalKeyPolicy } from './local-key-policy.js';
import { dispatchWrappingContext } from './dispatch-payload.js';
import {
  createLocalCustodyAdmissionReader,
  verifyLocalCustodyPolicy,
  type LocalCustodyReadRpc,
} from './local-key-admission.js';
const tenant = '11111111-1111-4111-8111-111111111111',
  policyId = '22222222-2222-4222-8222-222222222222',
  operator = '33333333-3333-4333-8333-333333333333',
  workload = '44444444-4444-4444-8444-444444444444',
  job = '55555555-5555-4555-8555-555555555555';
const ref = `axiom-local-dispatch://${tenant}/${policyId}/versions/1`,
  sha = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
const p = {
  version: 1,
  policyId,
  tenantId: tenant,
  mode: 'operator_managed' as const,
  nominatedOperatorId: operator,
  targetWorkloadId: workload,
  servicePrincipals: {
    producer: 'spiffe://local.axiom/service/assessment-dispatch-producer',
    controller: 'spiffe://local.axiom/controller/assessment',
  },
  validity: { kind: 'until_revoked' as const, reviewDueAt: 1 },
  actionClass: 'assessment_dispatch_key_custody',
  keyPolicy: { primary: ref, readable: [ref] },
  keyPolicySha256: new LocalKeyPolicy({
    tenantId: tenant,
    revision: policyId,
    mode: 'operator_managed',
    validity: { kind: 'until_revoked', reviewDueAt: 1 },
    primary: ref,
    readable: [ref],
  }).fingerprint,
  deploymentBindingSha256: 'b'.repeat(64),
  reason: 'Local custody qualification',
  acceptedLimitations: ['hardware_backing_unverified'],
  statutoryComplianceAsserted: false,
  ownershipVerified: false,
};
const text = encodeLocalCustodyPolicy(p),
  context = dispatchWrappingContext({
    tenantId: tenant,
    jobId: job,
    actorId: operator,
    workloadId: workload,
    estateId: null,
    engagementId: policyId,
    correlationId: operator,
    inputHash: 'a'.repeat(64),
  });
function input() {
  return {
    tenantId: tenant,
    policyId,
    policySha256: sha(text),
    keyPolicySha256: p.keyPolicySha256,
    workloadId: workload,
    servicePrincipal: p.servicePrincipals.producer,
    operation: 'wrap' as 'wrap' | 'unwrap' | 'provision',
    keyRef: ref,
    context: Buffer.from(context) as Uint8Array | null,
    expectedRunId: null as string | null,
    deadline: Date.now() + 1000,
  };
}
function output(args: Record<string, unknown>) {
  return {
    version: 1,
    tenantId: tenant,
    policyId,
    policySha256: sha(text),
    keyPolicySha256: p.keyPolicySha256,
    mode: p.mode,
    operation: args.p_operation,
    keyRef: ref,
    workloadId: workload,
    principalKind: 'producer',
    servicePrincipal: p.servicePrincipals.producer,
    contextSha256: sha(context),
    kind: 'new_authority',
    policyState: 'active',
    currentIsDemo: false,
    reviewOverdue: true,
    reviewDueAt: 1,
    verifiedUntil: args.p_deadline_ms,
    policyText: text,
    grant: null,
  };
}
it('verifies both policy commitments and preserves overdue review as a reminder', async () => {
  expect(verifyLocalCustodyPolicy(text, sha(text))).toEqual(p);
  const read = vi.fn(async (_name: string, args: Record<string, unknown>) => ({
    data: output(args),
    error: null,
  }));
  const reader = createLocalCustodyAdmissionReader(read);
  expect(await reader(input())).toMatchObject({ kind: 'new_authority', reviewOverdue: true });
  expect(read).toHaveBeenCalledWith(
    'read_local_custody_admission',
    expect.objectContaining({ p_context_text: context.toString() }),
    expect.any(AbortSignal),
  );
  expect(() => verifyLocalCustodyPolicy(text, '0'.repeat(64))).toThrow();
});
it.each([
  'tenantId',
  'policyId',
  'policySha256',
  'keyPolicySha256',
  'workloadId',
  'servicePrincipal',
  'principalKind',
  'contextSha256',
  'keyRef',
  'operation',
])('refuses foreign or mismatched %s', async (field) => {
  const reader = createLocalCustodyAdmissionReader(async (_name, args) => ({
    data: { ...output(args), [field]: 'wrong' },
    error: null,
  }));
  await expect(reader(input())).rejects.toThrow();
});
it('separates target agent workload from producer/controller service identity', async () => {
  const read = vi.fn(async (_name: string, args: Record<string, unknown>) => ({
    data: { ...output(args), servicePrincipal: 'spiffe://local.axiom/agent/parikshan' },
    error: null,
  }));
  await expect(createLocalCustodyAdmissionReader(read)(input())).rejects.toThrow();
});
it('refuses new authorization after revocation, but recognizes an exact original accepted-job grant honestly', async () => {
  const revoked = createLocalCustodyAdmissionReader(async (_n, args) => ({
    data: { ...output(args), policyState: 'revoked' },
    error: null,
  }));
  await expect(revoked(input())).rejects.toThrow();
  const request = {
    ...input(),
    operation: 'unwrap' as const,
    expectedRunId: operator,
    servicePrincipal: p.servicePrincipals.controller,
  };
  const reader = createLocalCustodyAdmissionReader(async (_n, args) => ({
    data: {
      ...output(args),
      principalKind: 'controller',
      servicePrincipal: p.servicePrincipals.controller,
      kind: 'accepted_job',
      verifiedUntil: Math.min(Number(args.p_deadline_ms), Date.now() + 400),
      policyState: 'revoked',
      grant: {
        jobId: job,
        runId: operator,
        contextSha256: sha(context),
        grantSha256: 'c'.repeat(64),
        originalExpiresAt: Date.now() + 500,
        activationEventId: operator,
        activationEpoch: 1,
      },
    },
    error: null,
  }));
  expect(await reader(request)).toMatchObject({ kind: 'accepted_job', policyState: 'revoked' });
  await expect(reader({ ...request, expectedRunId: job })).rejects.toThrow();
  await expect(
    reader({ ...request, context: Buffer.from(context.toString().replace(job, operator)) }),
  ).rejects.toThrow();
});
it('copies immutable scope before an asynchronous authority lookup', async () => {
  let resolve!: (r: Awaited<ReturnType<LocalCustodyReadRpc>>) => void;
  let args!: Record<string, unknown>;
  const read: LocalCustodyReadRpc = async (_n, a) => {
    args = a;
    return new Promise((r) => {
      resolve = r;
    });
  };
  const reader = createLocalCustodyAdmissionReader(read),
    request = input(),
    pending = reader(request);
  await new Promise<void>((r) => setImmediate(r));
  request.tenantId = operator;
  (request.context as Uint8Array).fill(0);
  resolve({ data: output(args), error: null });
  expect(await pending).toMatchObject({ tenantId: tenant, contextSha256: sha(context) });
});
it('fails before RPC on invalid scope and bounds ignored cancellation without accumulating work', async () => {
  const read = vi.fn<LocalCustodyReadRpc>(async () => new Promise(() => {})),
    reader = createLocalCustodyAdmissionReader(read);
  await expect(reader({ ...input(), context: new Uint8Array(4097) })).rejects.toThrow();
  await expect(reader({ ...input(), deadline: 1 })).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
  await Promise.all(
    Array.from({ length: 8 }, () =>
      reader({ ...input(), deadline: Date.now() + 10 }).catch(() => undefined),
    ),
  );
  expect(read).toHaveBeenCalledTimes(8);
  await expect(reader(input())).rejects.toThrow();
  expect(read).toHaveBeenCalledTimes(8);
});
