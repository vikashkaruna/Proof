import { it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, realpath, chmod, rm, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startLocalKeySocket } from './local-key-socket.js';
import { LocalKeyService } from './local-key-service.js';
import { LocalKeyPolicy, type LocalKeyAdmissionRequest } from './local-key-policy.js';
import { dispatchWrappingContext } from './dispatch-payload.js';
const tenant = '11111111-1111-4111-8111-111111111111',
  revision = '22222222-2222-4222-8222-222222222222';
const workload = '33333333-3333-4333-8333-333333333333',
  ref = `axiom-local-dispatch://${tenant}/${revision}/versions/1`;
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
const directories: string[] = [],
  sockets: Awaited<ReturnType<typeof startLocalKeySocket>>[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) await s.close();
  for (const p of directories.splice(0)) await rm(p, { recursive: true, force: true });
});
async function directory() {
  const p = await mkdtemp(join(await realpath(tmpdir()), 'alk-'));
  await chmod(p, 0o700);
  directories.push(p);
  return p;
}
function call(socketPath: string, body: string, method = 'POST', path = '/dispatch-key') {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const r = request({ socketPath, method, path }, (response) => {
      let text = '';
      response.on('data', (c) => {
        text += String(c);
      });
      response.on('end', () => resolve({ status: response.statusCode!, text }));
    });
    r.on('error', reject);
    r.end(body);
  });
}
async function setup() {
  const policy = new LocalKeyPolicy({
    tenantId: tenant,
    revision,
    mode: 'local_demo',
    validity: { kind: 'until_revoked', reviewDueAt: 1 },
    primary: ref,
    readable: [ref],
  });
  const service = new LocalKeyService(
    await directory(),
    policy,
    async (r: LocalKeyAdmissionRequest) => {
      const { deadline: _d, ...binding } = r;
      return {
        ...binding,
        verified: true,
        admissionReceiptId: revision,
        expiresAt: Date.now() + 10000,
        revoked: false,
        isDemo: true,
        operatorActivated: true,
        exception: null,
      };
    },
  );
  await service.provision({ tenantId: tenant, workloadId: workload, role: 'operator' }, ref);
  return service;
}
it('uses only a private permissioned Unix socket, with no default peer trust', async () => {
  const service = await setup(),
    path = await directory();
  const server = await startLocalKeySocket({
    directory: path,
    socketGroup: process.getgid!(),
    service,
  });
  sockets.push(server);
  expect((await stat(server.socketPath)).mode & 0o777).toBe(0o660);
  expect((await stat(path)).mode & 0o777).toBe(0o710);
  expect(await call(server.socketPath, '{}')).toEqual({
    status: 403,
    text: '{"error":"local_key_refused"}',
  });
});
it('authenticates peer operation authority and returns only authorized DEK output', async () => {
  const service = await setup();
  let role: 'producer' | 'controller' = 'producer';
  const server = await startLocalKeySocket({
    directory: await directory(),
    socketGroup: process.getgid!(),
    service,
    verifyPeer: async () => ({ tenantId: tenant, workloadId: workload, role }),
  });
  sockets.push(server);
  const body = {
    operation: 'wrap',
    context: context.toString('base64'),
    key: Buffer.alloc(32, 9).toString('base64'),
  };
  const response = await call(server.socketPath, JSON.stringify(body));
  expect(response.status).toBe(200);
  const wrapped: { keyRef: string; wrappedKey: string } = JSON.parse(response.text);
  const unwrap = {
    operation: 'unwrap',
    context: body.context,
    key: wrapped.wrappedKey,
    keyRef: wrapped.keyRef,
  };
  expect((await call(server.socketPath, JSON.stringify(unwrap))).status).toBe(403);
  role = 'controller';
  expect(await call(server.socketPath, JSON.stringify(unwrap))).toEqual({
    status: 200,
    text: JSON.stringify({ key: body.key }),
  });
});
it('rejects escaped duplicate JSON, oversize and provision requests without leaking content', async () => {
  const service = await setup();
  const server = await startLocalKeySocket({
    directory: await directory(),
    socketGroup: process.getgid!(),
    service,
    verifyPeer: async () => ({ tenantId: tenant, workloadId: workload, role: 'producer' }),
  });
  sockets.push(server);
  for (const body of [
    '{"operation":"wrap","oper\\u0061tion":"unwrap"}',
    'x'.repeat(8193),
    '{"operation":"provision","secret":"SENSITIVE"}',
  ]) {
    expect(await call(server.socketPath, body)).toEqual({
      status: 403,
      text: '{"error":"local_key_refused"}',
    });
  }
});
it('refuses unsafe/nonempty socket directories before listening', async () => {
  const service = await setup(),
    path = await directory();
  await chmod(path, 0o755);
  await expect(
    startLocalKeySocket({ directory: path, socketGroup: process.getgid!(), service }),
  ).rejects.toThrow('Local key service unavailable');
});

it('rejects wrong routes, noncanonical bytes and operation-shape confusion', async () => {
  const service = await setup();
  const server = await startLocalKeySocket({
    directory: await directory(),
    socketGroup: process.getgid!(),
    service,
    verifyPeer: async () => ({ tenantId: tenant, workloadId: workload, role: 'producer' }),
  });
  sockets.push(server);
  for (const body of [
    { operation: 'wrap', context: context.toString('base64'), key: '!!' },
    {
      operation: 'wrap',
      context: context.toString('base64'),
      key: Buffer.alloc(32).toString('base64'),
      keyRef: ref,
    },
    {
      operation: 'unwrap',
      context: context.toString('base64'),
      key: Buffer.alloc(61).toString('base64'),
    },
  ])
    expect((await call(server.socketPath, JSON.stringify(body))).status).toBe(403);
  expect((await call(server.socketPath, '{}', 'GET')).status).toBe(403);
  expect((await call(server.socketPath, '{}', 'POST', '/provision')).status).toBe(403);
});
it('refuses nonempty private directories', async () => {
  const service = await setup(),
    path = await directory();
  await writeFile(join(path, 'owned-fixture'), 'x', { mode: 0o600 });
  await expect(
    startLocalKeySocket({ directory: path, socketGroup: process.getgid!(), service }),
  ).rejects.toThrow('Local key service unavailable');
});

it('closes a stalled peer verification at the original deadline and never executes late key work', async () => {
  const service = await setup(),
    wrap = vi.spyOn(service, 'wrap');
  let release!: (value: { tenantId: string; workloadId: string; role: 'producer' }) => void;
  const waiting = new Promise<{ tenantId: string; workloadId: string; role: 'producer' }>(
    (resolve) => {
      release = resolve;
    },
  );
  const server = await startLocalKeySocket({
    directory: await directory(),
    socketGroup: process.getgid!(),
    service,
    verifyPeer: () => waiting,
  });
  sockets.push(server);
  const before = Date.now();
  await expect(
    call(
      server.socketPath,
      JSON.stringify({
        operation: 'wrap',
        context: context.toString('base64'),
        key: Buffer.alloc(32).toString('base64'),
      }),
    ),
  ).rejects.toThrow();
  expect(Date.now() - before).toBeGreaterThanOrEqual(4900);
  release({ tenantId: tenant, workloadId: workload, role: 'producer' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(wrap).not.toHaveBeenCalled();
});
