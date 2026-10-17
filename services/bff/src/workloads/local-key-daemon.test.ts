import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { SignJWT } from 'jose';
import { encodeLocalCustodyPolicy } from '@axiom/types';
import { LocalKeyPolicy } from './local-key-policy.js';
import { dispatchWrappingContext } from './dispatch-payload.js';
import {
  acceptedRunResolver,
  roleRoutedKeyAuthority,
  runGenerations,
  verifierCredential,
  verifierReadRpc,
} from './local-key-daemon.js';

const tenant = '11111111-1111-4111-8111-111111111111',
  policyId = '22222222-2222-4222-8222-222222222222',
  operator = '33333333-3333-4333-8333-333333333333',
  workload = '44444444-4444-4444-8444-444444444444',
  job = '55555555-5555-4555-8555-555555555555',
  run = '66666666-6666-4666-8666-666666666666';
const ref = `axiom-local-dispatch://${tenant}/${policyId}/versions/1`;
const keyPolicySha256 = new LocalKeyPolicy({
  tenantId: tenant,
  revision: policyId,
  mode: 'operator_managed',
  validity: { kind: 'until_revoked', reviewDueAt: 1 },
  primary: ref,
  readable: [ref],
}).fingerprint;
const text = encodeLocalCustodyPolicy({
  version: 1,
  policyId,
  tenantId: tenant,
  mode: 'operator_managed',
  nominatedOperatorId: operator,
  targetWorkloadId: workload,
  servicePrincipals: {
    producer: 'spiffe://local.axiom/service/assessment-dispatch-producer',
    controller: 'spiffe://local.axiom/controller/assessment',
  },
  validity: { kind: 'until_revoked', reviewDueAt: 1 },
  actionClass: 'assessment_dispatch_key_custody',
  keyPolicy: { primary: ref, readable: [ref] },
  keyPolicySha256,
  deploymentBindingSha256: 'b'.repeat(64),
  reason: 'Local custody qualification',
  acceptedLimitations: ['hardware_backing_unverified'],
  statutoryComplianceAsserted: false,
  ownershipVerified: false,
});
const policySha256 = createHash('sha256').update(text).digest('hex');
const context = Buffer.from(
  dispatchWrappingContext({
    tenantId: tenant,
    jobId: job,
    actorId: operator,
    workloadId: workload,
    estateId: null,
    engagementId: policyId,
    correlationId: operator,
    inputHash: 'a'.repeat(64),
  }),
);
const controller = {
  tenantId: tenant,
  workloadId: workload,
  role: 'controller' as const,
  servicePrincipal: 'spiffe://local.axiom/controller/assessment',
};
const expectation = {
  tenantId: tenant,
  workloadId: workload,
  principalKind: 'controller' as const,
  servicePrincipal: controller.servicePrincipal,
};
const secret = new TextEncoder().encode('x'.repeat(40));
async function token(claims: Record<string, unknown>, ttl = 600) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...claims, iat: now, exp: now + ttl })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .sign(secret);
}
async function credential(overrides: Record<string, unknown> = {}, ttl?: number) {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      apiKey: await token({ role: 'anon' }),
      accessToken: await token(
        {
          role: 'axiom_local_custody_verifier',
          sub: '77777777-7777-4777-8777-777777777777',
          tenant_id: tenant,
          workload_id: workload,
          principal_kind: 'controller',
          service_principal: controller.servicePrincipal,
          configuration_sha256: 'b'.repeat(64),
          ...overrides,
        },
        ttl,
      ),
    }),
  );
}
function accepted(args: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    data: {
      kind: 'accepted_job',
      tenantId: args.p_tenant_id,
      policyId: args.p_policy_id,
      grant: { jobId: job, runId: run },
      ...over,
    },
    error: null,
  };
}

describe('verifier credentials', () => {
  it('accepts only the expected principal and a live, short credential', async () => {
    expect(verifierCredential(await credential(), expectation).accessToken).toBeTruthy();
    for (const bad of [
      { principal_kind: 'producer' },
      { tenant_id: job },
      { workload_id: job },
      { service_principal: 'spiffe://local.axiom/other' },
      { role: 'axiom_assessment_controller' },
    ]) {
      const bytes = await credential(bad);
      expect(() => verifierCredential(bytes, expectation)).toThrow();
    }
    const long = await credential({}, 7200);
    expect(() => verifierCredential(long, expectation)).toThrow();
    const expired = await credential({}, -10);
    expect(() => verifierCredential(expired, expectation)).toThrow();
  });

  it('re-reads the credential per call, erases it, and refuses other RPCs', async () => {
    const files: Buffer[] = [];
    const load = vi.fn(async () => {
      const b = await credential();
      files.push(b);
      return b;
    });
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify({ ok: true })));
    try {
      const read = verifierReadRpc(
        'https://db.local.invalid',
        '/creds/controller',
        expectation,
        load,
      );
      await read('read_local_custody_admission', { p: 1 }, AbortSignal.timeout(1000));
      await read('read_local_custody_admission', { p: 1 }, AbortSignal.timeout(1000));
      expect(load).toHaveBeenCalledTimes(2);
      expect(files.every((b) => b.every((x) => x === 0))).toBe(true);
      const [url, init] = fetcher.mock.calls[0]!;
      expect(String(url)).toBe('https://db.local.invalid/rest/v1/rpc/read_local_custody_admission');
      expect(new Headers(init?.headers).get('authorization')).toMatch(/^Bearer ey/);
      expect(init?.redirect).toBe('error');
      await expect(
        read('claim_local_assessment_dispatch', {}, AbortSignal.timeout(1000)),
      ).rejects.toThrow();
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      fetcher.mockRestore();
    }
  });
});

describe('accepted run resolution', () => {
  const policy = { tenantId: tenant, policyId };
  it('derives the run from SQL for the authenticated context and exact key reference', async () => {
    const read = vi.fn(async (_n: string, args: Record<string, unknown>) => accepted(args));
    const resolve = acceptedRunResolver(policy, read);
    await expect(resolve(controller, context, Date.now() + 2000, ref)).resolves.toBe(run);
    expect(read.mock.calls[0]![1]).toMatchObject({
      p_tenant_id: tenant,
      p_policy_id: policyId,
      p_operation: 'unwrap',
      p_key_ref: ref,
      p_context_text: context.toString('utf8'),
    });
  });
  it('refuses a non-controller, a foreign tenant, a bad reference or a mismatched SQL row', async () => {
    const cases: [Parameters<ReturnType<typeof acceptedRunResolver>>, Record<string, unknown>][] = [
      [[{ ...controller, role: 'producer' }, context, Date.now() + 2000, ref], {}],
      [[{ ...controller, tenantId: job }, context, Date.now() + 2000, ref], {}],
      [[controller, context, Date.now() + 2000, 'axiom-local-dispatch://nope'], {}],
      [[controller, context, Date.now() + 60_000, ref], {}],
      [[controller, context, Date.now() + 2000, ref], { kind: 'new_authority' }],
      [[controller, context, Date.now() + 2000, ref], { grant: { jobId: run, runId: run } }],
      [[controller, context, Date.now() + 2000, ref], { policyId: job }],
      [[controller, context, Date.now() + 2000, ref], { grant: null }],
    ];
    for (const [args, over] of cases) {
      const read = vi.fn(async (_n: string, a: Record<string, unknown>) => accepted(a, over));
      await expect(acceptedRunResolver(policy, read)(...args)).rejects.toThrow();
    }
    const failing = vi.fn(async () => ({ data: null, error: { message: 'refused' } }));
    await expect(
      acceptedRunResolver(policy, failing)(controller, context, Date.now() + 2000, ref),
    ).rejects.toThrow();
  });
});

describe('role-routed authority', () => {
  it('sends each role only to its own verifier and refuses an unconfigured role', async () => {
    const producerRead = vi.fn(async () => ({ data: null, error: { message: 'no' } }));
    const authority = roleRoutedKeyAuthority(text, policySha256, { producer: producerRead });
    expect(authority.value.primary).toBe(ref);
    await expect(
      authority.require(
        { ...controller, originalRunId: run },
        'unwrap',
        ref,
        Date.now() + 2000,
        undefined,
        context,
      ),
    ).rejects.toThrow();
    expect(producerRead).not.toHaveBeenCalled();
    await expect(
      authority.require(
        {
          ...controller,
          role: 'producer',
          servicePrincipal: 'spiffe://local.axiom/service/assessment-dispatch-producer',
        },
        'wrap',
        ref,
        Date.now() + 2000,
        undefined,
        context,
      ),
    ).rejects.toThrow();
    expect(producerRead).toHaveBeenCalledOnce();
  });
  it('refuses a policy text that does not match its digest', () => {
    expect(() => roleRoutedKeyAuthority(text, 'f'.repeat(64), {})).toThrow();
  });
});

describe('generation loop', () => {
  it('restarts after idle windows, pauses after fast failures, and stops', async () => {
    const stop = new AbortController();
    const starts: number[] = [];
    const ends: number[] = [];
    const serve = vi.fn(async (deadline: number) => {
      starts.push(Date.now());
      try {
        if (starts.length === 1) return;
        if (starts.length === 2) {
          await new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())));
          throw new Error('idle');
        }
        if (starts.length === 3) throw new Error('fast');
        stop.abort();
      } finally {
        ends.push(Date.now());
      }
    });
    const refused = vi.fn();
    await runGenerations(serve, stop.signal, { windowMs: 60, pauseMs: 200, onRefused: refused });
    expect(starts).toHaveLength(4);
    expect(refused).toHaveBeenCalledTimes(2);
    // Idle window: immediate restart. Fast failure: a pause before the next.
    expect(starts[2]! - ends[1]!).toBeLessThan(100);
    expect(starts[3]! - ends[2]!).toBeGreaterThanOrEqual(190);
  });
});
