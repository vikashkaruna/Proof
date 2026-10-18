import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { OwnedExecutionChannel } from './owned-execution-channel.js';
const id = (n: number) => `89110000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const input = {
  tenantId: id(1),
  planId: id(2),
  actionId: id(3),
  requestKey: 'synthetic',
  operation: 'forward',
  token: {
    spec: {
      planId: id(2),
      actionIds: [id(3)],
      approverId: id(4),
      mode: 'batch',
      concurrency: 1,
      stopOnFailure: true,
      expiresAt: '2099-01-01T00:00:00Z',
      nonce: 'synthetic',
      contentDigest: 'a'.repeat(64),
    },
    signature: 'b'.repeat(64),
  },
};
const value = {
  rows_affected: 1,
  pre_state_ref: 'owned-synthetic/snapshot/' + 'c'.repeat(64),
  post_state_ref: 'owned-synthetic/snapshot/' + 'd'.repeat(64),
};
const tool = { tool: 'owned.execute', request: { ...input, workloadProof: 'private-proof' } };
const result = { result: value },
  report = { supervisor: { worker_exit: 0, timed_out: false, cleanup_confirmed: true } };
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
  const broker = vi.fn(async () => value);
  return { launch, child, broker, channel: new OwnedExecutionChannel(launch, broker, 50) };
}
it('releases only matching metadata after tool+worker result+independent cleanup+EOF', async () => {
  const f = fixture([tool, result, report]);
  expect(await f.channel.run(input)).toEqual(value);
  expect(f.broker).toHaveBeenCalledWith(input, 'private-proof', expect.any(AbortSignal));
});
it.each([
  [tool, result],
  [tool, result, report, report],
  [tool, tool, result, report],
  [{ ...tool, request: { ...tool.request, actionId: id(9) } }, result, report],
  [tool, { result: { ...value, rows_affected: 2 } }, report],
  [tool, result, { supervisor: { ...report.supervisor, cleanup_confirmed: false } }],
  [tool, result, { supervisor: { ...report.supervisor, timed_out: true } }],
])('refuses malformed/foreign/unclean protocol %#', async (...frames) => {
  const f = fixture(frames);
  await expect(f.channel.run(input)).rejects.toThrow('unconfirmed');
});
it('bounds a broken daemon without claiming successful cleanup', async () => {
  const f = fixture([], true);
  const start = Date.now();
  await expect(f.channel.run(input)).rejects.toThrow('unconfirmed');
  expect(Date.now() - start).toBeLessThan(500);
  expect(f.child.kill).toHaveBeenCalledWith('SIGTERM');
  f.child.stdout.destroy();
});
it('pre-cancelled requests cannot launch a Karya process', async () => {
  const f = fixture([tool, result, report]);
  const signal = new AbortController();
  signal.abort();
  await expect(f.channel.run(input, signal.signal)).rejects.toThrow();
  expect(f.launch).not.toHaveBeenCalled();
});
