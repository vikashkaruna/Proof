import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveModelAccounting } from '@axiom/types';
import { verifyRetainedModelAccountingSeal } from './model-call-accounting.js';

const uid = (n: number) => `10000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const receipt = (id: string) => ({ id, entry_hash: hash(id) });
const binding = {
  schema_version: 2,
  tenant_id: uid(1),
  run_id: uid(2),
  correlation_id: uid(3),
  request_sha256: 'a'.repeat(64),
  agent: 'drishti',
  agent_version: '0.1.0',
};
const expected = {
  binding,
  requestedReceipt: receipt('1'),
  agentStartedReceipt: receipt('2'),
  agentCompletedReceipt: receipt('5'),
};
function seal() {
  return {
    ...binding,
    serialization: 'postgres-jsonb-text-v1',
    calls_text: '[]',
    calls_sha256: hash('[]'),
    summary: deriveModelAccounting([]),
    requested_receipt: receipt('1'),
    agent_started_receipt: receipt('2'),
    agent_completed_receipt: receipt('5'),
    accounting_receipt: receipt('6'),
  };
}

/** Synthetic codec tests: caller-supplied packets cannot prove actual authority. */
describe('retained model accounting verifier', () => {
  it('accepts an internally consistent empty journal with independently expected receipt identities', () => {
    expect(verifyRetainedModelAccountingSeal(seal(), expected).summary.basis).toBe('no_model');
  });
  it.each([
    ['tenant_id', uid(7)],
    ['run_id', uid(7)],
    ['correlation_id', uid(7)],
    ['request_sha256', 'b'.repeat(64)],
    ['agent_version', '0.2.0'],
    ['agent', 'sudhaar'],
  ])('refuses substituted %s even for empty callset', (field, value) => {
    expect(() =>
      verifyRetainedModelAccountingSeal({ ...seal(), [field]: value }, expected),
    ).toThrow('model_accounting_contract_refused');
  });
  it.each(['requested_receipt', 'agent_started_receipt', 'agent_completed_receipt'])(
    'refuses recomputed %s hashes',
    (field) => {
      const v = seal();
      expect(() =>
        verifyRetainedModelAccountingSeal(
          {
            ...v,
            [field]: {
              ...v[
                field as 'requested_receipt' | 'agent_started_receipt' | 'agent_completed_receipt'
              ],
              entry_hash: 'c'.repeat(64),
            },
          },
          expected,
        ),
      ).toThrow('model_accounting_contract_refused');
    },
  );
  it('refuses a correct byte hash committing duplicated decoded keys', () => {
    const calls = '[{"tenant_id":"a","tenant_id":"b"}]';
    expect(() =>
      verifyRetainedModelAccountingSeal(
        { ...seal(), calls_text: calls, calls_sha256: hash(calls) },
        expected,
      ),
    ).toThrow('model_accounting_contract_refused');
  });
  it('refuses changed whitespace bytes without matching retained commitment', () => {
    expect(() =>
      verifyRetainedModelAccountingSeal({ ...seal(), calls_text: '[] ' }, expected),
    ).toThrow('model_accounting_contract_refused');
  });
  it('refuses fabricated unknown accounting summary and emits no secret values', () => {
    const v = { ...seal(), calls_text: 'sensitive-canary@example.invalid' };
    let error: unknown;
    try {
      verifyRetainedModelAccountingSeal(v, expected);
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toBe('Error: model_accounting_contract_refused');
    expect(() =>
      verifyRetainedModelAccountingSeal(
        { ...seal(), summary: { ...seal().summary, basis: 'unknown' } },
        expected,
      ),
    ).toThrow('model_accounting_contract_refused');
  });
});
