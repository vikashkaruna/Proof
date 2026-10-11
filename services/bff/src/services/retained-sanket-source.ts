import { z } from 'zod';
import { canonicalJson, sha256 } from '@axiom/ledger';
import { createHumanActionWriter } from '@axiom/supabase';

// These parsers establish consistency, never current Auth/MFA/capability or a
// source grant. Only restricted RPCs load the original capture and enforce
// human authority, kill state, one claim and complete lifecycle bindings.
const id = z.uuid().refine((value) => value.length === 36 && value === value.toLowerCase());
const digest = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/);
const receipt = z
  .string()
  .refine(
    (value) =>
      /^[1-9][0-9]{0,18}$/.test(value) &&
      BigInt(value).toString() === value &&
      BigInt(value) <= 9223372036854775807n,
  );
const url = z
  .string()
  .max(2048)
  .regex(/^https:\/\/([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(\/[^?#\s]*)?$/)
  .refine((value) => !/\s/.test(value));
export const retainedSanketCaptureSchema = z.strictObject({
  check_id: id,
  capture_actor_id: id,
  capture_correlation_id: id,
  capture_receipt: receipt,
  result_sha256: digest,
  requested_url: url,
  final_url: url,
  checked_at: z.iso.datetime({ offset: true }).max(64),
  content_sha256: digest,
  byte_size: z.number().int().min(1).max(524288),
  title: z.string().max(300),
  headings: z.array(z.string().max(300)).max(12),
});
export type RetainedSanketCapture = z.infer<typeof retainedSanketCaptureSchema>;
export const retainedSanketInputSchema = z.strictObject({
  schema_version: z.literal(1),
  tenant_id: id,
  engagement_id: id,
  correlation_id: id,
  sectors: z.tuple([z.literal('BFSI'), z.literal('Healthcare'), z.literal('SaaS / Tech')]),
  geo: z.literal('India'),
  since: z.null(),
  source: retainedSanketCaptureSchema,
});
export type RetainedSanketInput = z.infer<typeof retainedSanketInputSchema>;
export class RetainedSanketRefused extends Error {
  constructor(readonly code: 'sanket_source_conflict' | 'sanket_output_uncertain') {
    super(code);
  }
}
function bounded(value: string) {
  if (Buffer.byteLength(value, 'utf8') > 32768)
    throw new RetainedSanketRefused('sanket_source_conflict');
  return value;
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new RetainedSanketRefused('sanket_source_conflict');
  return result.data;
}
type RpcPort = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): {
    abortSignal(signal: AbortSignal): PromiseLike<{ data: unknown; error: unknown }>;
  };
};
type WriterFactory = () => RpcPort;
type Source = Readonly<{
  capture: RetainedSanketCapture;
  captureResultText: string;
  sourceHash: string;
}>;
export async function readRetainedSanketCapture(
  tenantId: string,
  actorId: string,
  engagementId: string,
  checkId: string,
  writerFactory: WriterFactory = createHumanActionWriter,
): Promise<Source> {
  [tenantId, actorId, engagementId, checkId].forEach((value) => parse(id, value));
  const { data, error } = await writerFactory()
    .rpc('preview_retained_sanket_source', {
      p_tenant_id: tenantId,
      p_actor_id: actorId,
      p_engagement_id: engagementId,
      p_check_id: checkId,
    })
    .abortSignal(AbortSignal.timeout(10000));
  if (error) throw new RetainedSanketRefused('sanket_output_uncertain');
  const row = parse(
    z.strictObject({
      source: retainedSanketCaptureSchema,
      source_hash: digest,
      capture_result_text: z.string().min(1).max(32768),
    }),
    data,
  );
  bounded(row.capture_result_text);
  if (
    row.source.check_id !== checkId ||
    row.source_hash !== (await sha256(canonicalJson(row.source))) ||
    row.source.result_sha256 !== (await sha256(row.capture_result_text))
  )
    throw new RetainedSanketRefused('sanket_source_conflict');
  let capture: unknown;
  try {
    capture = JSON.parse(row.capture_result_text) as unknown;
  } catch {
    throw new RetainedSanketRefused('sanket_source_conflict');
  }
  const projected = parse(
    z
      .object({
        requestedUrl: z.string(),
        finalUrl: z.string(),
        checkedAt: z.string(),
        status: z.literal('checked'),
        httpStatus: z.literal(200),
        bytes: z.number().int(),
        contentSha256: digest,
        title: z.string(),
        headings: z.array(z.string()),
      })
      .passthrough(),
    capture,
  );
  if (
    projected.requestedUrl !== row.source.requested_url ||
    projected.finalUrl !== row.source.final_url ||
    projected.checkedAt !== row.source.checked_at ||
    projected.bytes !== row.source.byte_size ||
    projected.contentSha256 !== row.source.content_sha256 ||
    projected.title !== row.source.title ||
    canonicalJson(projected.headings) !== canonicalJson(row.source.headings)
  )
    throw new RetainedSanketRefused('sanket_source_conflict');
  Object.freeze(row.source.headings);
  Object.freeze(row.source);
  return Object.freeze({
    capture: row.source,
    captureResultText: row.capture_result_text,
    sourceHash: row.source_hash,
  });
}
export function retainedSanketInput(
  tenantId: string,
  engagementId: string,
  operationKey: string,
  capture: RetainedSanketCapture,
): RetainedSanketInput {
  return parse(retainedSanketInputSchema, {
    schema_version: 1,
    tenant_id: tenantId,
    engagement_id: engagementId,
    correlation_id: operationKey,
    sectors: ['BFSI', 'Healthcare', 'SaaS / Tech'],
    geo: 'India',
    since: null,
    source: capture,
  });
}
export async function startRetainedSanketDispatch(
  tenantId: string,
  actorId: string,
  input: RetainedSanketInput,
  loaded: Source,
  writerFactory: WriterFactory = createHumanActionWriter,
) {
  parse(id, actorId);
  const checked = parse(retainedSanketInputSchema, input);
  const wire = bounded(canonicalJson(checked));
  bounded(loaded.captureResultText);
  if (
    checked.tenant_id !== parse(id, tenantId) ||
    canonicalJson(checked.source) !== canonicalJson(loaded.capture) ||
    loaded.sourceHash !== (await sha256(canonicalJson(loaded.capture))) ||
    loaded.capture.result_sha256 !== (await sha256(loaded.captureResultText))
  )
    throw new RetainedSanketRefused('sanket_source_conflict');
  const { data, error } = await writerFactory()
    .rpc('start_retained_sanket_dispatch', {
      p_tenant_id: tenantId,
      p_actor_id: actorId,
      p_engagement_id: checked.engagement_id,
      p_operation_key: checked.correlation_id,
      p_input_text: wire,
      p_capture_result_text: loaded.captureResultText,
    })
    .abortSignal(AbortSignal.timeout(10000));
  if (error) throw new RetainedSanketRefused('sanket_output_uncertain');
  const row = parse(
    z.strictObject({
      run_id: id,
      created: z.boolean(),
      status: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
    }),
    data,
  );
  if (row.created && row.status !== 'running')
    throw new RetainedSanketRefused('sanket_source_conflict');
  // This is a recorded request acknowledgement. It grants no second runtime
  // invocation and is never presented as a completed source observation.
  return row;
}
const signalContext =
  'Marker observed in a bounded public title/heading. The host is a source identifier, not a verified legal company identity. Hiring, procurement, applicability, recency and buying intent are unverified; human review is required.';
const notes =
  'Processed only supplied approved public captures and explicit title/heading markers. Zero score and empty high-intent list preserve unknown buying intent. Capture time is not notice publication time. Sector/geography preferences do not establish source-company classification. No contact records, outreach, login or message delivery is performed.';
const kinds = ['public_rfp_heading', 'public_dpo_heading', 'public_hiring_heading'] as const;
const signal = z.strictObject({
  source: id,
  company: z.string(),
  signal: z.enum(kinds),
  detected_at: z.string(),
  score: z.literal(0),
  context: z.literal(signalContext),
  url,
});
const outputSchema = z.strictObject({
  signals: z.array(signal).max(3),
  high_intent: z.array(signal).max(0),
  source_observations: z
    .array(
      z.strictObject({
        requested_url: url,
        final_url: url,
        checked_at: z.string(),
        content_sha256: digest,
        projection_sha256: digest,
        capture_reference: id,
        observed_notice_kinds: z.array(z.enum(kinds)).max(3),
        requires_human_review: z.literal(true),
      }),
    )
    .length(1),
  processing_mode: z.literal('verified_public_capture_review'),
  notes: z.literal(notes),
});
export async function validateRetainedSanketOutput(input: RetainedSanketInput, raw: unknown) {
  const checked = parse(retainedSanketInputSchema, input),
    output = parse(outputSchema, raw);
  const source = checked.source,
    observation = output.source_observations[0];
  if (!observation) throw new RetainedSanketRefused('sanket_source_conflict');
  const projection = {
    requested_url: source.requested_url,
    final_url: source.final_url,
    checked_at: source.checked_at,
    content_sha256: source.content_sha256,
    byte_size: source.byte_size,
    title: source.title,
    headings: source.headings,
    capture_reference: source.check_id,
  };
  // SQL independently recomputes actual heading markers before atomically
  // settling. This consistency parser must never replace that domain gate.
  if (
    observation.requested_url !== source.requested_url ||
    observation.final_url !== source.final_url ||
    observation.checked_at !== source.checked_at ||
    observation.content_sha256 !== source.content_sha256 ||
    observation.capture_reference !== source.check_id ||
    observation.projection_sha256 !== (await sha256(canonicalJson(projection))) ||
    new Set(observation.observed_notice_kinds).size !== observation.observed_notice_kinds.length ||
    observation.observed_notice_kinds.some((kind, index, all) => {
      const previous = all[index - 1];
      return index > 0 && previous !== undefined && kinds.indexOf(previous) >= kinds.indexOf(kind);
    }) ||
    output.signals.length !== observation.observed_notice_kinds.length ||
    output.signals.some(
      (item, index) =>
        item.signal !== observation.observed_notice_kinds[index] ||
        item.source !== source.check_id ||
        item.url !== source.final_url ||
        item.detected_at !== source.checked_at ||
        item.company !== new URL(source.final_url).hostname,
    )
  )
    throw new RetainedSanketRefused('sanket_source_conflict');
  bounded(canonicalJson(output));
  return output;
}
const recorded = z.strictObject({
  run_id: id,
  input_hash: digest,
  output_hash: digest,
  output_text: z.string().min(1).max(32768),
  requested_receipt: receipt,
  started_receipt: receipt,
  completed_receipt: receipt,
  settled_receipt: receipt,
});
export async function recoverRetainedSanketOutput(
  tenantId: string,
  actorId: string,
  input: RetainedSanketInput,
  writerFactory: WriterFactory = createHumanActionWriter,
) {
  parse(id, actorId);
  const wire = bounded(canonicalJson(parse(retainedSanketInputSchema, input)));
  if (input.tenant_id !== parse(id, tenantId))
    throw new RetainedSanketRefused('sanket_source_conflict');
  const { data, error } = await writerFactory()
    .rpc('recover_retained_sanket_output', {
      p_tenant_id: tenantId,
      p_actor_id: actorId,
      p_engagement_id: input.engagement_id,
      p_operation_key: input.correlation_id,
      p_input_text: wire,
    })
    .abortSignal(AbortSignal.timeout(10000));
  if (error) throw new RetainedSanketRefused('sanket_output_uncertain');
  if (z.strictObject({ missing: z.literal(true) }).safeParse(data).success) return null;
  if (z.strictObject({ error: z.literal('output_unrecoverable') }).safeParse(data).success)
    throw new RetainedSanketRefused('sanket_output_uncertain');
  const row = parse(recorded, data);
  bounded(row.output_text);
  let raw: unknown;
  try {
    raw = JSON.parse(row.output_text) as unknown;
  } catch {
    throw new RetainedSanketRefused('sanket_source_conflict');
  }
  const output = await validateRetainedSanketOutput(input, raw);
  if (
    canonicalJson(output) !== row.output_text ||
    row.input_hash !== (await sha256(wire)) ||
    row.output_hash !== (await sha256(row.output_text)) ||
    !(
      BigInt(input.source.capture_receipt) < BigInt(row.requested_receipt) &&
      BigInt(row.requested_receipt) < BigInt(row.started_receipt) &&
      BigInt(row.started_receipt) < BigInt(row.completed_receipt) &&
      BigInt(row.completed_receipt) < BigInt(row.settled_receipt)
    )
  )
    throw new RetainedSanketRefused('sanket_source_conflict');
  return {
    data: output,
    invocation: {
      runId: row.run_id,
      correlationId: input.correlation_id,
      requestHash: row.input_hash,
      responseHash: row.output_hash,
    },
    outputProof: {
      kind: 'settled_output_recorded' as const,
      tenantId,
      actorId,
      operationKey: input.correlation_id,
      runId: row.run_id,
      requestHash: row.input_hash,
      responseHash: row.output_hash,
      requestedReceipt: row.requested_receipt,
      startedReceipt: row.started_receipt,
      completedReceipt: row.completed_receipt,
      settledReceipt: row.settled_receipt,
    },
  };
}
