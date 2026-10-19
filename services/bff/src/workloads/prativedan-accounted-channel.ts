import { once } from 'node:events';
import { z } from 'zod';
import type { AssessmentProcessFactory } from './assessment-channel.js';
import { canonicalJson } from '@axiom/ledger';
import { modelAccountingBindingSchema } from '@axiom/types';

const supervisorSchema = z.strictObject({
  kind: z.literal('supervisor'),
  worker_exit: z.number().int().nullable(),
  timed_out: z.literal(false),
  cleanup_confirmed: z.literal(true),
});
const terminalSchema = z
  .strictObject({
    kind: z.literal('terminal'),
    output_text: z.string().min(1).max(1048576).nullable(),
    failure_code: z
      .enum([
        'target_failed',
        'invocation_cancelled',
        'accounting_uncertain',
        'current_authority_refused',
      ])
      .nullable(),
  })
  .refine((v) => (v.output_text === null) !== (v.failure_code === null));
const frameSchema = z.strictObject({
  kind: z.enum(['current', 'accounting_dispatch', 'render']),
  sequence: z.number().int().min(1).max(8),
  value: z.unknown(),
});
const MAX_FRAME = 4 * 1024 * 1024;
export class PrativedanPrivateComputationUnconfirmed extends Error {
  constructor() {
    super('prativedan_private_computation_unconfirmed');
  }
}

/** Strict private process protocol: bounded bytes/order/cleanup; stderr is
 * drained, never logged. Unexpected complete/SDK commands are refused here. */
export async function runPrativedanPrivateProcess(
  launch: AssessmentProcessFactory,
  input: unknown,
  handle: (kind: z.infer<typeof frameSchema>['kind'], value: unknown) => Promise<unknown>,
  mode: 'computation' | 'renderer',
): Promise<unknown> {
  const child = launch();
  child.stderr.on('error', () => {});
  child.stderr.resume();
  child.stdin.on('error', () => {});
  const closed = once(child, 'close')
    .then(([code]) => code as number | null)
    .catch(() => null);
  let stopped = false;
  const timer = setTimeout(() => {
    stopped = true;
    child.stdin.end();
    child.kill('SIGTERM');
  }, 70000);
  try {
    const wire = canonicalJson(input) + '\n';
    if (Buffer.byteLength(wire) > MAX_FRAME) throw new Error();
    child.stdin.write(wire);
    let buffer = Buffer.alloc(0),
      total = 0,
      sequence = 0;
    let terminal: unknown, footer: z.infer<typeof supervisorSchema> | undefined;
    const expected = ['current', 'accounting_dispatch', 'current', 'render', 'current'];
    for await (const chunk of child.stdout) {
      if (stopped) throw new Error();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += bytes.length;
      if (total > MAX_FRAME * 4) throw new Error();
      buffer = Buffer.concat([buffer, bytes]);
      let end: number;
      while ((end = buffer.indexOf(10)) >= 0) {
        if (end < 1 || end > MAX_FRAME || footer) throw new Error();
        const raw: unknown = JSON.parse(
          new TextDecoder('utf8', { fatal: true }).decode(buffer.subarray(0, end)),
        );
        buffer = buffer.subarray(end + 1);
        if (raw && typeof raw === 'object' && 'kind' in raw && raw.kind === 'supervisor') {
          footer = supervisorSchema.parse(raw);
          continue;
        }
        if (terminal !== undefined) throw new Error();
        if (mode === 'renderer') {
          terminal = raw;
          continue;
        }
        if (raw && typeof raw === 'object' && 'kind' in raw && raw.kind === 'terminal') {
          terminal = terminalSchema.parse(raw);
          continue;
        }
        const frame = frameSchema.parse(raw);
        if (frame.sequence !== ++sequence || frame.kind !== expected[sequence - 1])
          throw new Error();
        if (frame.kind !== 'render' && frame.value !== null) throw new Error();
        const value = await handle(frame.kind, frame.value);
        if (stopped) throw new Error();
        const reply = canonicalJson({ sequence, value }) + '\n';
        if (Buffer.byteLength(reply) > MAX_FRAME) throw new Error();
        child.stdin.write(reply);
      }
      if (buffer.length > MAX_FRAME) throw new Error();
    }
    if (
      stopped ||
      buffer.length ||
      terminal === undefined ||
      !footer ||
      footer.worker_exit !== 0 ||
      (await closed) !== 0
    )
      throw new Error();
    if (mode === 'computation' && sequence !== 5) {
      // Failure can stop before target rendering; no zero success is inferred.
      if (terminalSchema.parse(terminal).failure_code === null) throw new Error();
    }
    return terminal;
  } catch {
    throw new PrativedanPrivateComputationUnconfirmed();
  } finally {
    clearTimeout(timer);
    stopped = true;
    child.stdin.end();
    if (child.exitCode === null) child.kill('SIGTERM');
  }
}

export async function computePrativedanAccounted(args: {
  binding: z.infer<typeof modelAccountingBindingSchema>;
  inputText: string;
  accountingDispatch: unknown;
  requireCurrent(): Promise<void>;
  computation: AssessmentProcessFactory;
  renderer: AssessmentProcessFactory;
}) {
  let dispatched = false,
    rendered = false;
  return terminalSchema.parse(
    await runPrativedanPrivateProcess(
      args.computation,
      {
        kind: 'compute_prativedan_zero',
        binding: modelAccountingBindingSchema.parse(args.binding),
        input_text: args.inputText,
      },
      async (kind, value) => {
        if (kind === 'current') {
          await args.requireCurrent();
          return true;
        }
        if (kind === 'accounting_dispatch') {
          if (dispatched) throw new Error();
          dispatched = true;
          return args.accountingDispatch;
        }
        const frame = z.strictObject({ input_text: z.literal(args.inputText) }).parse(value);
        if (!dispatched || rendered) throw new Error();
        await args.requireCurrent();
        rendered = true;
        return runPrativedanPrivateProcess(
          args.renderer,
          frame,
          async () => {
            throw new Error();
          },
          'renderer',
        );
      },
      'computation',
    ),
  );
}
