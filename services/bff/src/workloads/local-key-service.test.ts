import { createHash } from 'node:crypto';
import { encodeLocalCustodyPolicy } from '@axiom/types';
import { createLocalCustodyKeyAuthority, type LocalCustodyReadRpc } from './local-key-admission.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, chmod, rm, readdir, stat, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalKeyPolicy, type LocalKeyAdmissionRequest } from './local-key-policy.js';
import { LocalKeyService } from './local-key-service.js';
import { dispatchWrappingContext } from './dispatch-payload.js';
const tenant = '11111111-1111-4111-8111-111111111111',
  revision = '22222222-2222-4222-8222-222222222222';
const workload = '33333333-3333-4333-8333-333333333333';
const ref = `axiom-local-dispatch://${tenant}/${revision}/versions/1`,
  next = ref.replace(/versions\/1$/, 'versions/2');
const policy = new LocalKeyPolicy({
  tenantId: tenant,
  revision,
  mode: 'local_demo',
  validity: { kind: 'fixed_expiry', expiresAt: Date.now() + 600000 },
  primary: ref,
  readable: [ref, next],
});
const caller = (role: 'operator' | 'producer' | 'controller') => ({
  tenantId: tenant,
  workloadId: workload,
  role,
});
const context = dispatchWrappingContext({
  tenantId: tenant,
  jobId: revision,
  actorId: workload,
  workloadId: workload,
  estateId: null,
  engagementId: revision,
  correlationId: workload,
  inputHash: 'a'.repeat(64),
});
function admission(r: LocalKeyAdmissionRequest) {
  const { deadline: _d, ...binding } = r;
  return {
    ...binding,
    verified: true,
    expiresAt: Date.now() + 10000,
    revoked: false,
    isDemo: true,
    operatorActivated: true,
    admissionReceiptId: revision,
    exception: null,
  };
}
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(await realpath(tmpdir()), 'axiom-local-key-'));
  await chmod(directory, 0o700);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
describe('persistent local key custody', () => {
  it('persists tenant/version-separated keys and roundtrips across service restart, with immutable old versions', async () => {
    const service = new LocalKeyService(directory, policy, async (r) => admission(r));
    await service.provision(caller('operator'), ref);
    await service.provision(caller('operator'), next);
    await expect(service.provision(caller('operator'), ref)).rejects.toThrow();
    const files = await readdir(directory);
    expect(files).toHaveLength(2);
    for (const f of files) expect((await stat(join(directory, f))).mode & 0o777).toBe(0o600);
    const plain = Buffer.alloc(32, 7),
      wrapped = await service.wrap(caller('producer'), context, plain);
    expect(wrapped.keyRef).toBe(ref);
    expect(Buffer.from(wrapped.wrappedKey).includes(plain)).toBe(false);
    const restarted = new LocalKeyService(directory, policy, async (r) => admission(r));
    expect(await restarted.unwrap(caller('controller'), context, ref, wrapped.wrappedKey)).toEqual(
      plain,
    );
    const promoted = new LocalKeyPolicy({
      ...policy.value,
      revision: workload,
      primary: next,
      readable: [ref, next],
    });
    const rotated = new LocalKeyService(directory, promoted, async (r) => admission(r));
    expect((await rotated.wrap(caller('producer'), context, plain)).keyRef).toBe(next);
    expect(await rotated.unwrap(caller('controller'), context, ref, wrapped.wrappedKey)).toEqual(
      plain,
    );

    const altered = Buffer.from(wrapped.wrappedKey);
    altered[35] = altered[35]! ^ 1;
    await expect(restarted.unwrap(caller('controller'), context, ref, altered)).rejects.toThrow();
    const other = Buffer.from(context.toString().replace('a'.repeat(64), 'b'.repeat(64)));
    await expect(
      restarted.unwrap(caller('controller'), other, ref, wrapped.wrappedKey),
    ).rejects.toThrow();
    await expect(
      restarted.unwrap(caller('controller'), context, next, wrapped.wrappedKey),
    ).rejects.toThrow();
  });
  it('refuses before filesystem IO when no authority exists and sanitizes errors', async () => {
    const service = new LocalKeyService('/does/not/exist/secret', policy);
    await expect(service.provision(caller('operator'), ref)).rejects.toThrow(
      'Private assessment dispatch was refused.',
    );
    await expect(service.wrap(caller('controller'), context, Buffer.alloc(32))).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });
  it('rechecks after IO and never releases plaintext after revocation', async () => {
    const stable = new LocalKeyService(directory, policy, async (r) => admission(r));
    await stable.provision(caller('operator'), ref);
    const wrapped = await stable.wrap(caller('producer'), context, Buffer.alloc(32, 9));
    let n = 0;
    const revoked = new LocalKeyService(directory, policy, async (r) => ({
      ...admission(r),
      revoked: ++n > 1,
    }));
    await expect(
      revoked.unwrap(caller('controller'), context, ref, wrapped.wrappedKey),
    ).rejects.toThrow();
    expect(n).toBe(2);
  });
  it('refuses symlink directories, unsafe file modes and foreign role/tenant', async () => {
    const s = new LocalKeyService(directory, policy, async (r) => admission(r));
    await s.provision(caller('operator'), ref);
    const [f] = await readdir(directory);
    await chmod(join(directory, f!), 0o644);
    await expect(s.wrap(caller('producer'), context, Buffer.alloc(32))).rejects.toThrow();
    await expect(
      s.wrap({ ...caller('producer'), tenantId: revision }, context, Buffer.alloc(32)),
    ).rejects.toThrow();
    const linked = directory + '-link';
    await symlink(directory, linked);
    try {
      await expect(
        new LocalKeyService(linked, policy, async (r) => admission(r)).provision(
          caller('operator'),
          next,
        ),
      ).rejects.toThrow();
    } finally {
      await rm(linked);
    }
  });
});

describe('durable143 grant-aware local key authority', () => {
  const runId = '66666666-6666-4666-8666-666666666666';
  const activationId = '77777777-7777-4777-8777-777777777777';
  const durablePolicy = {
    version: 1,
    policyId: revision,
    tenantId: tenant,
    mode: 'operator_managed' as const,
    nominatedOperatorId: revision,
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
      revision,
      mode: 'operator_managed',
      validity: { kind: 'until_revoked', reviewDueAt: 1 },
      primary: ref,
      readable: [ref],
    }).fingerprint,
    deploymentBindingSha256: 'b'.repeat(64),
    reason: 'Reviewed operator-managed custody',
    acceptedLimitations: ['hardware_backing_unverified'],
    statutoryComplianceAsserted: false,
    ownershipVerified: false,
  };
  const policyText = encodeLocalCustodyPolicy(durablePolicy);
  const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const principal = (role: 'operator' | 'producer' | 'controller') => ({
    ...caller(role),
    servicePrincipal:
      role === 'operator' ? `operator:${revision}` : durablePolicy.servicePrincipals[role],
    ...(role === 'controller' ? { originalRunId: runId } : {}),
  });
  function fixture(
    change?: (row: Record<string, unknown>, call: number) => Record<string, unknown>,
  ) {
    let reads = 0;
    const expiresAt = Date.now() + 60000;
    const read: LocalCustodyReadRpc = async (_name, args) => {
      reads++;
      const operation = args.p_operation;
      const role =
        operation === 'provision' ? 'operator' : operation === 'wrap' ? 'producer' : 'controller';
      const row = {
        version: 1,
        tenantId: tenant,
        policyId: revision,
        policySha256: digest(policyText),
        keyPolicySha256: durablePolicy.keyPolicySha256,
        mode: durablePolicy.mode,
        operation,
        keyRef: ref,
        workloadId: workload,
        principalKind: role,
        servicePrincipal: principal(role).servicePrincipal,
        contextSha256: args.p_context_text === null ? null : digest(String(args.p_context_text)),
        kind: operation === 'unwrap' ? 'accepted_job' : 'new_authority',
        policyState: operation === 'unwrap' ? 'revoked' : 'active',
        currentIsDemo: false,
        reviewOverdue: true,
        reviewDueAt: 1,
        verifiedUntil: args.p_deadline_ms,
        policyText,
        grant:
          operation === 'unwrap'
            ? {
                jobId: revision,
                runId,
                contextSha256: digest(context),
                grantSha256: 'c'.repeat(64),
                originalExpiresAt: expiresAt,
                activationEventId: activationId,
                activationEpoch: 1,
              }
            : null,
      };
      return { data: change ? change(row, reads) : row, error: null };
    };
    return {
      authority: createLocalCustodyKeyAuthority(policyText, digest(policyText), read),
      reads: () => reads,
    };
  }
  async function prepared() {
    const f = fixture(),
      service = new LocalKeyService(directory, f.authority);
    await service.provision(principal('operator'), ref);
    const plain = Buffer.alloc(32, 9);
    const wrapped = await service.wrap(principal('producer'), context, plain);
    expect(f.reads()).toBe(4);
    return { plain, wrapped };
  }
  it('uses exact accepted grants after policy revocation without lying about state or extending review reminders', async () => {
    const { plain, wrapped } = await prepared();
    const f = fixture();
    expect(
      await new LocalKeyService(directory, f.authority).unwrap(
        principal('controller'),
        context,
        ref,
        wrapped.wrappedKey,
      ),
    ).toEqual(plain);
    expect(f.reads()).toBe(2);
  });
  it('refuses new provision/wrap after revocation before creating keys', async () => {
    const f = fixture((row) => ({ ...row, policyState: 'revoked' }));
    const service = new LocalKeyService(directory, f.authority);
    await expect(service.provision(principal('operator'), ref)).rejects.toThrow();
    await expect(service.wrap(principal('producer'), context, Buffer.alloc(32))).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });
  it('refuses missing or wrong peer/service/run bindings and context workload before release', async () => {
    const { wrapped } = await prepared();
    const f = fixture(),
      service = new LocalKeyService(directory, f.authority);
    for (const wrong of [
      caller('controller'),
      { ...principal('controller'), originalRunId: workload },
      { ...principal('controller'), servicePrincipal: durablePolicy.servicePrincipals.producer },
      { ...principal('controller'), workloadId: revision },
      { ...principal('controller'), tenantId: revision },
    ]) {
      await expect(service.unwrap(wrong, context, ref, wrapped.wrappedKey)).rejects.toThrow();
    }
    const contextForeignWorkload = dispatchWrappingContext({
      tenantId: tenant,
      jobId: revision,
      actorId: workload,
      workloadId: revision,
      estateId: null,
      engagementId: revision,
      correlationId: workload,
      inputHash: 'a'.repeat(64),
    });
    const before = f.reads();
    await expect(
      service.unwrap(principal('controller'), contextForeignWorkload, ref, wrapped.wrappedKey),
    ).rejects.toThrow();
    expect(f.reads()).toBe(before);
    await expect(
      service.wrap({ ...principal('producer'), originalRunId: runId }, context, Buffer.alloc(32)),
    ).rejects.toThrow();
  });
  it.each(['grantSha256', 'activationEpoch', 'activationEventId', 'originalExpiresAt'])(
    'withholds plaintext when original %s changes between pre/post crypto checks',
    async (field) => {
      const { wrapped } = await prepared();
      const f = fixture((row, call) => {
        const grant = row.grant as Record<string, unknown>;
        return call === 1
          ? row
          : {
              ...row,
              grant: {
                ...grant,
                [field]:
                  typeof grant[field] === 'number'
                    ? Number(grant[field]) + 1
                    : field === 'activationEventId'
                      ? workload
                      : 'd'.repeat(64),
              },
            };
      });
      await expect(
        new LocalKeyService(directory, f.authority).unwrap(
          principal('controller'),
          context,
          ref,
          wrapped.wrappedKey,
        ),
      ).rejects.toThrow();
      expect(f.reads()).toBe(2);
    },
  );
  it.each(['expired', 'foreign-job', 'new-authority', 'refused-after-crypto'])(
    'refuses %s authority rather than returning plaintext',
    async (variant) => {
      const { wrapped } = await prepared();
      const f = fixture((row, call) => {
        const grant = row.grant as Record<string, unknown>;
        if (variant === 'expired')
          return { ...row, grant: { ...grant, originalExpiresAt: Date.now() - 1 } };
        if (variant === 'foreign-job') return { ...row, grant: { ...grant, jobId: workload } };
        if (variant === 'new-authority')
          return { ...row, kind: 'new_authority', policyState: 'active', grant: null };
        return call === 1 ? row : { ...row, policySha256: 'f'.repeat(64) };
      });
      await expect(
        new LocalKeyService(directory, f.authority).unwrap(
          principal('controller'),
          context,
          ref,
          wrapped.wrappedKey,
        ),
      ).rejects.toThrow();
    },
  );
  it('pins a copied context and authenticated caller before the first async read', async () => {
    const { plain, wrapped } = await prepared();
    const f = fixture();
    const mutable = Buffer.from(context),
      actor = principal('controller');
    const result = new LocalKeyService(directory, f.authority).unwrap(
      actor,
      mutable,
      ref,
      wrapped.wrappedKey,
    );
    mutable.fill(0);
    actor.originalRunId = workload;
    actor.servicePrincipal = 'wrong';
    expect(await result).toEqual(plain);
    expect(f.reads()).toBe(2);
  });
  it('retains genuine active-to-revoked accepted-grant state changes during crypto', async () => {
    const { plain, wrapped } = await prepared();
    const f = fixture((row, call) => ({ ...row, policyState: call === 1 ? 'active' : 'revoked' }));
    expect(
      await new LocalKeyService(directory, f.authority).unwrap(
        principal('controller'),
        context,
        ref,
        wrapped.wrappedKey,
      ),
    ).toEqual(plain);
  });
  it('rejects incorrect policy commitments and legacy callbacks rather than implicitly upgrading authority', async () => {
    expect(() =>
      createLocalCustodyKeyAuthority(policyText, '0'.repeat(64), async () => ({
        data: null,
        error: null,
      })),
    ).toThrow();
    const f = fixture();
    await expect(
      new LocalKeyService(directory, f.authority, async (r) => admission(r)).provision(
        principal('operator'),
        ref,
      ),
    ).rejects.toThrow();
    expect(f.reads()).toBe(0);
  });
});
