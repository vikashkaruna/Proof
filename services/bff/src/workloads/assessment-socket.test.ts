import { request } from 'node:http';
import { chmod, lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startAssessmentControllerSocket } from './assessment-socket.js';
const id = (n: number) => `45450000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const job = { tenantId: id(1), jobId: id(2) };
const confirmed = {
  status: 'confirmed' as const,
  runId: id(3),
  receipt: '10',
  resultDigest: 'b'.repeat(64),
  cleanupConfirmed: true,
};
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(
  deadlineMs = 5000,
  scheduling?: Parameters<typeof startAssessmentControllerSocket>[0]['scheduling'],
) {
  const directory = await realpath(await mkdtemp('/tmp/ax-controller-'));
  await chmod(directory, 0o700);
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const controller = {
    run: vi.fn(async (_tenant: string, _job: string, _signal?: AbortSignal) => confirmed),
    reconcile: vi.fn(async (_tenant: string, _job: string) => ({
      ...confirmed,
      cleanupConfirmed: null,
    })),
  };
  const socket = await startAssessmentControllerSocket({
    directory,
    scheduling,
    controller,
    socketGroup: process.getgid!(),
    deadlineMs,
  });
  cleanup.push(() => socket.close());
  return { ...socket, directory, controller };
}
function call(socketPath: string, body: unknown = job, path = '/assessment/run') {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        timeout: 3000,
      },
      (response) => {
        let body = '';
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () => resolve({ status: response.statusCode!, body }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('fixture timeout')));
    req.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}
describe('private controller socket', () => {
  it('exposes only opaque metadata behind a protected group socket', async () => {
    const f = await fixture();
    const reply = await call(f.socketPath);
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ ...job, ...confirmed });
    expect((await lstat(f.directory)).mode & 0o777).toBe(0o710);
    expect((await lstat(f.socketPath)).mode & 0o777).toBe(0o660);
    expect((await lstat(f.socketPath)).gid).toBe(process.getgid!());
    expect(f.controller.run).toHaveBeenCalledWith(job.tenantId, job.jobId, expect.any(AbortSignal));
  });
  it('routes reconciliation separately without invoking run', async () => {
    const f = await fixture();
    expect((await call(f.socketPath, job, '/assessment/reconcile')).status).toBe(200);
    expect(f.controller.run).not.toHaveBeenCalled();
    expect(f.controller.reconcile).toHaveBeenCalledWith(job.tenantId, job.jobId);
  });
  it.each([
    'not-json',
    'x'.repeat(513),
    { ...job, taskProof: 'private-marker' },
    { ...job, jobId: 'private-marker' },
  ])('refuses malformed/oversized/private input without echo', async (value) => {
    const f = await fixture();
    const reply = await call(f.socketPath, value);
    expect(reply.status).toBe(503);
    expect(reply.body).not.toContain('private-marker');
    expect(f.controller.run).not.toHaveBeenCalled();
  });
  it.each(['/assessment/run?private-marker', '/arbitrary', '/assessment/enqueue'])(
    'refuses unknown routes',
    async (path) => {
      const f = await fixture();
      expect((await call(f.socketPath, job, path)).status).toBe(503);
      expect(f.controller.run).not.toHaveBeenCalled();
    },
  );
  it('sanitizes a malformed/private controller response', async () => {
    const f = await fixture();
    f.controller.run.mockResolvedValue({
      ...confirmed,
      privateInput: 'private-marker',
    } as typeof confirmed);
    const reply = await call(f.socketPath);
    expect(reply.status).toBe(503);
    expect(reply.body).not.toContain('private-marker');
  });
  it('aborts a deadline and keeps the slot occupied until real controller work settles', async () => {
    const f = await fixture(100);
    let release: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    f.controller.run.mockImplementation(async (_t, _j, s) => {
      signal = s;
      await new Promise<void>((resolve) => (release = resolve));
      return confirmed;
    });
    const result = await call(f.socketPath).catch(() => ({ status: 503, body: '' }));
    expect(result.status).toBe(503);
    expect(signal?.aborted).toBe(true);
    expect((await call(f.socketPath)).status).toBe(503);
    expect(f.controller.run).toHaveBeenCalledTimes(1);
    release!();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  it('aborts a disconnected client', async () => {
    const f = await fixture();
    let release: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    f.controller.run.mockImplementation(async (_t, _j, s) => {
      signal = s;
      await new Promise<void>((resolve) => (release = resolve));
      return confirmed;
    });
    const req = request({
      socketPath: f.socketPath,
      path: '/assessment/run',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    req.on('error', () => {});
    req.end(JSON.stringify(job));
    await vi.waitFor(() => expect(signal).toBeDefined());
    req.destroy();
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    release!();
  });
  it('enables scheduling only with a trusted adapter and keeps it separate from execution', async () => {
    const disabled = await fixture();
    expect((await call(disabled.socketPath, {}, '/assessment/scheduling/poll')).status).toBe(503);
    const scheduling = { reserve: vi.fn(async () => ({ jobs: [] })), acknowledge: vi.fn() };
    const f = await fixture(5000, scheduling);
    expect((await call(f.socketPath, {}, '/assessment/scheduling/poll')).status).toBe(200);
    expect(
      (await call(f.socketPath, { tenantId: id(9) }, '/assessment/scheduling/poll')).status,
    ).toBe(503);
    expect(
      (await call(f.socketPath, { input: 'private-marker' }, '/assessment/scheduling/ack')).status,
    ).toBe(503);
    expect(scheduling.reserve).toHaveBeenCalledTimes(1);
    expect(scheduling.acknowledge).not.toHaveBeenCalled();
    expect(f.controller.run).not.toHaveBeenCalled();
  });
  it('refuses a directory accessible by other principals before binding', async () => {
    const directory = await realpath(await mkdtemp('/tmp/ax-controller-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    await chmod(directory, 0o755);
    await expect(
      startAssessmentControllerSocket({
        directory,
        socketGroup: process.getgid!(),
        controller: { run: vi.fn(), reconcile: vi.fn() },
      }),
    ).rejects.toThrow('Private controller unavailable');
  });
});
