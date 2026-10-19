import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { runPrativedanPrivateProcess } from './prativedan-accounted-channel.js';

/** In-memory private-pipe protocol fixture; no worker identity/SQL/provider claim. */
function processFixture(frames: unknown[]) {
  const child = new EventEmitter();
  const stdin = new PassThrough(),
    stdout = new PassThrough(),
    stderr = new PassThrough();
  let index = 0;
  const next = () => {
    const frame = frames[index++];
    if (frame === undefined) {
      stdout.end();
      Object.assign(child, { exitCode: 0 });
      child.emit('close', 0);
      return;
    }
    stdout.write(JSON.stringify(frame) + '\n');
    if (index === frames.length) queueMicrotask(next);
  };
  stdin.on('data', () => queueMicrotask(next));
  const kill = vi.fn(() => {
    stdout.end();
    child.emit('close', 1);
    return true;
  });
  return Object.assign(child, {
    stdin,
    stdout,
    stderr,
    kill,
    exitCode: null,
  }) as unknown as ChildProcessWithoutNullStreams;
}
const footer = { kind: 'supervisor', worker_exit: 0, timed_out: false, cleanup_confirmed: true };
describe('fixed accounted private process boundary', () => {
  it('rejects a hostile complete frame before any controller callback or SDK', async () => {
    const child = processFixture([
      { kind: 'complete', sequence: 1, value: { prompt: 'synthetic' } },
    ]);
    const sdk = vi.fn();
    await expect(runPrativedanPrivateProcess(() => child, {}, sdk, 'computation')).rejects.toThrow(
      'unconfirmed',
    );
    expect(sdk).not.toHaveBeenCalled();
  });
  it('rejects false cleanup even with an apparent output', async () => {
    const child = processFixture([
      { section: 'synthetic' },
      { ...footer, cleanup_confirmed: false },
    ]);
    // A renderer must close its stdin after input; fixture pumps the footer.
    child.stdout.on('data', () => {
      if (!child.stdin.destroyed) child.stdin.write('\n');
    });
    await expect(runPrativedanPrivateProcess(() => child, {}, vi.fn(), 'renderer')).rejects.toThrow(
      'unconfirmed',
    );
  });
  it('requires exact command sequence and cleanup before returning a terminal', async () => {
    const frames = [
      { kind: 'current', sequence: 1, value: null },
      { kind: 'accounting_dispatch', sequence: 2, value: null },
      { kind: 'current', sequence: 3, value: null },
      { kind: 'render', sequence: 4, value: { input_text: 'synthetic' } },
      { kind: 'current', sequence: 5, value: null },
      { kind: 'terminal', output_text: '{"synthetic":true}', failure_code: null },
      footer,
    ];
    const child = processFixture(frames);
    // Terminal has no reply; supervisor follows immediately in real process.
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('"kind":"terminal"'))
        queueMicrotask(() => child.stdin.write('\n'));
    });
    const handle = vi.fn(async () => true);
    await expect(
      runPrativedanPrivateProcess(() => child, {}, handle, 'computation'),
    ).resolves.toEqual(frames[5]);
    expect(handle.mock.calls).toHaveLength(5);
  });
});
