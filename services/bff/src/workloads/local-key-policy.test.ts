import { describe, it, expect, vi } from 'vitest';
import { LocalKeyPolicy, type LocalKeyAdmissionRequest } from './local-key-policy.js';
const tenant = '11111111-1111-4111-8111-111111111111',
  revision = '22222222-2222-4222-8222-222222222222';
const workload = '33333333-3333-4333-8333-333333333333';
const ref = `axiom-local-dispatch://${tenant}/${revision}/versions/1`;
const caller = { tenantId: tenant, workloadId: workload, role: 'producer' as const };
const input = {
  tenantId: tenant,
  revision,
  mode: 'local_demo' as const,
  validity: { kind: 'fixed_expiry' as const, expiresAt: Date.now() + 600000 },
  primary: ref,
  readable: [ref],
};
function record(r: LocalKeyAdmissionRequest) {
  return {
    ...r,
    deadline: undefined,
    verified: true,
    expiresAt: Date.now() + 10000,
    revoked: false,
    isDemo: true,
    operatorActivated: true,
    admissionReceiptId: revision,
    exception: null,
  };
}
function admitted(r: LocalKeyAdmissionRequest) {
  const { deadline: _d, ...value } = record(r);
  return value;
}
describe('explicit local key policy', () => {
  it('does not change or impersonate cloud references', () => {
    expect(
      () =>
        new LocalKeyPolicy({
          ...input,
          primary: 'arn:aws:kms:ap-south-1:123456789012:key/' + revision,
        }),
    ).toThrow();
    expect(() => new LocalKeyPolicy({ ...input, readable: [ref, ref] })).toThrow();
    expect(() => new LocalKeyPolicy({ ...input, tenantId: revision })).toThrow();
    const p = new LocalKeyPolicy(input);
    input.readable.push(ref + 'x');
    expect(p.value.readable).toEqual([ref]);
    input.readable.pop();
  });
  it('denies absent, foreign, stale and wrong-role authority before admission', async () => {
    const p = new LocalKeyPolicy(input),
      port = vi.fn(async (r) => admitted(r));
    await expect(p.require(caller, 'wrap', ref, Date.now() + 1000)).rejects.toThrow();
    for (const c of [
      { ...caller, tenantId: revision },
      { ...caller, role: 'controller' as const },
    ])
      await expect(p.require(c, 'wrap', ref, Date.now() + 1000, port)).rejects.toThrow();
    await expect(p.require(caller, 'wrap', ref, Date.now() - 1, port)).rejects.toThrow();
    expect(port).not.toHaveBeenCalled();
  });
  it.each(['tenantId', 'revision', 'policySha256', 'keyRef', 'workloadId', 'operation', 'mode'])(
    'refuses mismatched %s returned by trusted port',
    async (field) => {
      const p = new LocalKeyPolicy(input);
      await expect(
        p.require(caller, 'wrap', ref, Date.now() + 1000, async (r) => ({
          ...admitted(r),
          [field]: 'wrong',
        })),
      ).rejects.toThrow();
    },
  );
  it.each([{ isDemo: false }, { revoked: true }, { operatorActivated: false }, { expiresAt: 1 }])(
    'refuses unavailable demo policy %j',
    async (change) => {
      await expect(
        new LocalKeyPolicy(input).require(caller, 'wrap', ref, Date.now() + 1000, async (r) => ({
          ...admitted(r),
          ...change,
        })),
      ).rejects.toThrow();
    },
  );
  it('requires strict ordered owner request/founder approval/operator activation for ordinary tenants', async () => {
    const p = new LocalKeyPolicy({
      ...input,
      mode: 'operator_managed',
      validity: { kind: 'until_revoked', reviewDueAt: 1 },
    });
    await expect(
      p.require(caller, 'wrap', ref, Date.now() + 1000, async (r) => ({
        ...admitted(r),
        isDemo: false,
      })),
    ).rejects.toThrow();
    const event = (receiptId: string, at: number, parentReceiptId: string | null = null) => ({
      parentReceiptId,
      receiptId,
      actorId: workload,
      policySha256: p.fingerprint,
      at,
    });
    const exception = {
      verified: true,
      reasonSha256: 'a'.repeat(64),
      actionClass: 'assessment_dispatch_key_custody',
      ownerRequest: event(tenant, 1),
      founderApproval: event(revision, 2, tenant),
      operatorActivation: event(workload, 3, revision),
    };
    const port = async (r: LocalKeyAdmissionRequest) => ({
      ...admitted(r),
      isDemo: false,
      exception,
    });
    await expect(p.require(caller, 'wrap', ref, Date.now() + 1000, port)).resolves.toBeUndefined();
    exception.founderApproval.parentReceiptId = workload;
    await expect(p.require(caller, 'wrap', ref, Date.now() + 1000, port)).rejects.toThrow();
    exception.founderApproval.parentReceiptId = tenant;
    exception.operatorActivation.policySha256 = 'b'.repeat(64);
    await expect(p.require(caller, 'wrap', ref, Date.now() + 1000, port)).rejects.toThrow();
    exception.operatorActivation.policySha256 = p.fingerprint;
    exception.ownerRequest.at = 4;
    await expect(p.require(caller, 'wrap', ref, Date.now() + 1000, port)).rejects.toThrow();
  });
  it('bounds an unavailable verifier and does not accept a late approval', async () => {
    const p = new LocalKeyPolicy(input);
    await expect(
      p.require(caller, 'wrap', ref, Date.now() + 10, () => new Promise(() => {})),
    ).rejects.toThrow('Private assessment dispatch was refused.');
  });
});
