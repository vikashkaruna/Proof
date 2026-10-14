import { z } from 'zod';
import { AgentName } from './enums';

/** Unmounted metadata-only accounting. Parsing is neither journal authority nor
 * model invocation permission. Legacy scalar zeros are not a no-model proof. */
// Mirror canonical nonnil durable PostgreSQL UUIDs without a new version restriction.
const uuid = z
  .string()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)
  .length(36)
  .refine((v) => v !== '00000000-0000-0000-0000-000000000000');
const hash = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/);
const identity = z
  .string()
  .max(300)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,299}$/)
  .refine((v) => v === v.trim());
const tokens = z.number().int().min(0).max(2147483647);
const aggregateTokens = z.number().int().min(0).max(2147483647000);
// Decimal strings retain tiny positive estimates without a float roundtrip.
// Up to 324 decimal places covers bounded finite binary64 gateway estimates.
const decimal = z
  .string()
  .max(335)
  .regex(/^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{0,323}[1-9])?$/)
  .refine((v) => v === v.trim());
const provider = z.enum([
  'self_hosted',
  'bedrock',
  'anthropic_api',
  'anthropic',
  'openai',
  'gemini',
  'fallback_chain',
]);
const route = z.strictObject({ provider, model: identity });
const startShape = {
  schema_version: z.literal(2),
  tenant_id: uuid,
  run_id: uuid,
  correlation_id: uuid,
  request_sha256: hash,
  agent: z.enum(AgentName),
  agent_version: identity,
  call_id: uuid,
  request_json_sha256: hash,
  request_json_basis: z.literal('canonical_decoded_request_not_http_wire'),
  template_sha256: hash,
  model_selector: identity,
  task: z.enum([
    'structural',
    'reasoning',
    'embedding',
    'classification',
    'summarisation',
    'report',
  ]),
};
export const modelCallStartSchema = z.strictObject(startShape);
export type ModelCallStart = z.infer<typeof modelCallStartSchema>;

export const modelCallOutcomeSchema = z
  .strictObject({
    ...startShape,
    state: z.enum(['completed', 'failed', 'cancelled', 'uncertain']),
    failure_code: z
      .enum([
        'gateway_unavailable',
        'current_authority_refused',
        'gateway_response_invalid',
        'invocation_cancelled',
        'transport_uncertain',
      ])
      .nullable(),
    content_sha256: hash.nullable(),
    planned: route.nullable(),
    serving: z
      .strictObject({ provider, model: identity, reported_model: identity.nullable() })
      .nullable(),
    commitments: z
      .strictObject({
        composed_sha256: hash,
        transport_prompt_sha256: hash,
        sdk_handoff_sha256: hash,
        basis: z.literal('sdk_handoff_not_http_wire'),
      })
      .nullable(),
    attempts: z
      .array(
        z.strictObject({ provider, model: identity, outcome: z.enum(['failed', 'succeeded']) }),
      )
      .min(1)
      .max(3)
      .nullable(),
    usage: z.strictObject({
      availability: z.enum(['reported', 'unavailable']),
      input_tokens: tokens.nullable(),
      output_tokens: tokens.nullable(),
      total_tokens: tokens.nullable(),
    }),
    pricing: z.strictObject({
      basis: z.enum(['configuration_estimate', 'unavailable']),
      scope: z.literal('successful_response_only'),
      config_sha256: hash.nullable(),
      estimate_usd: decimal.nullable(),
    }),
  })
  .superRefine((v, ctx) => {
    const reject = () =>
      ctx.addIssue({ code: 'custom', message: 'Inconsistent model observation' });
    const u = v.usage;
    if (u.availability === 'reported') {
      if (
        u.input_tokens === null ||
        u.output_tokens === null ||
        u.total_tokens !== u.input_tokens + u.output_tokens ||
        u.total_tokens > 2147483647
      )
        reject();
    } else if (u.input_tokens !== null || u.output_tokens !== null || u.total_tokens !== null)
      reject();
    const p = v.pricing;
    if (p.basis === 'configuration_estimate') {
      if (
        p.config_sha256 === null ||
        p.estimate_usd === null ||
        u.availability !== 'reported' ||
        (decimal.safeParse(p.estimate_usd).success &&
          compareDecimal(p.estimate_usd, '9999.999999') > 0)
      )
        reject();
    } else if (p.estimate_usd !== null) reject();
    if (v.state === 'completed') {
      const last = v.attempts?.at(-1);
      if (
        v.failure_code !== null ||
        v.content_sha256 === null ||
        v.planned === null ||
        v.serving === null ||
        v.commitments === null ||
        !last ||
        last.outcome !== 'succeeded' ||
        last.provider !== v.serving.provider ||
        last.model !== v.serving.model ||
        v.attempts?.slice(0, -1).some((a) => a.outcome !== 'failed')
      )
        reject();
      // Exact configured bare model IDs are valid. Ownership is verified by
      // the gateway's configured authority, never guessed from a prefix.
      if (
        v.serving &&
        !['self_hosted', 'anthropic', 'openai', 'gemini'].includes(v.serving.provider)
      )
        reject();
    } else {
      if (
        v.failure_code === null ||
        v.content_sha256 !== null ||
        v.planned !== null ||
        v.serving !== null ||
        v.commitments !== null ||
        v.attempts !== null ||
        u.availability !== 'unavailable' ||
        p.basis !== 'unavailable' ||
        p.config_sha256 !== null
      )
        reject();
      if (
        (v.state === 'cancelled') !== (v.failure_code === 'invocation_cancelled') ||
        (v.state === 'uncertain') !== (v.failure_code === 'transport_uncertain')
      )
        reject();
    }
  });
export type ModelCallOutcome = z.infer<typeof modelCallOutcomeSchema>;

export const modelAccountingSummarySchema = z
  .strictObject({
    schema_version: z.literal(2),
    basis: z.enum(['no_model', 'all_known', 'known_partial', 'unknown']),
    call_count: z.number().int().min(0).max(1000),
    known_usage_call_count: z.number().int().min(0).max(1000),
    known_estimate_call_count: z.number().int().min(0).max(1000),
    unknown_attempt_usage: z.boolean(),
    input_tokens: aggregateTokens.nullable(),
    output_tokens: aggregateTokens.nullable(),
    total_tokens: aggregateTokens.nullable(),
    estimate_usd: decimal.nullable(),
    known_input_tokens: aggregateTokens,
    known_output_tokens: aggregateTokens,
    known_total_tokens: aggregateTokens,
    known_estimate_usd: decimal,
  })
  .superRefine((v, ctx) => {
    const refuse = () =>
      ctx.addIssue({ code: 'custom', message: 'Inconsistent accounting summary' });
    if (
      ![v.call_count, v.known_usage_call_count, v.known_estimate_call_count].every(
        (n) => Number.isInteger(n) && n >= 0 && n <= 1000,
      )
    ) {
      refuse();
      return;
    }
    if (
      v.known_usage_call_count > v.call_count ||
      v.known_estimate_call_count > v.known_usage_call_count ||
      v.known_total_tokens !== v.known_input_tokens + v.known_output_tokens ||
      v.known_total_tokens > v.known_usage_call_count * 2147483647
    )
      refuse();
    if (
      (v.known_usage_call_count === 0 &&
        (v.known_input_tokens !== 0 || v.known_output_tokens !== 0)) ||
      (v.known_estimate_call_count === 0 && v.known_estimate_usd !== '0') ||
      (decimal.safeParse(v.known_estimate_usd).success &&
        compareDecimal(
          v.known_estimate_usd,
          sumDecimal(Array<string>(v.known_estimate_call_count).fill('9999.999999')),
        ) > 0)
    )
      refuse();
    const usageKnown = !v.unknown_attempt_usage && v.known_usage_call_count === v.call_count;
    const priceKnown = !v.unknown_attempt_usage && v.known_estimate_call_count === v.call_count;
    if (
      usageKnown
        ? v.input_tokens !== v.known_input_tokens ||
          v.output_tokens !== v.known_output_tokens ||
          v.total_tokens !== v.known_total_tokens
        : v.input_tokens !== null || v.output_tokens !== null || v.total_tokens !== null
    )
      refuse();
    if (priceKnown ? v.estimate_usd !== v.known_estimate_usd : v.estimate_usd !== null) refuse();
    const basis =
      v.call_count === 0
        ? 'no_model'
        : usageKnown && priceKnown
          ? 'all_known'
          : v.known_usage_call_count > 0 || v.known_estimate_call_count > 0
            ? 'known_partial'
            : 'unknown';
    if (
      v.basis !== basis ||
      (v.call_count === 0 &&
        (v.unknown_attempt_usage || v.known_total_tokens !== 0 || v.known_estimate_usd !== '0'))
    )
      refuse();
  });
export type ModelAccountingSummary = z.infer<typeof modelAccountingSummarySchema>;

function decimalParts(value: string): { units: bigint; scale: number } {
  const [whole, fraction = ''] = value.split('.');
  return { units: BigInt(`${whole}${fraction}`), scale: fraction.length };
}
function compareDecimal(a: string, b: string): number {
  const left = decimalParts(a),
    right = decimalParts(b),
    scale = Math.max(left.scale, right.scale);
  const difference =
    left.units * 10n ** BigInt(scale - left.scale) -
    right.units * 10n ** BigInt(scale - right.scale);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
function sumDecimal(values: string[]): string {
  const parts = values.map(decimalParts),
    scale = Math.max(0, ...parts.map((p) => p.scale));
  const sum = parts.reduce((n, p) => n + p.units * 10n ** BigInt(scale - p.scale), 0n);
  if (scale === 0) return sum.toString();
  const digits = sum.toString().padStart(scale + 1, '0');
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/0+$/, '').replace(/\.$/, '');
}
/** Provisional arithmetic ONLY. Even an empty array cannot prove that no calls
 * occurred: a controller must independently read the immutable sealed observed
 * callset, binding, exact byte/hash commitment and actual seal ledger receipt.
 * This function intentionally exposes no verified flag or receipt authority. */
export function deriveModelAccounting(values: unknown[]): ModelAccountingSummary {
  if (values.length > 1000) throw new Error('Accounting callset bound exceeded');
  const calls = values.map((v) => modelCallOutcomeSchema.parse(v));
  const first = calls[0];
  if (
    new Set(calls.map((v) => v.call_id)).size !== calls.length ||
    (first &&
      calls.some(
        (v) =>
          v.tenant_id !== first.tenant_id ||
          v.run_id !== first.run_id ||
          v.correlation_id !== first.correlation_id ||
          v.request_sha256 !== first.request_sha256 ||
          v.agent !== first.agent ||
          v.agent_version !== first.agent_version,
      ))
  )
    throw new Error('Accounting invocation binding refused');
  const usage = calls.filter((v) => v.usage.availability === 'reported');
  const priced = calls.filter((v) => v.pricing.basis === 'configuration_estimate');
  const unknown = calls.some((v) => v.state !== 'completed' || (v.attempts?.length ?? 0) > 1);
  const input = usage.reduce((n, v) => n + (v.usage.input_tokens ?? 0), 0);
  const output = usage.reduce((n, v) => n + (v.usage.output_tokens ?? 0), 0);
  const cost = sumDecimal(priced.map((v) => v.pricing.estimate_usd!));
  const usageKnown = !unknown && usage.length === calls.length,
    priceKnown = !unknown && priced.length === calls.length;
  return modelAccountingSummarySchema.parse({
    schema_version: 2,
    basis:
      calls.length === 0
        ? 'no_model'
        : usageKnown && priceKnown
          ? 'all_known'
          : usage.length || priced.length
            ? 'known_partial'
            : 'unknown',
    call_count: calls.length,
    known_usage_call_count: usage.length,
    known_estimate_call_count: priced.length,
    unknown_attempt_usage: unknown,
    input_tokens: usageKnown ? input : null,
    output_tokens: usageKnown ? output : null,
    total_tokens: usageKnown ? input + output : null,
    estimate_usd: priceKnown ? cost : null,
    known_input_tokens: input,
    known_output_tokens: output,
    known_total_tokens: input + output,
    known_estimate_usd: cost,
  });
}
/** Rounded compatibility is not the retained exact estimate and not an invoice.
 * Unknown aggregates remain null; overflow refuses, never clamps or relabels. */
export function legacyAccountingProjection(value: unknown): {
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: string | null;
} {
  const v = modelAccountingSummarySchema.parse(value);
  if ((v.total_tokens ?? 0) > 2147483647) throw new Error('Legacy token projection overflow');
  let cost: string | null = null;
  if (v.estimate_usd !== null) {
    const p = decimalParts(v.estimate_usd);
    const divisor = 10n ** BigInt(Math.max(0, p.scale - 6));
    const rounded =
      p.scale <= 6 ? p.units * 10n ** BigInt(6 - p.scale) : (p.units + divisor / 2n) / divisor;
    if (rounded > 9999999999n) throw new Error('Legacy cost projection overflow');
    const digits = rounded.toString().padStart(7, '0');
    cost = `${digits.slice(0, -6)}.${digits.slice(-6)}`;
  }
  return { input_tokens: v.input_tokens, output_tokens: v.output_tokens, cost_usd: cost };
}

export const modelAccountingBindingSchema = z.strictObject({
  schema_version: z.literal(2),
  tenant_id: uuid,
  run_id: uuid,
  correlation_id: uuid,
  request_sha256: hash,
  agent: z.enum(AgentName),
  agent_version: identity,
});
export type ModelAccountingBinding = z.infer<typeof modelAccountingBindingSchema>;

const receipt = z.strictObject({
  id: z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/)
    .refine((v) => /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n),
  entry_hash: hash,
});
/** Shape only: the future trusted store must independently load actual receipts,
 * rehash original PostgreSQL UTF-8 calls_text and derive the exact summary from
 * that immutable observed callset. Caller-supplied matching hashes are no proof. */
export const modelAccountingSealSchema = z
  .strictObject({
    schema_version: z.literal(2),
    tenant_id: uuid,
    run_id: uuid,
    correlation_id: uuid,
    request_sha256: hash,
    agent: z.enum(AgentName),
    agent_version: identity,
    serialization: z.literal('postgres-jsonb-text-v1'),
    calls_text: z
      .string()
      .min(2)
      .max(8388608)
      .refine(
        (v) =>
          !v.includes('\0') &&
          !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v) &&
          new TextEncoder().encode(v).length <= 8388608,
      ),
    calls_sha256: hash,
    summary: modelAccountingSummarySchema,
    requested_receipt: receipt,
    agent_started_receipt: receipt,
    agent_completed_receipt: receipt,
    accounting_receipt: receipt,
  })
  .superRefine((v, ctx) => {
    const ids = [
      v.requested_receipt.id,
      v.agent_started_receipt.id,
      v.agent_completed_receipt.id,
      v.accounting_receipt.id,
    ];
    if (
      ids.some((id) => !/^[1-9][0-9]{0,18}$/.test(id)) ||
      ids.some((id, i) => i > 0 && BigInt(ids[i - 1]!) >= BigInt(id))
    )
      ctx.addIssue({ code: 'custom', message: 'Unordered accounting proof receipts' });
  });
export type ModelAccountingSeal = z.infer<typeof modelAccountingSealSchema>;
