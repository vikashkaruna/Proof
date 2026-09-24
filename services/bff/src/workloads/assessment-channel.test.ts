import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { AssessmentChannel, type ClaimedAssessment } from './assessment-channel.js';
import { AssessmentController } from './assessment-controller.js';
import { PrivateAssessmentPayload } from './dispatch-payload.js';
import { TaskProof } from './tasks.js';
import type { AssessmentConfirmation } from './assessment-confirmation.js';
const id = (n: number) => `67670000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const proof = Buffer.alloc(32, 7).toString('base64url');
const claim: ClaimedAssessment = {
  context: {
    tenantId: id(1),
    jobId: id(2),
    actorId: id(3),
    workloadId: id(4),
    estateId: null,
    engagementId: id(5),
    correlationId: id(6),
    inputHash: 'a'.repeat(64),
  },
  runId: id(7),
  expiresAt: Date.now() + 300000,
  payload: new PrivateAssessmentPayload('a'.repeat(64), '{}', new TaskProof(proof)),
};
const auth = { tenantId: id(1), runId: id(7), taskProof: proof, workloadProof: 'synthetic-svid' };
const start = {
  tool: 'assessment.start',
  request: { authorization: auth, inputHash: claim.context.inputHash },
};
const complete = { tool: 'assessment.complete', request: { authorization: auth } };
const result = {
  result: {
    status: 'persisted',
    runId: id(7),
    completed_receipt: '1',
    result_digest: 'b'.repeat(64),
  },
};
const report = { supervisor: { worker_exit: 0, timed_out: false, cleanup_confirmed: true } };
function fixture(frames: unknown[], code = 0, hang = false, delay = 0) {
  const process = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    kill: vi.fn(() => true),
  });
  const launch = vi.fn(() => {
    setTimeout(() => {
      for (const frame of frames)
        process.stdout.write(typeof frame === 'string' ? frame : JSON.stringify(frame) + '\n');
      if (!hang) {
        process.stdout.end();
        process.exitCode = code;
        process.emit('close', code, null);
      }
    }, delay);
    return process as unknown as ChildProcessWithoutNullStreams;
  });
  const tools = {
    start: vi.fn(async (_request: unknown) => ({ synthetic: true })),
    complete: vi.fn(async (_request: unknown) => ({ synthetic: true })),
  };
  return {
    launch,
    tools,
    process,
    channel: new AssessmentChannel(launch, tools, 'spiffe://test/agent/parikshan', 100),
  };
}
describe('private supervised worker channel', () => {
  it('accepts ordered bound tools and a final cleanup report, without treating persistence as verified', async () => {
    const f = fixture([start, complete, result, report]);
    expect(await f.channel.run(claim)).toEqual({
      workerStatus: 'persisted',
      cleanupConfirmed: true,
    });
    expect(f.tools.start).toHaveBeenCalledTimes(1);
    expect(f.tools.complete).toHaveBeenCalledTimes(1);
  });
  it.each(
    [
      [complete, report],
      [start, start, report],
      [result, report],
      [start, complete, result],
      [start, complete, result, report, report],
      [report, start],
      [{ tool: 'database.query', request: {} }, report],
      [
        { ...start, request: { ...start.request, authorization: { ...auth, tenantId: id(9) } } },
        report,
      ],
      [{ ...start, request: { ...start.request, inputHash: 'b'.repeat(64) } }, report],
      [start, complete, { result: { ...result.result, runId: id(9) } }, report],
      ['not-json\n', report],
      ['x'.repeat(4 * 1024 * 1024 + 1)],
    ].map((frames) => [frames]),
  )('refuses reordered, forged, unbound, missing or oversized frames', async (frames) => {
    const f = fixture(frames);
    expect(await f.channel.run(claim)).toEqual({
      workerStatus: 'unconfirmed',
      cleanupConfirmed: false,
    });
  });
  it('refuses a forged cleanup report with a mismatched process exit', async () => {
    const f = fixture([start, complete, result, report], 1);
    expect((await f.channel.run(claim)).cleanupConfirmed).toBe(false);
  });
  it('accepts confirmed cleanup after independent supervisor timeout, never persisted status', async () => {
    const f = fixture(
      [{ supervisor: { worker_exit: null, timed_out: true, cleanup_confirmed: true } }],
      124,
    );
    expect(await f.channel.run(claim)).toEqual({
      workerStatus: 'unconfirmed',
      cleanupConfirmed: true,
    });
  });
  it('bounds a hung worker and stops a late tool response without another operation', async () => {
    const f = fixture([start, complete], 0, true);
    let release: ((v: { synthetic: boolean }) => void) | undefined;
    f.tools.start.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    expect(await f.channel.run(claim)).toEqual({
      workerStatus: 'unconfirmed',
      cleanupConfirmed: false,
    });
    release?.({ synthetic: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.tools.complete).not.toHaveBeenCalled();
    expect(f.process.kill).toHaveBeenCalled();
  });
  it('does not launch after cancellation and terminates an already running channel', async () => {
    const abort = new AbortController();
    abort.abort();
    const f = fixture([]);
    await f.channel.run(claim, abort.signal);
    expect(f.launch).not.toHaveBeenCalled();
    const running = fixture([], 0, true);
    const controller = new AbortController();
    const result = running.channel.run(claim, controller.signal);
    controller.abort();
    expect(await result).toEqual({ workerStatus: 'unconfirmed', cleanupConfirmed: false });
    expect(running.process.kill).toHaveBeenCalled();
  });
  it('does not launch an expired assignment', async () => {
    const f = fixture([]);
    await f.channel.run({ ...claim, expiresAt: 0 });
    expect(f.launch).not.toHaveBeenCalled();
  });
});
describe('controller persistence reconciliation', () => {
  const expected = {
    tenantId: id(1),
    runId: id(7),
    engagementId: id(5),
    correlationId: id(6),
    inputHash: 'a'.repeat(64),
  };
  const confirmed = {
    run_id: id(7),
    finalized_receipt: '3',
    result_digest: 'b'.repeat(64),
  } as Awaited<ReturnType<AssessmentConfirmation['confirm']>>;
  function controller(claimed = false) {
    const dispatch = {
      resolve: vi.fn(async () => ({ expected, claimed })),
      claim: vi.fn(async () => claim),
    };
    const channel = {
      run: vi.fn(async () => ({ workerStatus: 'persisted' as const, cleanupConfirmed: true })),
    };
    const confirmation = { confirm: vi.fn(async () => confirmed) };
    return {
      dispatch,
      channel,
      confirmation,
      controller: new AssessmentController(dispatch, channel, confirmation),
    };
  }
  it('returns only independently confirmed IDs/digests, never private payload or result fields', async () => {
    const f = controller();
    expect(await f.controller.run(id(1), id(2))).toEqual({
      status: 'confirmed',
      runId: id(7),
      receipt: '3',
      resultDigest: 'b'.repeat(64),
      cleanupConfirmed: true,
    });
  });
  it('does not accept an exit/status claim without persisted confirmation', async () => {
    const f = controller();
    f.confirmation.confirm.mockRejectedValue(new Error('private SQL detail'));
    expect((await f.controller.run(id(1), id(2))).status).toBe('unconfirmed');
  });
  it('recovers a past commit after channel failure', async () => {
    const f = controller();
    f.channel.run.mockRejectedValue(new Error('private frame'));
    expect((await f.controller.run(id(1), id(2))).status).toBe('confirmed');
    expect(f.confirmation.confirm).toHaveBeenCalledWith(expected);
  });
  it('only reconciles an already claimed job and never relaunches', async () => {
    const f = controller(true);
    await f.controller.run(id(1), id(2));
    expect(f.dispatch.claim).not.toHaveBeenCalled();
    expect(f.channel.run).not.toHaveBeenCalled();
  });
  it('confirms after a competing claim wins rather than retrying', async () => {
    const f = controller();
    f.dispatch.claim.mockRejectedValue(new Error('claimed'));
    await f.controller.run(id(1), id(2));
    expect(f.dispatch.claim).toHaveBeenCalledTimes(1);
    expect(f.channel.run).not.toHaveBeenCalled();
    expect(f.confirmation.confirm).toHaveBeenCalled();
  });
  it('confirmation-only recovery never claims even an unclaimed job', async () => {
    const f = controller(false);
    await f.controller.reconcile(id(1), id(2));
    expect(f.dispatch.claim).not.toHaveBeenCalled();
    expect(f.channel.run).not.toHaveBeenCalled();
  });
  it('does not launch from a claim response that arrives after cancellation', async () => {
    const f = controller(false);
    const abort = new AbortController();
    f.dispatch.claim.mockImplementation(async () => {
      abort.abort();
      return claim;
    });
    await f.controller.run(id(1), id(2), abort.signal);
    expect(f.channel.run).not.toHaveBeenCalled();
    expect(f.confirmation.confirm).toHaveBeenCalled();
  });
  it('never launches mismatched dispatch context', async () => {
    const f = controller();
    f.dispatch.claim.mockResolvedValue({ ...claim, runId: id(9) });
    await f.controller.run(id(1), id(2));
    expect(f.channel.run).not.toHaveBeenCalled();
  });
});
