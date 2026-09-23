import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, chmod, symlink, rm, realpath } from 'node:fs/promises';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TenantId } from '@axiom/types';
import { afterEach, expect, it, vi } from 'vitest';
import { composeVmAssessmentController, vmControllerConfiguration } from './assessment-vm.js';
import * as containerRuntime from './assessment-container.js';
import { WorkloadApiJwtTrust } from './workload-api-trust.js';
import { DispatchKeyPolicy } from './dispatch-key-policy.js';
import {
  readControllerFile,
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
  return { db, row, from, rpc, load };
}
it('starts only after recovering the exact persisted policy and checking protected trust, without writes', async () => {
  const f = fixture();
  const service = await composeVmAssessmentController(config, f.db, { awsKms: { send: vi.fn() } });
  expect(f.from).toHaveBeenCalledWith('assessment_dispatch_key_policies');
  expect(f.rpc).not.toHaveBeenCalled();
  expect(f.load).toHaveBeenCalledWith(config.trustDomain);
  expect(service.identity).toBeDefined();
});
it('refuses stale policy before opening trust or consuming a dispatch', async () => {
  const f = fixture();
  f.row.fingerprint = '0'.repeat(64);
  await expect(composeVmAssessmentController(config, f.db)).rejects.toThrow(
    'VM assessment controller configuration refused',
  );
  expect(f.load).not.toHaveBeenCalled();
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
