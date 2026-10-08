import { z } from 'zod';
import { canonicalJson, sha256 } from '@axiom/ledger';
import { createHumanActionWriter } from '@axiom/supabase';
import type {
  GenericAgentPreparationContext,
  GenericAgentRuntimeResult,
} from './generic-agent-invocation.js';
import {
  RetainedSanketRefused,
  retainedSanketInputSchema,
  startRetainedSanketDispatch,
  validateRetainedSanketOutput,
  type RetainedSanketInput,
  type readRetainedSanketCapture,
} from './retained-sanket-source.js';

// Unmounted dedicated transport. Its callbacks must only be installed by the
// current-Auth source route and dispatched on the fixed Sanket IDs-only path.
// These checks establish consistency; SQL rechecks current authority and
// recomputes the full domain output atomically before accepting success.
type Loaded = Awaited<ReturnType<typeof readRetainedSanketCapture>>;
type WriterFactory = NonNullable<Parameters<typeof startRetainedSanketDispatch>[4]>;
type StartContext = Omit<GenericAgentPreparationContext, 'runId'>;
type SuccessContext = GenericAgentPreparationContext & {
  readonly result: GenericAgentRuntimeResult;
  readonly canonicalOutput: string;
  readonly responseHash: string;
};
const id = z.uuid().refine((value) => value.length === 36 && value === value.toLowerCase());
const receipt = z
  .string()
  .refine(
    (value) =>
      /^[1-9][0-9]{0,18}$/.test(value) &&
      BigInt(value).toString() === value &&
      BigInt(value) <= 9223372036854775807n,
  );
const resultSchema = z.strictObject({
  agent: z.literal('sanket'),
  correlation_id: id,
  status: z.literal('succeeded'),
  latency_ms: z.number().int().min(0).max(2147483647),
  input_tokens: z.number().int().min(0).max(2147483647),
  output_tokens: z.number().int().min(0).max(2147483647),
  cost_usd: z.number().min(0).max(9999.999999),
  error: z.null(),
  output: z.record(z.string(), z.unknown()),
  ledger_entry_ids: z.tuple([receipt, receipt]),
});

export function retainedSanketTransport(
  actorId: string,
  input: RetainedSanketInput,
  loaded: Loaded,
  writerFactory: WriterFactory = createHumanActionWriter,
) {
  if (!id.safeParse(actorId).success) throw new RetainedSanketRefused('sanket_source_conflict');
  // Snapshot the closed input before callbacks/awaits. Neither the caller nor
  // another callback may change the recorded canonical source mid-flight.
  const checked = retainedSanketInputSchema.safeParse(input);
  if (!checked.success) throw new RetainedSanketRefused('sanket_source_conflict');
  const pinnedInput = checked.data,
    pinnedLoaded = structuredClone(loaded),
    wire = canonicalJson(pinnedInput);
  async function bind(context: StartContext) {
    if (
      context.agent !== 'sanket' ||
      context.tenantId !== pinnedInput.tenant_id ||
      context.actorId !== actorId ||
      context.engagementId !== pinnedInput.engagement_id ||
      context.correlationId !== pinnedInput.correlation_id ||
      context.canonicalInput !== wire ||
      context.requestHash !== (await sha256(wire))
    )
      throw new RetainedSanketRefused('sanket_source_conflict');
  }
  return {
    async start(context: StartContext) {
      await bind(context);
      return startRetainedSanketDispatch(
        context.tenantId,
        actorId,
        pinnedInput,
        pinnedLoaded,
        writerFactory,
      );
    },
    async settleSuccess(context: SuccessContext) {
      await bind(context);
      const parsed = resultSchema.safeParse(context.result);
      if (!parsed.success || !id.safeParse(context.runId).success)
        throw new RetainedSanketRefused('sanket_source_conflict');
      const result = parsed.data;
      if (
        result.correlation_id !== pinnedInput.correlation_id ||
        result.input_tokens + result.output_tokens > 2147483647 ||
        BigInt(result.ledger_entry_ids[0]) <= BigInt(pinnedInput.source.capture_receipt) ||
        BigInt(result.ledger_entry_ids[1]) <= BigInt(result.ledger_entry_ids[0]) ||
        context.canonicalOutput !== canonicalJson(result.output) ||
        Buffer.byteLength(context.canonicalOutput, 'utf8') > 32768 ||
        context.responseHash !== (await sha256(context.canonicalOutput))
      )
        throw new RetainedSanketRefused('sanket_source_conflict');
      await validateRetainedSanketOutput(pinnedInput, result.output);
      const { data, error } = await writerFactory()
        .rpc('settle_retained_sanket_output', {
          p_tenant_id: context.tenantId,
          p_actor_id: actorId,
          p_run_id: context.runId,
          p_engagement_id: pinnedInput.engagement_id,
          p_correlation_id: pinnedInput.correlation_id,
          p_request_hash: context.requestHash,
          p_input_text: wire,
          p_output_text: context.canonicalOutput,
          p_response_hash: context.responseHash,
          p_latency_ms: result.latency_ms,
          p_input_tokens: result.input_tokens,
          p_output_tokens: result.output_tokens,
          p_cost_usd: result.cost_usd,
          p_started_receipt: result.ledger_entry_ids[0],
          p_completed_receipt: result.ledger_entry_ids[1],
        })
        .abortSignal(AbortSignal.timeout(10000));
      if (error) throw new RetainedSanketRefused('sanket_output_uncertain');
      const acknowledgement = z
        .strictObject({
          run_id: z.literal(context.runId),
          status: z.literal('succeeded'),
          replayed: z.boolean(),
        })
        .safeParse(data);
      if (!acknowledgement.success) throw new RetainedSanketRefused('sanket_output_uncertain');
      return acknowledgement.data;
    },
  };
}
