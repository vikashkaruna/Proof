import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { TenantId } from '@axiom/types';
import { DispatchKeyPolicy } from './dispatch-key-policy.js';
import { DispatchPolicyStore } from './dispatch-policy-store.js';
import { AssessmentDispatch } from './assessment-dispatch.js';
const id = (n: number) => `57570000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenant = id(1) as TenantId;
const key = (n: number) => `arn:aws:kms:ap-south-1:123456789012:key/${id(n)}`;
const policy = new DispatchKeyPolicy(
  'aws',
  new Map([[tenant, { primary: key(4), retiring: [key(5)] }]]),
);
const receipt = {
  tenantId: tenant,
  revision: 1,
  fingerprint: policy.fingerprint(tenant),
  receipt: '12',
};
function fixture(reply: unknown, status = 200) {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify(reply), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  const db = createClient('https://db.test.invalid', 'synthetic-key', {
    global: { fetch: fetcher },
    auth: { persistSession: false },
  });
  return { db, fetcher, store: new DispatchPolicyStore(db) };
}
describe('persisted dispatch policy', () => {
  it('publishes only reviewed backend policy and validates its durable fingerprint', async () => {
    const f = fixture(receipt);
    expect(await f.store.publish(policy, tenant, id(2), id(3), 0)).toEqual(receipt);
    expect(JSON.parse(String(f.fetcher.mock.calls[0]![1]!.body))).toEqual({
      p_tenant_id: tenant,
      p_actor_id: id(2),
      p_correlation_id: id(3),
      p_expected_revision: 0,
      p_provider: 'aws',
      p_primary_ref: key(4),
      p_readable_refs: [key(4), key(5)],
    });
  });
  it.each([
    { ...receipt, tenantId: id(9) },
    { ...receipt, fingerprint: 'f'.repeat(64) },
    { ...receipt, revision: 3 },
    { ...receipt, receipt: '0' },
    { ...receipt, private: 'private-marker' },
    { error: 'private-marker' },
  ])('rejects mismatched or private publication results', async (value) => {
    await expect(fixture(value).store.publish(policy, tenant, id(2), id(3), 0)).rejects.toThrow(
      'Private assessment dispatch was refused.',
    );
  });
  it('sanitizes provider errors', async () => {
    await expect(
      fixture({ message: 'private-marker' }, 500).store.publish(policy, tenant, id(2), id(3), 0),
    ).rejects.toThrow('Private assessment dispatch was refused.');
  });
  it('reconstructs the revision only for matching trusted local configuration', async () => {
    const f = fixture({ tenant_id: tenant, revision: 3, fingerprint: policy.fingerprint(tenant) });
    expect(await f.store.currentRevision(policy, tenant)).toBe(3);
    expect(String(f.fetcher.mock.calls[0]![0])).toContain('assessment_dispatch_key_policies');
    expect(f.fetcher.mock.calls[0]![1]!.method).toBe('GET');
  });
  it.each([
    null,
    { tenant_id: id(9), revision: 3, fingerprint: policy.fingerprint(tenant) },
    { tenant_id: tenant, revision: 0, fingerprint: policy.fingerprint(tenant) },
    { tenant_id: tenant, revision: 3, fingerprint: 'f'.repeat(64) },
    {
      tenant_id: tenant,
      revision: 3,
      fingerprint: policy.fingerprint(tenant),
      private: 'private-marker',
    },
  ])('refuses missing, foreign or mismatched persisted configuration', async (value) => {
    await expect(fixture(value).store.currentRevision(policy, tenant)).rejects.toThrow(
      'Private assessment dispatch was refused.',
    );
  });
  it('recovers an idempotent publication receipt', async () => {
    expect(await fixture(receipt).store.publish(policy, tenant, id(2), id(3), 1)).toEqual(receipt);
  });
  it('binds fingerprint to tenant, primary and the complete reader set', () => {
    const reordered = new DispatchKeyPolicy(
      'aws',
      new Map([[tenant, { primary: key(4), retiring: [key(6), key(5)] }]]),
    );
    expect(reordered.fingerprint(tenant)).toBe(
      policy.withReadable(tenant, key(6)).fingerprint(tenant),
    );
    expect(reordered.fingerprint(tenant)).not.toBe(policy.fingerprint(tenant));
    expect(policy.withPrimary(tenant, key(5)).fingerprint(tenant)).not.toBe(
      policy.fingerprint(tenant),
    );
    const other = id(9) as TenantId;
    expect(
      new DispatchKeyPolicy(
        'aws',
        new Map([[other, { primary: key(4), retiring: [key(5)] }]]),
      ).fingerprint(other),
    ).not.toBe(policy.fingerprint(tenant));
  });
  it.each(['\n', '\r', '\u2028'])('refuses a line-ending key reference', (suffix) => {
    expect(
      () =>
        new DispatchKeyPolicy(
          'aws',
          new Map([[tenant, { primary: key(4) + suffix, retiring: [] }]]),
        ),
    ).toThrow();
  });
  it.each([0, -1, 1.5, 2147483648])('rejects invalid configured policy revision %s', (revision) => {
    const f = fixture({});
    expect(
      () =>
        new AssessmentDispatch(
          f.db,
          { wrap: vi.fn(), unwrap: vi.fn() },
          new Map([[tenant, revision]]),
        ),
    ).toThrow('Private assessment dispatch was refused.');
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('captures revisions and computes the fingerprint from the actual local wrapper before claim', async () => {
    const f = fixture({ error: 'policy_stale' });
    const revisions = new Map([[tenant, 1]]);
    const wrapper = {
      wrap: vi.fn(),
      unwrap: vi.fn(),
      policyFingerprint: vi.fn(() => policy.fingerprint(tenant)),
    };
    const dispatch = new AssessmentDispatch(f.db, wrapper, revisions);
    revisions.set(tenant, 2);
    await expect(dispatch.claim(tenant, id(7))).rejects.toThrow();
    expect(JSON.parse(String(f.fetcher.mock.calls[0]![1]!.body))).toEqual({
      p_tenant_id: tenant,
      p_job_id: id(7),
      p_policy_revision: 1,
      p_policy_fingerprint: policy.fingerprint(tenant),
    });
    expect(wrapper.unwrap).not.toHaveBeenCalled();
  });
  it('refuses a production provider without configured revision before KMS or database IO', async () => {
    const f = fixture({});
    const wrapper = {
      wrap: vi.fn(),
      unwrap: vi.fn(),
      policyFingerprint: () => policy.fingerprint(tenant),
    };
    const dispatch = new AssessmentDispatch(f.db, wrapper);
    const input = JSON.stringify({
      tenant_id: tenant,
      engagement_id: id(8),
      library_version: 'synthetic',
    });
    await expect(
      dispatch.enqueue(
        {
          tenantId: tenant,
          jobId: id(7),
          actorId: id(2),
          workloadId: id(3),
          estateId: null,
          engagementId: id(8),
          correlationId: id(6),
          inputHash: createHash('sha256').update(input).digest('hex'),
        },
        input,
      ),
    ).rejects.toThrow();
    await expect(dispatch.claim(tenant, id(7))).rejects.toThrow();
    expect(wrapper.wrap).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('cannot attach a claimed policy revision to a provider without a fingerprint', async () => {
    const f = fixture({});
    const dispatch = new AssessmentDispatch(
      f.db,
      { wrap: vi.fn(), unwrap: vi.fn() },
      new Map([[tenant, 1]]),
    );
    await expect(dispatch.claim(tenant, id(7))).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
