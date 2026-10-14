/** Unmounted pure consumer codecs. Expected witness comes from an independent
 * scoped controller read, never the incoming result body. No custody or release
 * authority is created here; raw runtime business bytes are preserved.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '@axiom/ledger';
import {
  modelAccountingBindingSchema,
  modelAccountingSealSchema,
  legacyAccountingProjection,
} from '@axiom/types';
import { verifyRetainedModelAccountingSeal } from './model-call-accounting.js';
import { parsePrativedanAssessmentJson } from './prativedan-assessment-json.js';

export class AccountedResultRefused extends Error {
  constructor() {
    super('accounted_result_contract_refused');
  }
}

export function parseAccountedOutputText(text: string): Record<string, unknown> {
  try {
    const bytes = Buffer.from(text, 'utf8');
    if (!text || text.includes('\0') || bytes.length > 1048576 || bytes.toString('utf8') !== text)
      throw new AccountedResultRefused();
    const output: unknown = parsePrativedanAssessmentJson(text);
    if (!output || typeof output !== 'object' || Array.isArray(output))
      throw new AccountedResultRefused();
    const pending: { value: unknown; depth: number }[] = [{ value: output, depth: 0 }];
    let count = 0;
    while (pending.length) {
      const { value, depth } = pending.pop()!;
      if (++count > 100000 || depth > 40) throw new AccountedResultRefused();
      if (Array.isArray(value)) pending.push(...value.map((v) => ({ value: v, depth: depth + 1 })));
      else if (value && typeof value === 'object') {
        for (const [key, v] of Object.entries(value)) {
          if (key.includes('\0') || Buffer.from(key, 'utf8').toString('utf8') !== key)
            throw new AccountedResultRefused();
          pending.push({ value: v, depth: depth + 1 });
        }
      } else if (
        typeof value === 'string' &&
        (value.includes('\0') || Buffer.from(value, 'utf8').toString('utf8') !== value)
      )
        throw new AccountedResultRefused();
    }
    return output as Record<string, unknown>;
  } catch {
    throw new AccountedResultRefused();
  }
}

const receipt = modelAccountingSealSchema.shape.requested_receipt;
const tokens = z.number().int().min(0).max(2147483647).nullable();
export const accountedAgentResultSchema = z
  .strictObject({
    ...modelAccountingBindingSchema.shape,
    kind: z.literal('accounted_agent_result'),
    status: z.enum(['succeeded', 'failed']),
    latency_ms: z.number().int().min(0).max(2147483647),
    input_tokens: tokens,
    output_tokens: tokens,
    cost_usd: z
      .string()
      .regex(/^(?:0|[1-9][0-9]{0,3})\.[0-9]{6}$/)
      .nullable(),
    error: z
      .string()
      .regex(/^[a-z0-9_]{1,80}$/)
      .nullable(),
    runtime_output_text: z.string().max(1048576).nullable(),
    ledger_entry_ids: z.tuple([receipt.shape.id, receipt.shape.id]),
    accounting_reference: z.strictObject({
      calls_sha256: modelAccountingSealSchema.shape.calls_sha256,
      receipt,
    }),
  })
  .superRefine((v, ctx) => {
    if (v.ledger_entry_ids[0] === v.ledger_entry_ids[1])
      ctx.addIssue({ code: 'custom', message: 'Duplicate terminal receipts' });
    if (
      v.status === 'succeeded'
        ? v.error !== null || v.runtime_output_text === null
        : v.error === null || v.runtime_output_text !== null
    )
      ctx.addIssue({ code: 'custom', message: 'Contradictory result' });
    if (v.runtime_output_text !== null) {
      try {
        parseAccountedOutputText(v.runtime_output_text);
      } catch {
        ctx.addIssue({ code: 'custom', message: 'Business output contract refused' });
      }
    }
  });
export type AccountedAgentResult = z.infer<typeof accountedAgentResultSchema>;

const expectedResultSchema = z.strictObject({
  binding: modelAccountingBindingSchema,
  seal: modelAccountingSealSchema,
  terminalStatus: z.enum(['succeeded', 'failed']),
  runtimeOutputSha256: modelAccountingSealSchema.shape.calls_sha256.nullable(),
});

export function verifyAccountedAgentResult(
  value: unknown,
  expected: unknown,
): {
  result: AccountedAgentResult;
  output: Record<string, unknown> | null;
  accounting_status: 'sealed_observed_journal';
} {
  try {
    const witness = expectedResultSchema.parse(expected);
    if ((witness.terminalStatus === 'succeeded') !== (witness.runtimeOutputSha256 !== null))
      throw new AccountedResultRefused();
    const result = accountedAgentResultSchema.parse(value);
    const seal = verifyRetainedModelAccountingSeal(witness.seal, {
      binding: witness.binding,
      requestedReceipt: witness.seal.requested_receipt,
      agentStartedReceipt: witness.seal.agent_started_receipt,
      agentCompletedReceipt: witness.seal.agent_completed_receipt,
    });
    const binding = modelAccountingBindingSchema.parse(
      Object.fromEntries(
        Object.keys(modelAccountingBindingSchema.shape).map((key) => [
          key,
          result[key as keyof AccountedAgentResult],
        ]),
      ),
    );
    if (
      canonicalJson(binding) !== canonicalJson(witness.binding) ||
      result.status !== witness.terminalStatus ||
      result.accounting_reference.calls_sha256 !== seal.calls_sha256 ||
      canonicalJson(result.accounting_reference.receipt) !==
        canonicalJson(seal.accounting_receipt) ||
      result.ledger_entry_ids[0] !== seal.agent_started_receipt.id ||
      result.ledger_entry_ids[1] !== seal.agent_completed_receipt.id
    )
      throw new AccountedResultRefused();
    const metrics = legacyAccountingProjection(seal.summary);
    if (
      result.input_tokens !== metrics.input_tokens ||
      result.output_tokens !== metrics.output_tokens ||
      result.cost_usd !== metrics.cost_usd
    )
      throw new AccountedResultRefused();
    let output: Record<string, unknown> | null = null;
    if (result.runtime_output_text !== null) {
      if (
        createHash('sha256').update(result.runtime_output_text, 'utf8').digest('hex') !==
        witness.runtimeOutputSha256
      )
        throw new AccountedResultRefused();
      output = parseAccountedOutputText(result.runtime_output_text);
    }
    return { result, output, accounting_status: 'sealed_observed_journal' };
  } catch {
    throw new AccountedResultRefused();
  }
}

/** Historical scalar zero/null values remain readable and explicitly unverified.
 * This codec has no no_model basis and cannot be upgraded by a caller flag.
 */
export const legacyAccountingViewSchema = z.object({
  input_tokens: tokens,
  output_tokens: tokens,
  total_tokens: tokens,
  cost_usd: z.number().min(0).max(9999.999999).nullable(),
  accounting_status: z.literal('legacy_unverified').default('legacy_unverified'),
});
