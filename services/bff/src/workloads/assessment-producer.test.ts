import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { crc32c } from '@aws-crypto/crc32c';
import { AssessmentRequestSchema, type TenantId } from '@axiom/types';
import { canonicalJson } from '@axiom/ledger';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import { DispatchKeyPolicy } from './dispatch-key-policy.js';
import {
  composeAssessmentProducer,
  loadAssessmentProducer,
  AssessmentQuestionnaireRefused,
  AssessmentContextRefused,
} from './assessment-producer.js';
import type { DispatchAwsKmsPort, DispatchGcpKmsPort } from './dispatch-key-wrappers.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const T = 'aaaaaaaa-1111-4111-8111-111111111111',
  A = 'bbbbbbbb-2222-4222-8222-222222222222',
  W = 'cccccccc-3333-4333-8333-333333333333',
  E = 'dddddddd-4444-4444-8444-444444444444',
  J = 'eeeeeeee-5555-4555-8555-555555555555',
  R = 'ffffffff-6666-4666-8666-666666666666';
const ref = 'arn:aws:kms:ap-south-1:123456789012:key/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const config = {
  schemaVersion: 1,
  tenants: [
    {
      tenantId: T,
      workloadId: W,
      trustDomain: 'local.axiomproof.test',
      keys: { provider: 'aws', primary: ref, retiring: [] },
    },
  ],
};
let fake: FakeDb,
  human: FakeDb,
  enqueue: ReturnType<typeof vi.fn<(args: Record<string, unknown>) => unknown>>,
  recovery: ReturnType<typeof vi.fn<(args: Record<string, unknown>) => unknown>>,
  send: ReturnType<typeof vi.fn>;
function parsed(value: unknown = { operationKey: J, engagementId: E }) {
  return AssessmentRequestSchema.parse(value);
}
async function producer(value: unknown = config) {
  return composeAssessmentProducer(value, fake.client as unknown as SupabaseClient, {
    awsKms: { send } as DispatchAwsKmsPort,
    writer: () => human.client as unknown as SupabaseClient,
  });
}
beforeEach(() => {
  const policy = new DispatchKeyPolicy(
    'aws',
    new Map([[T as TenantId, { primary: ref, retiring: [] }]]),
  );
  fake = createFakeDb({
    assessment_dispatch_key_policies: [
      { tenant_id: T, revision: 1, fingerprint: policy.fingerprint(T as TenantId) },
    ],
    workload_identities: [
      {
        id: W,
        tenant_id: T,
        agent_name: 'parikshan',
        spiffe_id: 'spiffe://local.axiomproof.test/agent/parikshan',
        status: 'active',
      },
    ],
    engagements: [
      { id: E, tenant_id: T, estate_id: null, library_version: 'pinned', status: 'intake' },
    ],
    control_libraries: [{ version: 'pinned', status: 'published', control_count: 1 }],
    controls: [
      {
        id: 'A',
        library_version: 'pinned',
        assessment_questions: [
          { id: 'Q1', type: 'boolean' },
          { id: 'Q2', type: 'text' },
        ],
      },
    ],
  });
  human = createFakeDb();
  enqueue = vi.fn((_args: Record<string, unknown>) => ({
    job_id: J,
    run_id: R,
    expires_at: '2026-10-05T20:00:00Z',
  }));
  recovery = vi.fn((_args: Record<string, unknown>) => null);
  human.onRpc('recover_assessment_dispatch', recovery);
  human.onRpc('enqueue_assessment_dispatch', enqueue);
  send = vi.fn(async (command) => {
    expect(command.constructor.name).toBe('EncryptCommand');
    expect(command.input.KeyId).toBe(ref);
    expect(command.input.EncryptionContext.axiomDispatchPurpose).toBe(
      'axiom.assessment.dispatch.dek.v1',
    );
    return {
      KeyId: ref,
      EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
      CiphertextBlob: new Uint8Array([1, 2, 3, 4]),
    };
  });
});
describe('trusted human assessment producer composition', () => {
  it('constructs a real production wrapping adapter and only exposes the request facade', async () => {
    const p = await producer();
    expect(Object.keys(p)).toEqual(['request']);
    const receipt = await p.request(T.toUpperCase(), A.toUpperCase(), parsed());
    expect(receipt.run_id).toBe(R);
    expect(send).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const args = enqueue.mock.calls[0]![0];
    expect(args).toMatchObject({
      p_job_id: J,
      p_tenant_id: T,
      p_actor_id: A,
      p_workload_id: W,
      p_estate_id: null,
      p_engagement_id: E,
      p_correlation_id: J,
      p_policy_revision: 1,
      p_key_ref: ref,
    });
    const wire = canonicalJson({
      tenant_id: T,
      engagement_id: E,
      library_version: 'pinned',
      answers: {},
      sdf_self_attested: null,
      processes_children: null,
      processes_health: null,
    });
    expect(args.p_input_hash).toBe(createHash('sha256').update(wire).digest('hex'));
    expect(args).not.toHaveProperty('answers');
    expect(JSON.stringify(args)).not.toContain('processes_children');
    expect(recovery).toHaveBeenCalledTimes(2); // preflight and adapter defense-in-depth
  });
  it('composes the GCP production wrapping branch without exposing or calling decrypt', async () => {
    const c = structuredClone(config);
    const name = 'projects/axiom-test/locations/asia-south1/keyRings/dispatch/cryptoKeys/tenant-a';
    c.tenants[0]!.keys = { provider: 'gcp', primary: name, retiring: [] };
    fake.rows('assessment_dispatch_key_policies')[0]!.fingerprint = new DispatchKeyPolicy(
      'gcp',
      new Map([[T as TenantId, { primary: name, retiring: [] }]]),
    ).fingerprint(T as TenantId);
    const ciphertext = new Uint8Array([2, 3, 4, 5]);
    const encrypt = vi.fn<DispatchGcpKmsPort['encrypt']>(async (args) => {
      expect(args.name).toBe(name);
      return [
        {
          name: name + '/cryptoKeyVersions/2',
          ciphertext,
          ciphertextCrc32c: { value: crc32c(ciphertext) },
          verifiedPlaintextCrc32c: true,
          verifiedAdditionalAuthenticatedDataCrc32c: true,
        },
      ];
    });
    const decrypt = vi.fn<DispatchGcpKmsPort['decrypt']>();
    const p = await composeAssessmentProducer(c, fake.client as unknown as SupabaseClient, {
      gcpKms: { encrypt, decrypt },
      writer: () => human.client as unknown as SupabaseClient,
    });
    await expect(p.request(T, A, parsed())).resolves.toMatchObject({ job_id: J });
    expect(encrypt).toHaveBeenCalledTimes(1);
    expect(decrypt).not.toHaveBeenCalled();
    expect(enqueue.mock.calls[0]![0]).toMatchObject({ p_key_ref: name, p_policy_revision: 1 });
  });
  it('recovers an expired/finalized original request before current-policy/KMS/source availability checks', async () => {
    const p = await producer();
    const original = { job_id: J, run_id: R, expires_at: '2020-01-01T00:00:00Z' };
    recovery.mockReturnValue(original);
    fake.rows('engagements')[0]!.status = 'review';
    fake.seed('findings', { id: R, tenant_id: T, engagement_id: E });
    fake.rows('control_libraries').splice(0);
    fake.rows('assessment_dispatch_key_policies').splice(0);
    send.mockRejectedValue(new Error('KMS unavailable'));
    expect(await p.request(T, A, parsed())).toEqual(original);
    expect(send).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
  it.each([
    { answers: { foreign: { Q1: true } } },
    { answers: { A: { unknown: true } } },
    { answers: { A: { Q2: false } } },
  ])(
    'rejects answers outside known pinned Boolean questions before provider/write',
    async (extra) => {
      const p = await producer();
      await expect(
        p.request(T, A, parsed({ operationKey: J, engagementId: E, ...extra })),
      ).rejects.toBeInstanceOf(AssessmentQuestionnaireRefused);
      expect(send).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    },
  );
  it('preserves explicit Boolean/null caller facts in the hashed input without applying defaults', async () => {
    const p = await producer();
    await p.request(
      T,
      A,
      parsed({
        operationKey: J,
        engagementId: E,
        answers: { A: { Q1: null } },
        applicability: { sdfSelfAttested: false, processesChildren: true },
      }),
    );
    const wire = canonicalJson({
      tenant_id: T,
      engagement_id: E,
      library_version: 'pinned',
      answers: { A: { Q1: null } },
      sdf_self_attested: false,
      processes_children: true,
      processes_health: null,
    });
    expect(enqueue.mock.calls[0]![0].p_input_hash).toBe(
      createHash('sha256').update(wire).digest('hex'),
    );
  });
  it.each(['control_count', 'status', 'controls', 'duplicateQID', 'duplicateControl'])(
    'refuses incomplete/corrupt/unpublished pinned source %s',
    async (field) => {
      const p = await producer();
      if (field === 'control_count') fake.rows('control_libraries')[0]!.control_count = 2;
      if (field === 'status') fake.rows('control_libraries')[0]!.status = 'draft';
      if (field === 'controls') fake.rows('controls').splice(0);
      if (field === 'duplicateQID')
        fake.rows('controls')[0]!.assessment_questions = [
          { id: 'Q1', type: 'boolean' },
          { id: 'Q1', type: 'boolean' },
        ];
      if (field === 'duplicateControl') {
        fake.rows('control_libraries')[0]!.control_count = 2;
        fake.seed('controls', structuredClone(fake.rows('controls')[0]!));
      }
      await expect(p.request(T, A, parsed())).rejects.toThrow();
      expect(send).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    },
  );
  it('uses a historical deprecated library instead of the current bundled version', async () => {
    const p = await producer();
    fake.rows('control_libraries')[0]!.status = 'deprecated';
    await expect(p.request(T, A, parsed())).resolves.toMatchObject({ job_id: J });
  });
  it.each(['cancelled', 'review', 'completed'])(
    'refuses a new request over engagement status %s',
    async (status) => {
      const p = await producer();
      fake.rows('engagements')[0]!.status = status;
      await expect(p.request(T, A, parsed())).rejects.toBeInstanceOf(AssessmentContextRefused);
      expect(send).not.toHaveBeenCalled();
    },
  );
  it('refuses a new job over saved findings', async () => {
    const p = await producer();
    fake.seed('findings', { id: R, tenant_id: T, engagement_id: E });
    await expect(p.request(T, A, parsed())).rejects.toBeInstanceOf(AssessmentContextRefused);
    expect(send).not.toHaveBeenCalled();
  });
  it('refuses a foreign engagement without KMS or human RPC', async () => {
    const p = await producer();
    fake.rows('engagements')[0]!.tenant_id = W;
    await expect(p.request(T, A, parsed())).rejects.toBeInstanceOf(AssessmentContextRefused);
    expect(recovery).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it('withholds producer capability for an unconfigured tenant', async () => {
    const p = await producer();
    await expect(p.request(W, A, parsed())).rejects.toThrow();
    expect(recovery).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it.each(['fingerprint', 'registration', 'duplicateTenant', 'sharedTenantKey', 'keyPurpose'])(
    'refuses invalid trusted startup configuration %s',
    async (field) => {
      const c = structuredClone(config);
      if (field === 'fingerprint')
        fake.rows('assessment_dispatch_key_policies')[0]!.fingerprint = 'f'.repeat(64);
      if (field === 'registration') fake.rows('workload_identities')[0]!.status = 'disabled';
      if (field === 'duplicateTenant') c.tenants.push(c.tenants[0]!);
      if (field === 'sharedTenantKey') c.tenants.push({ ...c.tenants[0]!, tenantId: A });
      if (field === 'keyPurpose') c.tenants[0]!.keys.primary = 'not-a-dedicated-key';
      await expect(producer(c)).rejects.toThrow('configuration refused');
      expect(recovery).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    },
  );
  it.each(['engagements', 'control_libraries', 'controls', 'findings'])(
    'fails closed on %s read failure',
    async (table) => {
      const p = await producer();
      fake.failNext(table);
      await expect(p.request(T, A, parsed())).rejects.toThrow();
      expect(send).not.toHaveBeenCalled();
    },
  );
  it('withholds enqueue when current actor/kill recovery check refuses even a new job', async () => {
    const p = await producer();
    recovery.mockImplementation(() => {
      throw new Error('context forbidden');
    });
    await expect(p.request(T, A, parsed())).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('is disabled when no trusted file is configured and rejects unprotected/missing filenames', async () => {
    expect(await loadAssessmentProducer(undefined)).toBeUndefined();
    await expect(loadAssessmentProducer('/nonexistent/assessment-config.json')).rejects.toThrow(
      'startup refused',
    );
    await expect(loadAssessmentProducer('relative-config.json')).rejects.toThrow('startup refused');
  });
});
