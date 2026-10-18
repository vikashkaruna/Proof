import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { DiscoveryChannel } from './discovery-channel.js';
const id = (n: number) => `71710000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const input = { tenantId: id(1), requestId: id(2) };
const tool = {
  tool: 'discovery.read',
  request: { ...input, workloadProof: 'private-synthetic-proof' },
};
const result = { result: { requestId: id(2), discoveryRunId: id(3) } };
const report = { supervisor: { worker_exit: 0, timed_out: false, cleanup_confirmed: true } };
function fixture(frames: unknown[], hang = false) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    kill: vi.fn(() => true),
  });
  const launch = vi.fn(() => {
    setTimeout(() => {
      for (const frame of frames) child.stdout.write(JSON.stringify(frame) + '\n');
      if (!hang) {
        child.stdout.end();
        child.exitCode = 0;
        child.emit('close', 0, null);
      }
    }, 1);
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  const read = vi.fn(async () => ({ requestId: id(2), discoveryRunId: id(3) }));
  return { child, read, channel: new DiscoveryChannel(launch, read, 50) };
}
it('confirms only an ordered bound read and independent final supervisor cleanup', async () => {
  const f = fixture([tool, result, report]);
  expect(await f.channel.run(input)).toEqual({
    workerStatus: 'read_completed',
    cleanupConfirmed: true,
  });
  expect(f.read).toHaveBeenCalledWith(input, 'private-synthetic-proof', expect.any(AbortSignal));
});
it.each([
  [tool, result],
  [tool, result, report, report],
  [tool, { result: { requestId: id(2), discoveryRunId: id(4) } }, report],
  [{ ...tool, request: { ...tool.request, tenantId: id(9) } }, result, report],
  [tool, tool, result, report],
])('refuses missing/duplicate/foreign protocol authority %#', async (...frames) => {
  const f = fixture(frames);
  expect((await f.channel.run(input)).workerStatus).toBe('unconfirmed');
});
it('returns on bounded deadline even when a broken daemon never closes stdout', async () => {
  const f = fixture([], true);
  const started = Date.now();
  expect(await f.channel.run(input)).toEqual({
    workerStatus: 'unconfirmed',
    cleanupConfirmed: false,
  });
  expect(Date.now() - started).toBeLessThan(500);
  expect(f.child.kill).toHaveBeenCalledWith('SIGTERM');
  f.child.stdout.destroy();
});
it('does not launch a pre-cancelled request', async () => {
  const f = fixture([tool, result, report]);
  const abort = new AbortController();
  abort.abort();
  expect(await f.channel.run(input, abort.signal)).toEqual({
    workerStatus: 'unconfirmed',
    cleanupConfirmed: false,
  });
  expect(f.read).not.toHaveBeenCalled();
});
