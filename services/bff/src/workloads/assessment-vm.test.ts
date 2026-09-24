import { randomUUID } from 'node:crypto';
import {
  readControllerFile,
  controllerBackendCredentials,
  requireControllerBackend,
} from './controller-files.js';
import { mkdtemp, writeFile, chmod, symlink, rm, realpath } from 'node:fs/promises';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TenantId } from '@axiom/types';
import { afterEach, expect, it, vi } from 'vitest';
import { composeVmAssessmentController, vmControllerConfiguration } from './assessment-vm.js';
import * as controllerIdentity from './controller-identity.js';
import * as containerRuntime from './assessment-container.js';
import { WorkloadApiJwtTrust } from './workload-api-trust.js';
import { IssuerSyncHealth } from './issuer-sync-health.js';
import { AssessmentDispatch } from './assessment-dispatch.js';
import { AssessmentConfirmation } from './assessment-confirmation.js';
import { AssessmentChannel } from './assessment-channel.js';
import { PrivateAssessmentPayload } from './dispatch-payload.js';
import { TaskProof } from './tasks.js';
import { DispatchKeyPolicy } from './dispatch-key-policy.js';
import {
  prepareControllerService,
  controllerServiceConfiguration,
} from '../assessment-controller-service.js';
const tenant = randomUUID() as TenantId;
const foreign = randomUUID();
const key = `arn:aws:kms:ap-south-1:123456789012:key/${randomUUID()}`;
const config = {
  schemaVersion: 1,
  tenantId: tenant,
  trustDomain: 'local.axiomproof.test',
  workloadSocket: '/run/workload/api.sock',
  issuerNodeId: 'spiffe://local.axiomproof.test/spire/agent/gcp_iit/fixture-project/123',
  namespace: 'assessment-fixture',
  launcher: {
    executable: '/usr/bin/docker',
    dockerHost: 'unix:///var/run/docker.sock',
    image: `sha256:${'a'.repeat(64)}`,
    workloadApiVolume: 'axiom-workload-api-fixture',
  },
  keys: { provider: 'aws' as const, primary: key, retiring: [] as string[] },
  scheduler: {
    audience: 'https://controller.example.test',
    subject: '123456789',
    email: 'scheduler@fixture.iam.gserviceaccount.com',
  },
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function fixture() {
  const health = vi
    .spyOn(IssuerSyncHealth.prototype, 'validUntil')
    .mockImplementation(async () => Date.now() + 10000);
  vi.spyOn(containerRuntime, 'verifyAssessmentContainerRuntime').mockResolvedValue();
  const policy = new DispatchKeyPolicy(
    'aws',
    new Map([[tenant, { primary: config.keys.primary, retiring: config.keys.retiring }]]),
  );
  const row = { tenant_id: tenant, revision: 3, fingerprint: policy.fingerprint(tenant) };
  const maybeSingle = vi.fn(async () => ({ data: row, error: null }));
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    abortSignal: vi.fn(() => query),
    maybeSingle,
  };
  const rpc = vi.fn(async () => ({ data: { jobs: [] }, error: null }));
  const from = vi.fn(() => query);
  const db = { from, rpc } as unknown as SupabaseClient;
  const load = vi
    .spyOn(WorkloadApiJwtTrust.prototype, 'load')
    .mockResolvedValue({ revision: 'fixture', validUntil: Date.now() + 10000, jwks: {} });
  const admission = vi
    .spyOn(controllerIdentity, 'requireControllerIdentity')
    .mockImplementation(async (_, trust) => {
      if (!(await trust.load(config.trustDomain))) throw new Error('identity refused');
    });
  return { db, row, from, rpc, load, health, admission };
}
it('refuses unsynchronized issuer state before consuming any dispatch or reading trust', async () => {
  const f = fixture();
  f.health.mockResolvedValue(null);
  await expect(composeVmAssessmentController(config, f.db)).rejects.toThrow(
    'VM assessment controller configuration refused',
  );
  expect(f.load).not.toHaveBeenCalled();
  expect(f.rpc).not.toHaveBeenCalled();
});
it('refuses a node from another trust domain', async () => {
  const f = fixture();
  await expect(
    composeVmAssessmentController(
      { ...config, issuerNodeId: config.issuerNodeId.replace('local.', 'foreign.') },
      f.db,
    ),
  ).rejects.toThrow('VM assessment controller configuration refused');
  expect(f.from).not.toHaveBeenCalled();
});
it('stale health prevents a one-time claim but permits independent completion recovery', async () => {
  const f = fixture();
  const service = await composeVmAssessmentController(config, f.db, { awsKms: { send: vi.fn() } });
  const expected = {
    tenantId: tenant,
    runId: randomUUID(),
    engagementId: randomUUID(),
    correlationId: randomUUID(),
    inputHash: 'a'.repeat(64),
  };
  vi.spyOn(AssessmentDispatch.prototype, 'resolve').mockResolvedValue({ expected, claimed: false });
  const claim = vi.spyOn(AssessmentDispatch.prototype, 'claim');
  const channel = vi
    .spyOn(AssessmentChannel.prototype, 'run')
    .mockResolvedValue({ workerStatus: 'unconfirmed', cleanupConfirmed: false });
  const confirm = vi
    .spyOn(AssessmentConfirmation.prototype, 'confirm')
    .mockRejectedValue(new Error('unconfirmed'));
  f.health.mockResolvedValue(null);
  expect((await service.controller.run(tenant, randomUUID())).status).toBe('unconfirmed');
  expect(claim).not.toHaveBeenCalled();
  expect(channel).not.toHaveBeenCalled();
  expect(confirm).toHaveBeenCalledWith(expected);
  confirm.mockResolvedValue({
    run_id: expected.runId,
    finalized_receipt: '3',
    result_digest: 'b'.repeat(64),
  } as Awaited<ReturnType<AssessmentConfirmation['confirm']>>);
  expect((await service.controller.reconcile(tenant, randomUUID())).status).toBe('confirmed');
  expect(claim).not.toHaveBeenCalled();
  expect(channel).not.toHaveBeenCalled();
});
it('health expiry after a committed claim prevents launch without restoring claim authority', async () => {
  const f = fixture();
  const service = await composeVmAssessmentController(config, f.db, { awsKms: { send: vi.fn() } });
  const jobId = randomUUID();
  const expected = {
    tenantId: tenant,
    runId: randomUUID(),
    engagementId: randomUUID(),
    correlationId: randomUUID(),
    inputHash: 'a'.repeat(64),
  };
  vi.spyOn(AssessmentDispatch.prototype, 'resolve').mockResolvedValue({ expected, claimed: false });
  const claim = vi.spyOn(AssessmentDispatch.prototype, 'claim').mockImplementation(async () => {
    f.health.mockResolvedValue(null);
    return {
      runId: expected.runId,
      context: {
        ...expected,
        jobId,
        actorId: randomUUID(),
        workloadId: randomUUID(),
        estateId: null,
      },
      expiresAt: Date.now() + 300000,
      payload: new PrivateAssessmentPayload(
        expected.inputHash,
        '{}',
        new TaskProof(Buffer.alloc(32, 7).toString('base64url')),
      ),
    };
  });
  const channel = vi
    .spyOn(AssessmentChannel.prototype, 'run')
    .mockResolvedValue({ workerStatus: 'unconfirmed', cleanupConfirmed: false });
  vi.spyOn(AssessmentConfirmation.prototype, 'confirm').mockRejectedValue(new Error('unconfirmed'));
  expect((await service.controller.run(tenant, jobId)).status).toBe('unconfirmed');
  expect(claim).toHaveBeenCalledOnce();
  expect(channel).not.toHaveBeenCalled();
  await service.controller.reconcile(tenant, jobId);
  expect(claim).toHaveBeenCalledOnce();
});
it('starts only after recovering the exact persisted policy and checking protected trust, without writes', async () => {
  const f = fixture();
  const service = await composeVmAssessmentController(config, f.db, { awsKms: { send: vi.fn() } });
  expect(f.from).toHaveBeenCalledWith('assessment_dispatch_key_policies');
  expect(f.rpc).not.toHaveBeenCalled();
  expect(f.load).toHaveBeenCalledWith(config.trustDomain);
  expect(service.identity).toBeDefined();
});
it('refuses stale policy after identity admission without consuming a dispatch', async () => {
  const f = fixture();
  f.row.fingerprint = '0'.repeat(64);
  await expect(composeVmAssessmentController(config, f.db)).rejects.toThrow(
    'VM assessment controller configuration refused',
  );
  expect(f.admission).toHaveBeenCalledOnce();
  expect(f.rpc).not.toHaveBeenCalled();
});
it('refuses unavailable trust before any mutation', async () => {
  const f = fixture();
  f.load.mockResolvedValue(null);
  await expect(composeVmAssessmentController(config, f.db)).rejects.toThrow(
    'VM assessment controller configuration refused',
  );
  expect(f.rpc).not.toHaveBeenCalled();
});
it('refuses foreign runs and reconciliations before querying private job metadata', async () => {
  const f = fixture();
  const service = await composeVmAssessmentController(config, f.db, { awsKms: { send: vi.fn() } });
  f.from.mockClear();
  expect((await service.controller.run(foreign, randomUUID())).status).toBe('unconfirmed');
  expect((await service.controller.reconcile(foreign, randomUUID())).status).toBe('unconfirmed');
  expect(f.from).not.toHaveBeenCalled();
  expect(f.rpc).not.toHaveBeenCalled();
});
it('pins polling to this tenant and refuses foreign acknowledgement before RPC', async () => {
  const f = fixture();
  const service = await composeVmAssessmentController(config, f.db, { awsKms: { send: vi.fn() } });
  expect(await service.scheduling.reserve()).toEqual({ jobs: [] });
  expect(f.rpc).toHaveBeenCalledWith('reserve_assessment_schedules', {
    p_namespace: config.namespace,
    p_tenant_id: tenant,
    p_limit: 1,
  });
  f.rpc.mockClear();
  const job = randomUUID();
  await expect(
    service.scheduling.acknowledge({
      tenantId: foreign,
      jobId: job,
      leaseId: randomUUID(),
      namespace: config.namespace,
      workflowId: `assessment-${foreign}-${job}`,
      workflowRunId: randomUUID(),
    }),
  ).rejects.toThrow('Assessment scheduling unavailable');
  expect(f.rpc).not.toHaveBeenCalled();
});
it.each([
  { ...config, schemaVersion: 2 },
  { ...config, namespace: 'namespace\n' },
  { ...config, workloadSocket: '/tmp/unreviewed.sock' },
  { ...config, trustDomain: 'local.test\n' },
  { ...config, launcher: { ...config.launcher, dockerHost: 'tcp://daemon:2375' } },
  { ...config, launcher: { ...config.launcher, image: 'worker:latest' } },
  { ...config, scheduler: { ...config.scheduler, audience: 'http://controller.test' } },
  { ...config, keys: { ...config.keys, primary: key.replace('ap-south-1', 'us-east-1') } },
  { ...config, trust: { jwks: {} } },
  { ...config, launcher: { ...config.launcher, network: 'host' } },
])('refuses invalid/unsafe startup configuration before backend access %#', async (value) => {
  const f = fixture();
  await expect(composeVmAssessmentController(value, f.db)).rejects.toThrow(
    'VM assessment controller configuration refused',
  );
  expect(f.from).not.toHaveBeenCalled();
  expect(f.rpc).not.toHaveBeenCalled();
  expect(f.load).not.toHaveBeenCalled();
});
async function protectedFile() {
  const directory = await realpath(await mkdtemp('/tmp/axiom-controller-'));
  const filename = `${directory}/config.json`;
  await writeFile(filename, '{"synthetic":true}', { mode: 0o600 });
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return { directory, filename };
}
it('reads only a bounded protected regular deployment file', async () => {
  const f = await protectedFile();
  expect((await readControllerFile(f.filename)).toString()).toBe('{"synthetic":true}');
});
it('refuses group-readable deployment secrets', async () => {
  const f = await protectedFile();
  await chmod(f.filename, 0o640);
  await expect(readControllerFile(f.filename)).rejects.toThrow(
    'Controller deployment file refused',
  );
});
it('refuses symlink configuration and directory inputs', async () => {
  const f = await protectedFile();
  const link = `${f.directory}/link`;
  await symlink(f.filename, link);
  await expect(readControllerFile(link)).rejects.toThrow('Controller deployment file refused');
  await expect(readControllerFile(f.directory)).rejects.toThrow(
    'Controller deployment file refused',
  );
});
it('refuses oversized and empty deployment files', async () => {
  const f = await protectedFile();
  for (const text of ['', 'x'.repeat(131073)]) {
    await writeFile(f.filename, text);
    await expect(readControllerFile(f.filename)).rejects.toThrow(
      'Controller deployment file refused',
    );
  }
});
it('requires an explicit check/serve mode, and never exposes environment values on failure', async () => {
  for (const args of [
    [],
    ['--watch'],
    ['--serve', 'relative.json'],
    ['--serve', '/missing/file', '--extra'],
  ])
    await expect(
      prepareControllerService(args, { SUPABASE_SERVICE_KEY: 'private-fixture' }),
    ).rejects.toThrow(/^VM assessment controller startup refused$/);
});
it('rejects plaintext/proxy and unknown service configuration', () => {
  expect(() =>
    controllerServiceConfiguration.parse({
      controller: config,
      listen: { host: '0.0.0.0', port: 8443 },
      tls: 'platform',
    }),
  ).toThrow();
  expect(() =>
    vmControllerConfiguration.parse({ ...config, backend: { serviceKey: 'forbidden-inline' } }),
  ).toThrow();
});

it('refuses a missing runner image or socket volume before reading backend state', async () => {
  const f = fixture();
  vi.mocked(containerRuntime.verifyAssessmentContainerRuntime).mockRejectedValue(
    new Error('synthetic runner failure'),
  );
  await expect(composeVmAssessmentController(config, f.db)).rejects.toThrow(
    'VM assessment controller configuration refused',
  );
  expect(f.from).not.toHaveBeenCalled();
  expect(f.rpc).not.toHaveBeenCalled();
  expect(f.load).not.toHaveBeenCalled();
});

const encodedJwt = (claims: object) =>
  [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    Buffer.from('synthetic-signature-not-a-real-signer').toString('base64url'),
  ].join('.');
const backendCredential = (claims: object = {}) => ({
  schemaVersion: 1,
  apiKey: encodedJwt({ role: 'anon' }),
  accessToken: encodedJwt({
    role: 'axiom_assessment_controller',
    sub: randomUUID(),
    tenant_id: tenant,
    iat: Math.floor(Date.now() / 1000) - 1,
    exp: Math.floor(Date.now() / 1000) + 300,
    ...claims,
  }),
});
const backendEnvironment = {
  AXIOM_REGION: 'ap-south-1',
  SUPABASE_URL: 'https://backend.example.test',
};
it('loads a protected backend key without putting it in the environment', async () => {
  const f = await protectedFile();
  const value = backendCredential();
  await writeFile(f.filename, JSON.stringify(value) + '\n');
  const env = { ...backendEnvironment };
  expect(await controllerBackendCredentials(f.filename, env, tenant)).toEqual({
    url: backendEnvironment.SUPABASE_URL,
    apiKey: value.apiKey,
    accessToken: value.accessToken,
  });
  expect(env).toEqual(backendEnvironment);
});
it.each([
  'SUPABASE_SERVICE_KEY',
  'AGENT_RUNTIME_INTERNAL_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'TEMPORAL_API_KEY',
  'NODE_OPTIONS',
  'UNREVIEWED_SETTING',
])('refuses broad or secret-bearing controller environment: %s', async (name) => {
  const f = await protectedFile();
  await writeFile(f.filename, JSON.stringify(backendCredential()));
  await expect(
    controllerBackendCredentials(
      f.filename,
      {
        ...backendEnvironment,
        [name]: 'synthetic-private-value',
      },
      tenant,
    ),
  ).rejects.toThrow(/^Controller backend credentials refused$/);
});
it.each([
  '',
  'short',
  ' leading-synthetic-key-that-is-long-enough',
  'embedded\nsynthetic-key-that-is-long-enough',
  'x'.repeat(8193),
  'synthetic-backend-key-long-enough\n\n',
  'synthetic-backend-key-long-enough\uFFFD',
])('refuses malformed backend key files without exposing their content %#', async (value) => {
  const f = await protectedFile();
  await writeFile(f.filename, value);
  await expect(
    controllerBackendCredentials(f.filename, backendEnvironment, tenant),
  ).rejects.toThrow(/^Controller backend credentials refused$/);
});
it('does not fall back to environment credentials for missing or exposed files', async () => {
  const f = await protectedFile();
  await writeFile(f.filename, JSON.stringify(backendCredential()));
  await chmod(f.filename, 0o644);
  await expect(
    controllerBackendCredentials(f.filename, backendEnvironment, tenant),
  ).rejects.toThrow(/^Controller backend credentials refused$/);
  await expect(
    controllerBackendCredentials(
      '/missing/backend.key',
      {
        ...backendEnvironment,
        SUPABASE_SERVICE_KEY: 'synthetic-backend-fixture-key-for-startup',
      },
      tenant,
    ),
  ).rejects.toThrow(/^Controller backend credentials refused$/);
});
it('accepts mounted cloud identity file paths but rejects inline credential values', async () => {
  const f = await protectedFile();
  await writeFile(f.filename, JSON.stringify(backendCredential()));
  expect(
    (
      await controllerBackendCredentials(
        f.filename,
        {
          ...backendEnvironment,
          GOOGLE_APPLICATION_CREDENTIALS: '/run/identity/credentials.json',
        },
        tenant,
      )
    ).url,
  ).toBe(backendEnvironment.SUPABASE_URL);
  await expect(
    controllerBackendCredentials(
      f.filename,
      {
        ...backendEnvironment,
        GOOGLE_APPLICATION_CREDENTIALS: '{"private_key":"synthetic"}',
      },
      tenant,
    ),
  ).rejects.toThrow(/^Controller backend credentials refused$/);
});

it.each([
  { ...backendEnvironment, SUPABASE_URL: 'http://backend.example.test' },
  { ...backendEnvironment, SUPABASE_URL: 'https://user:synthetic@backend.example.test' },
  { ...backendEnvironment, AXIOM_REGION: 'us-east-1' },
  { SUPABASE_URL: backendEnvironment.SUPABASE_URL },
])('refuses unsafe backend transport or missing regional binding %#', async (env) => {
  const f = await protectedFile();
  await writeFile(f.filename, JSON.stringify(backendCredential()));
  await expect(controllerBackendCredentials(f.filename, env, tenant)).rejects.toThrow(
    /^Controller backend credentials refused$/,
  );
});

it('refuses controller role admission before accessing backend policy or dispatch', async () => {
  const f = fixture();
  f.admission.mockRejectedValue(new Error('Controller workload identity refused'));
  await expect(composeVmAssessmentController(config, f.db)).rejects.toThrow(
    'VM assessment controller configuration refused',
  );
  expect(f.from).not.toHaveBeenCalled();
  expect(f.rpc).not.toHaveBeenCalled();
});

it.each([
  { role: 'service_role' },
  { tenant_id: foreign },
  { sub: 'invalid' },
  { exp: 1 },
  { iat: Math.floor(Date.now() / 1000) + 100 },
  { exp: Math.floor(Date.now() / 1000) + 7200 },
])('rejects broad, foreign or expired controller credential claims %#', async (claims) => {
  const f = await protectedFile();
  await writeFile(f.filename, JSON.stringify(backendCredential(claims)));
  await expect(
    controllerBackendCredentials(f.filename, backendEnvironment, tenant),
  ).rejects.toThrow('Controller backend credentials refused');
});

it.each([null, foreign, { tenantId: tenant }])(
  'refuses an unattested backend tenant response %#',
  async (data) => {
    const db = {
      rpc: vi.fn(() => ({ abortSignal: vi.fn(async () => ({ data, error: null })) })),
    } as unknown as SupabaseClient;
    await expect(requireControllerBackend(db, tenant)).rejects.toThrow(
      'Controller backend scope refused',
    );
  },
);
it('requires a successful bounded read-only backend scope check', async () => {
  const abortSignal = vi.fn(async () => ({ data: tenant, error: null }));
  const rpc = vi.fn(() => ({ abortSignal }));
  await requireControllerBackend({ rpc } as unknown as SupabaseClient, tenant);
  expect(rpc).toHaveBeenCalledWith('current_assessment_controller_tenant', {}, { get: true });
  expect(abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
});
it('refuses a backend authorization error even with a matching response', async () => {
  const db = {
    rpc: vi.fn(() => ({
      abortSignal: vi.fn(async () => ({ data: tenant, error: { code: '42501' } })),
    })),
  } as unknown as SupabaseClient;
  await expect(requireControllerBackend(db, tenant)).rejects.toThrow(
    'Controller backend scope refused',
  );
});
it('refuses a service-role gateway key even with a scoped bearer credential', async () => {
  const f = await protectedFile();
  await writeFile(
    f.filename,
    JSON.stringify({ ...backendCredential(), apiKey: encodedJwt({ role: 'service_role' }) }),
  );
  await expect(
    controllerBackendCredentials(f.filename, backendEnvironment, tenant),
  ).rejects.toThrow('Controller backend credentials refused');
});
