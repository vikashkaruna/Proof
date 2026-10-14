/** Unmounted pure verifier. A caller-provided matching packet is not authority.
 * The controller must independently read the frozen journal and real original
 * ledger receipts through its scoped custody RPCs before calling this function.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '@axiom/ledger';
import {
  deriveModelAccounting,
  modelAccountingBindingSchema,
  modelAccountingSealSchema,
  modelCallOutcomeSchema,
  type ModelAccountingSeal,
} from '@axiom/types';
import { parsePrativedanAssessmentJson } from './prativedan-assessment-json.js';

export class ModelAccountingRefused extends Error {
  constructor() {
    super('model_accounting_contract_refused');
  }
}

export function verifyRetainedModelAccountingSeal(
  value: unknown,
  expected: {
    binding: unknown;
    requestedReceipt: unknown;
    agentStartedReceipt: unknown;
    agentCompletedReceipt: unknown;
  },
): ModelAccountingSeal {
  try {
    const seal = modelAccountingSealSchema.parse(value);
    const binding = modelAccountingBindingSchema.parse(expected.binding);
    const actualBinding = modelAccountingBindingSchema.parse(
      Object.fromEntries(
        Object.keys(modelAccountingBindingSchema.shape).map((key) => [
          key,
          seal[key as keyof ModelAccountingSeal],
        ]),
      ),
    );
    const receipt = modelAccountingSealSchema.shape.requested_receipt;
    if (
      canonicalJson(actualBinding) !== canonicalJson(binding) ||
      canonicalJson(receipt.parse(expected.requestedReceipt)) !==
        canonicalJson(seal.requested_receipt) ||
      canonicalJson(receipt.parse(expected.agentStartedReceipt)) !==
        canonicalJson(seal.agent_started_receipt) ||
      canonicalJson(receipt.parse(expected.agentCompletedReceipt)) !==
        canonicalJson(seal.agent_completed_receipt)
    )
      throw new ModelAccountingRefused();
    const bytes = Buffer.from(seal.calls_text, 'utf8');
    if (
      bytes.toString('utf8') !== seal.calls_text ||
      createHash('sha256').update(bytes).digest('hex') !== seal.calls_sha256
    )
      throw new ModelAccountingRefused();
    const calls: unknown = parsePrativedanAssessmentJson(seal.calls_text);
    if (!Array.isArray(calls) || calls.length > 1000) throw new ModelAccountingRefused();
    for (const value of calls) {
      const call = modelCallOutcomeSchema.parse(value);
      const actual = modelAccountingBindingSchema.parse(
        Object.fromEntries(
          Object.keys(modelAccountingBindingSchema.shape).map((key) => [
            key,
            call[key as keyof typeof call],
          ]),
        ),
      );
      if (canonicalJson(actual) !== canonicalJson(binding)) throw new ModelAccountingRefused();
    }
    if (canonicalJson(deriveModelAccounting(calls)) !== canonicalJson(seal.summary))
      throw new ModelAccountingRefused();
    return seal;
  } catch {
    throw new ModelAccountingRefused();
  }
}
