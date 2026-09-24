import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { z } from 'zod';
import type { AssessmentDispatch } from './assessment-dispatch.js';

export type ClaimedAssessment = Awaited<ReturnType<AssessmentDispatch['claim']>>;
export type AssessmentProcessFactory = () => ChildProcessWithoutNullStreams;
export interface ChannelOutcome {
  readonly workerStatus: 'persisted' | 'failed' | 'unconfirmed';
  readonly cleanupConfirmed: boolean;
}
const MAX_FRAME = 4 * 1024 * 1024;
const reportSchema = z
  .object({
    worker_exit: z.number().int().min(-255).max(255).nullable(),
    timed_out: z.boolean(),
    cleanup_confirmed: z.boolean(),
  })
  .strict();
const toolSchema = z
  .object({
    tool: z.enum(['assessment.start', 'assessment.complete']),
    request: z.record(z.string(), z.unknown()),
  })
  .strict();
const resultSchema = z
  .object({
    result: z
      .object({
        status: z.literal('persisted'),
        runId: z.uuid(),
        completed_receipt: z.string().regex(/^[1-9][0-9]*$/),
        result_digest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .strict();
const authSchema = z
  .object({
    tenantId: z.uuid(),
    runId: z.uuid(),
    taskProof: z.string(),
    workloadProof: z.string().min(1).max(16384),
  })
  .strict();
/** Trusted launcher only. stdio is a PRIVATE IPC channel, never logs/history.
 * The factory must start the independent supervisor; an exit code alone cannot
 * prove cleanup or persistence. Tool methods must be the authenticated BFF tools. */
export class AssessmentChannel {
  constructor(
    private readonly launch: AssessmentProcessFactory,
    private readonly tools: {
      start(request: unknown): Promise<unknown>;
      complete(request: unknown): Promise<unknown>;
    },
    private readonly spiffeId: string,
    private readonly deadlineMs = 70000,
  ) {}
  async run(claim: ClaimedAssessment, signal?: AbortSignal): Promise<ChannelOutcome> {
    let onAbort: (() => void) | undefined;
    let child: ChildProcessWithoutNullStreams | undefined,
      timer: ReturnType<typeof setTimeout> | undefined,
      stopped = false;
    const unknown: ChannelOutcome = { workerStatus: 'unconfirmed', cleanupConfirmed: false };
    try {
      z.number().int().min(1).max(70000).parse(this.deadlineMs);
      if (!/^spiffe:\/\/[a-z0-9.-]+\/agent\/parikshan$/.test(this.spiffeId)) return unknown;
      const privateInput = claim.payload.reveal();
      const wire =
        JSON.stringify({
          tenantId: claim.context.tenantId,
          runId: claim.runId,
          ...privateInput,
          inputHash: claim.context.inputHash,
          spiffeId: this.spiffeId,
        }) + '\n';
      if (signal?.aborted || Buffer.byteLength(wire) > MAX_FRAME || claim.expiresAt <= Date.now())
        return unknown;
      child = this.launch();
      // Attach before writes/iteration so synchronous launch or early close cannot
      // leak an unhandled error. Stderr is drained but never inspected or forwarded.
      child.stderr.on('error', () => {});
      child.stderr.resume();
      child.stdin.on('error', () => {});
      const closed = once(child, 'close')
        .then(([code]) => code as number | null)
        .catch(() => null);
      const process = child;
      let operations = 0,
        terminal = false,
        workerStatus: ChannelOutcome['workerStatus'] = 'unconfirmed';
      let supervisor: z.infer<typeof reportSchema> | undefined;
      const handle = async () => {
        let buffer = Buffer.alloc(0),
          total = 0;
        if (stopped) throw new Error('channel closed');
        process.stdin.write(wire);
        for await (const chunk of process.stdout) {
          if (stopped) throw new Error('channel closed');
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          total += bytes.length;
          if (total > MAX_FRAME * 4) throw new Error('channel size');
          buffer = Buffer.concat([buffer, bytes]);
          let newline: number;
          while ((newline = buffer.indexOf(10)) >= 0) {
            if (newline > MAX_FRAME) throw new Error('frame size');
            const frame = buffer.subarray(0, newline);
            buffer = buffer.subarray(newline + 1);
            if (frame.length === 0) continue;
            if (supervisor) throw new Error('frame after supervisor');
            const value: unknown = JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(frame),
            );
            if (typeof value !== 'object' || value === null) throw new Error('frame type');
            if ('supervisor' in value) {
              supervisor = z.object({ supervisor: reportSchema }).strict().parse(value).supervisor;
              continue;
            }
            if (terminal) throw new Error('frame after terminal');
            if ('tool' in value) {
              const tool = toolSchema.parse(value),
                expected = operations === 0 ? 'assessment.start' : 'assessment.complete';
              if (operations >= 2 || tool.tool !== expected) throw new Error('tool order');
              const authority = authSchema.parse(tool.request.authorization);
              if (
                authority.tenantId !== claim.context.tenantId ||
                authority.runId !== claim.runId ||
                authority.taskProof !== privateInput.taskProof
              )
                throw new Error('task binding');
              if (operations === 0 && tool.request.inputHash !== claim.context.inputHash)
                throw new Error('input binding');
              operations++;
              let reply: { ok: boolean; value: unknown };
              try {
                reply = {
                  ok: true,
                  value: await this.tools[operations === 1 ? 'start' : 'complete'](tool.request),
                };
              } catch {
                reply = { ok: false, value: { error: 'tool_refused' } };
              }
              if (stopped) throw new Error('channel closed');
              const response = JSON.stringify(reply) + '\n';
              if (Buffer.byteLength(response) > MAX_FRAME) throw new Error('response size');
              process.stdin.write(response);
            } else if ('result' in value) {
              const result = resultSchema.parse(value);
              if (operations !== 2 || result.result.runId !== claim.runId)
                throw new Error('result binding');
              workerStatus = 'persisted';
              terminal = true;
            } else {
              z.object({ error: z.literal('assessment_worker_failed') })
                .strict()
                .parse(value);
              workerStatus = 'failed';
              terminal = true;
            }
          }
          if (buffer.length > MAX_FRAME) throw new Error('frame size');
        }
        const code = await closed;
        if (buffer.length || !supervisor || !supervisor.cleanup_confirmed) return unknown;
        const expectedCode = supervisor.timed_out ? 124 : supervisor.worker_exit === 0 ? 0 : 1;
        if (code !== expectedCode || (!supervisor.timed_out && supervisor.worker_exit === null))
          return unknown;
        if (
          (workerStatus === 'persisted' && supervisor.worker_exit !== 0) ||
          (workerStatus === 'failed' && supervisor.worker_exit === 0)
        )
          workerStatus = 'unconfirmed';
        return {
          workerStatus: terminal && !supervisor.timed_out ? workerStatus : 'unconfirmed',
          cleanupConfirmed: true,
        } satisfies ChannelOutcome;
      };
      const deadline = Math.min(this.deadlineMs, claim.expiresAt - Date.now());
      const expired = new Promise<ChannelOutcome>((resolve) => {
        onAbort = () => {
          stopped = true;
          process.stdin.end();
          process.kill('SIGTERM');
          resolve(unknown);
        };
        timer = setTimeout(onAbort, Math.max(1, deadline));
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
      return await Promise.race([handle(), expired]);
    } catch {
      return unknown;
    } finally {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      child?.stdin.end();
      if (child && child.exitCode === null) child.kill('SIGTERM');
    }
  }
}
