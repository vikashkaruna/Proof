import { once } from 'node:events';
import { z } from 'zod';
import type { AssessmentProcessFactory } from './assessment-channel.js';
import { ownedExecutionRequest } from '../services/owned-execution-broker.js';
import { ownedHash } from '../services/owned-execution-plan.js';
const uuid = z.uuid();
const stateRef = z.string().regex(/^owned-synthetic\/snapshot\/[a-f0-9]{64}$/);
export const ownedExecutionValue = z.union([
  z.object({ registered: z.literal(true), actionId: uuid }).strict(),
  z
    .object({ rows_affected: z.literal(1), pre_state_ref: stateRef, post_state_ref: stateRef })
    .strict(),
  z
    .object({
      checks: z
        .array(
          z
            .object({
              check_id: z.literal('owned.synthetic.audit_log_boolean'),
              outcome: z.enum(['passed', 'failed']),
              detail: z.string().max(200),
            })
            .strict(),
        )
        .length(1),
    })
    .strict(),
]);
export type OwnedExecutionValue = z.infer<typeof ownedExecutionValue>;
/** A fresh network-none Karya child per call. No result is trusted before the
 * independent supervisor cleanup frame, successful child exit and final EOF. */
export class OwnedExecutionChannel {
  constructor(
    private readonly launch: AssessmentProcessFactory,
    private readonly broker: (
      input: unknown,
      proof: string,
      signal: AbortSignal,
    ) => Promise<unknown>,
    private readonly deadlineMs = 45000,
  ) {}
  async run(input: unknown, signal?: AbortSignal): Promise<OwnedExecutionValue> {
    const assignment = ownedExecutionRequest.parse(input);
    if (signal?.aborted) throw Error('Owned execution unconfirmed');
    const child = this.launch(),
      abort = new AbortController();
    let rejectExpired: ((reason: Error) => void) | undefined;
    const expired = new Promise<never>((_, reject) => {
      rejectExpired = reject;
    });
    const stop = () => {
      abort.abort();
      child.stdin.end();
      child.kill('SIGTERM');
      rejectExpired?.(Error('Owned execution unconfirmed'));
    };
    const timer = setTimeout(stop, z.number().int().min(1).max(45000).parse(this.deadlineMs));
    signal?.addEventListener('abort', stop, { once: true });
    child.stderr.on('error', () => {});
    child.stderr.resume();
    child.stdin.on('error', () => {});
    const closed = once(child, 'close')
      .then(([code]) => code as number | null)
      .catch(() => null);
    const handle = async () => {
      child.stdin.write(JSON.stringify(assignment) + '\n');
      let buffer = Buffer.alloc(0),
        total = 0,
        tools = 0,
        terminal = false;
      let toolResult: OwnedExecutionValue | undefined, result: OwnedExecutionValue | undefined;
      let report:
        { worker_exit: number | null; timed_out: boolean; cleanup_confirmed: boolean } | undefined;
      for await (const chunk of child.stdout) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        total += bytes.length;
        if (total > 65536) throw Error();
        buffer = Buffer.concat([buffer, bytes]);
        let newline: number;
        while ((newline = buffer.indexOf(10)) >= 0) {
          const frame = buffer.subarray(0, newline);
          buffer = buffer.subarray(newline + 1);
          if (!frame.length) continue;
          let value: unknown;
          try {
            value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(frame));
          } finally {
            frame.fill(0);
          }
          if (report) throw Error();
          if (typeof value === 'object' && value !== null && 'supervisor' in value) {
            report = z
              .object({
                supervisor: z
                  .object({
                    worker_exit: z.number().int().min(-255).max(255).nullable(),
                    timed_out: z.boolean(),
                    cleanup_confirmed: z.boolean(),
                  })
                  .strict(),
              })
              .strict()
              .parse(value).supervisor;
            continue;
          }
          if (terminal || abort.signal.aborted) throw Error();
          if (typeof value === 'object' && value !== null && 'tool' in value) {
            const tool = z
              .object({
                tool: z.literal('owned.execute'),
                request: ownedExecutionRequest
                  .extend({ workloadProof: z.string().min(1).max(16384) })
                  .strict(),
              })
              .strict()
              .parse(value);
            const { workloadProof, ...request } = tool.request;
            if (tools++ || ownedHash(request) !== ownedHash(assignment)) throw Error();
            try {
              toolResult = ownedExecutionValue.parse(
                await this.broker(assignment, workloadProof, abort.signal),
              );
              child.stdin.write(JSON.stringify({ ok: true, value: toolResult }) + '\n');
            } catch {
              child.stdin.write(
                JSON.stringify({ ok: false, value: { error: 'owned_execution_refused' } }) + '\n',
              );
            }
          } else {
            result = z.object({ result: ownedExecutionValue }).strict().parse(value).result;
            if (tools !== 1 || !toolResult || ownedHash(result) !== ownedHash(toolResult))
              throw Error();
            terminal = true;
          }
        }
        if (buffer.length > 32768) throw Error();
      }
      const code = await closed;
      if (
        buffer.length ||
        !terminal ||
        !result ||
        !report?.cleanup_confirmed ||
        report.timed_out ||
        report.worker_exit !== 0 ||
        code !== 0
      )
        throw Error();
      return result;
    };
    try {
      return await Promise.race([handle(), expired]);
    } catch {
      throw Error('Owned execution unconfirmed');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      abort.abort();
      child.stdin.end();
      if (child.exitCode === null) child.kill('SIGTERM');
    }
  }
}
