import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeLocalCustodyPolicy } from '@axiom/types';
import { LocalKeyPolicy } from './workloads/local-key-policy.js';
import { prepareLocalKeyService } from './local-key-service.js';

const x509 = vi.hoisted(() => vi.fn());
vi.mock('./workloads/local-x509-preflight.js', () => ({ requireLocalX509Material: x509 }));
beforeEach(() => {
  x509.mockReset();
  x509.mockResolvedValue(undefined);
});

const tenant = '11111111-1111-4111-8111-111111111111',
  policyId = '22222222-2222-4222-8222-222222222222',
  operator = '33333333-3333-4333-8333-333333333333',
  workload = '44444444-4444-4444-8444-444444444444';
const ref = `axiom-local-dispatch://${tenant}/${policyId}/versions/1`;
const producer = 'spiffe://local.axiom/service/assessment-dispatch-producer',
  controller = 'spiffe://local.axiom/controller/assessment';
const text = encodeLocalCustodyPolicy({
  version: 1,
  policyId,
  tenantId: tenant,
  mode: 'operator_managed',
  nominatedOperatorId: operator,
  targetWorkloadId: workload,
  servicePrincipals: { producer, controller },
  validity: { kind: 'until_revoked', reviewDueAt: 1 },
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
});
const policySha256 = createHash('sha256').update(text).digest('hex');

let root = '';
async function config(over: Record<string, unknown> = {}) {
  const file = join(root, `config-${Math.random().toString(16).slice(2)}.json`);
  await writeFile(
    file,
    JSON.stringify({
      policyFile: join(root, 'policy.json'),
      policySha256,
      keyDirectory: join(root, 'keys'),
      endpoint: { path: join(root, 'sock', 'keys.sock') },
      supabaseUrl: 'http://127.0.0.1:54321',
      credentials: { controller: join(root, 'controller.json') },
      workload: {
        socketPath: '/run/spire/agent.sock',
        spiffeId: 'spiffe://local.axiom/service/local-key-service',
        issuerNodeId: 'spiffe://local.axiom/spire/agent/join_token/local',
      },
      peers: [
        { spiffeId: producer, role: 'producer' },
        { spiffeId: controller, role: 'controller' },
      ],
      ...over,
    }),
    { mode: 0o600 },
  );
  return file;
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'axiom-local-key-')));
  await writeFile(join(root, 'policy.json'), text, { mode: 0o600 });
  await mkdir(join(root, 'keys'), { mode: 0o700 });
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('local key service entrypoint', () => {
  it('passes --check for a policy-bound configuration', async () => {
    const prepared = await prepareLocalKeyService(['--check', await config()]);
    expect(prepared.mode).toBe('--check');
  });
  it('refuses --check when live own X509 material is invalid and creates no key', async () => {
    x509.mockRejectedValueOnce(new Error('material refused'));
    await expect(prepareLocalKeyService(['--check', await config()])).rejects.toThrow(
      'startup refused',
    );
    expect(x509).toHaveBeenCalledWith(
      expect.objectContaining({ spiffeId: 'spiffe://local.axiom/service/local-key-service' }),
      'server',
    );
    expect(await readdir(join(root, 'keys'))).toEqual([]);
  });
  it('refuses a policy digest mismatch, unknown mode, or a peer outside the policy', async () => {
    await expect(
      prepareLocalKeyService(['--check', await config({ policySha256: 'f'.repeat(64) })]),
    ).rejects.toThrow('startup refused');
    await expect(prepareLocalKeyService(['--rotate', await config()])).rejects.toThrow();
    await expect(
      prepareLocalKeyService([
        '--check',
        await config({ peers: [{ spiffeId: 'spiffe://local.axiom/other', role: 'producer' }] }),
      ]),
    ).rejects.toThrow();
    await expect(
      prepareLocalKeyService([
        '--check',
        await config({ peers: [{ spiffeId: producer, role: 'controller' }] }),
      ]),
    ).rejects.toThrow();
  });
  it('refuses provisioning without the operator verifier, creating no key', async () => {
    const prepared = await prepareLocalKeyService(['--provision', await config()]);
    await expect(prepared.provision()).rejects.toThrow();
    expect(await readdir(join(root, 'keys'))).toEqual([]);
  });
  it('refuses to serve with neither producer nor controller credentials', async () => {
    const prepared = await prepareLocalKeyService([
      '--serve',
      await config({ credentials: { operator: join(root, 'operator.json') } }),
    ]);
    expect(() => prepared.serve(new AbortController().signal)).toThrow();
  });
});

it('keeps the checked-in example configuration valid', async () => {
  const { readFile } = await import('node:fs/promises');
  const { localKeyServiceConfiguration } = await import('./local-key-service.js');
  const example = JSON.parse(
    await readFile(
      new URL('../../../infra/workload/local-key-service.example.json', import.meta.url),
      'utf8',
    ),
  );
  expect(localKeyServiceConfiguration.safeParse(example).success).toBe(true);
});
