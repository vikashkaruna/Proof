import { once } from 'node:events';
import { z } from 'zod';
import type { AssessmentProcessFactory } from './assessment-channel.js';
const pointer = z.object({ tenantId: z.uuid(), requestId: z.uuid() }).strict();
const receipt = z.object({ requestId: z.uuid(), discoveryRunId: z.uuid() }).strict();
export const discoveryOutcome = z
  .object({
    workerStatus: z.enum(['read_completed', 'failed', 'unconfirmed']),
    cleanupConfirmed: z.boolean(),
  })
  .strict();
export type DiscoveryOutcome = z.infer<typeof discoveryOutcome>;
/** Network-none Drishti private tool channel. Proofs are never returned to the
 * request caller. A final independent supervisor frame and EOF are mandatory. */
export class DiscoveryChannel {
  constructor(
    private readonly launch: AssessmentProcessFactory,
    private readonly read: (
      request: z.infer<typeof pointer>,
      proof: string,
      signal: AbortSignal,
    ) => Promise<unknown>,
    private readonly deadlineMs = 45000,
  ) {}
  async run(input: unknown, signal?: AbortSignal): Promise<DiscoveryOutcome> {
    const unknown: DiscoveryOutcome = { workerStatus: 'unconfirmed', cleanupConfirmed: false };
    const assignment = pointer.parse(input);
    if (signal?.aborted) return unknown;
    const child = this.launch();
    const abort = new AbortController();
    let resolveExpired: ((value: DiscoveryOutcome) => void) | undefined;
    const expired = new Promise<DiscoveryOutcome>((resolve) => {
      resolveExpired = resolve;
    });
    const stop = () => {
      abort.abort();
      child.stdin.end();
      child.kill('SIGTERM');
      resolveExpired?.(unknown);
    };
    const timer = setTimeout(stop, z.number().int().min(1).max(45000).parse(this.deadlineMs));
    signal?.addEventListener('abort', stop, { once: true });
    child.stderr.on('error', () => {});
    child.stderr.resume();
    child.stdin.on('error', () => {});
    const closed = once(child, 'close')
      .then(([code]) => code as number | null)
      .catch(() => null);
    let workerStatus: DiscoveryOutcome['workerStatus'] = 'unconfirmed';
    const handle = async (): Promise<DiscoveryOutcome> => {
      try {
        child.stdin.write(JSON.stringify(assignment) + '\n');
        let buffer = Buffer.alloc(0),
          total = 0,
          tools = 0,
          terminal = false;
        let toolResult: z.infer<typeof receipt> | undefined;
        let report:
          | { worker_exit: number | null; timed_out: boolean; cleanup_confirmed: boolean }
          | undefined;
        for await (const chunk of child.stdout) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          total += bytes.length;
          if (total > 65536) throw new Error();
          buffer = Buffer.concat([buffer, bytes]);
          let newline: number;
          while ((newline = buffer.indexOf(10)) >= 0) {
            const frame = buffer.subarray(0, newline);
            buffer = buffer.subarray(newline + 1);
            if (!frame.length) continue;
            const value: unknown = JSON.parse(
              new TextDecoder('utf8', { fatal: true }).decode(frame),
            );
            frame.fill(0);
            if (report) throw new Error();
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
            if (terminal || abort.signal.aborted) throw new Error();
            if (typeof value === 'object' && value !== null && 'tool' in value) {
              const tool = z
                .object({
                  tool: z.literal('discovery.read'),
                  request: pointer.extend({ workloadProof: z.string().min(1).max(16384) }).strict(),
                })
                .strict()
                .parse(value);
              if (
                tools++ ||
                tool.request.tenantId !== assignment.tenantId ||
                tool.request.requestId !== assignment.requestId
              )
                throw new Error();
              try {
                toolResult = receipt.parse(
                  await this.read(assignment, tool.request.workloadProof, abort.signal),
                );
                if (toolResult.requestId !== assignment.requestId) throw new Error();
                child.stdin.write(JSON.stringify({ ok: true, value: toolResult }) + '\n');
              } catch {
                child.stdin.write(
                  JSON.stringify({ ok: false, value: { error: 'discovery_refused' } }) + '\n',
                );
              }
            } else if (typeof value === 'object' && value !== null && 'result' in value) {
              const result = z.object({ result: receipt }).strict().parse(value).result;
              if (
                tools !== 1 ||
                !toolResult ||
                result.requestId !== assignment.requestId ||
                result.discoveryRunId !== toolResult.discoveryRunId
              )
                throw new Error();
              terminal = true;
              workerStatus = 'read_completed';
            } else {
              z.object({ error: z.literal('discovery_worker_failed') })
                .strict()
                .parse(value);
              terminal = true;
              workerStatus = 'failed';
            }
          }
          if (buffer.length > 32768) throw new Error();
        }
        const code = await closed;
        if (
          buffer.length ||
          !report?.cleanup_confirmed ||
          report.timed_out ||
          report.worker_exit === null ||
          code !== (report.worker_exit === 0 ? 0 : 1)
        )
          return unknown;
        if (
          !terminal ||
          (workerStatus === 'read_completed' && report.worker_exit !== 0) ||
          (workerStatus === 'failed' && report.worker_exit === 0)
        )
          return { workerStatus: 'unconfirmed', cleanupConfirmed: true };
        return { workerStatus, cleanupConfirmed: true };
      } catch {
        return unknown;
      }
    };
    try {
      return await Promise.race([handle(), expired]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      abort.abort();
      child.stdin.end();
      if (child.exitCode === null) child.kill('SIGTERM');
    }
  }
}
