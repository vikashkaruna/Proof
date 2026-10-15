import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveModelAccounting, legacyAccountingProjection } from '@axiom/types';
import {
  accountedAgentResultSchema,
  legacyAccountingViewSchema,
  verifyAccountedAgentResult,
} from './accounted-agent-result.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const uid = (n: number) => `10000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const binding = {
  schema_version: 2,
  tenant_id: uid(1),
  run_id: uid(2),
  correlation_id: uid(3),
  request_sha256: 'a'.repeat(64),
  agent: 'sudhaar',
  agent_version: '0.1.0',
};
const receipt = (id: string) => ({ id, entry_hash: hash(id) });
function observed() {
  return {
    ...binding,
    call_id: uid(11),
    request_json_sha256: 'b'.repeat(64),
    request_json_basis: 'canonical_decoded_request_not_http_wire',
    template_sha256: 'c'.repeat(64),
    model_selector: 'fast',
    task: 'reasoning',
    state: 'completed',
    failure_code: null,
    content_sha256: 'd'.repeat(64),
    planned: { provider: 'self_hosted', model: 'qwen/Qwen3' },
    serving: { provider: 'self_hosted', model: 'qwen/Qwen3', reported_model: null },
    commitments: {
      composed_sha256: 'e'.repeat(64),
      transport_prompt_sha256: 'f'.repeat(64),
      sdk_handoff_sha256: '1'.repeat(64),
      basis: 'sdk_handoff_not_http_wire',
    },
    attempts: [{ provider: 'self_hosted', model: 'qwen/Qwen3', outcome: 'succeeded' }],
    usage: { availability: 'reported', input_tokens: 4, output_tokens: 6, total_tokens: 10 },
    pricing: {
      basis: 'configuration_estimate',
      scope: 'successful_response_only',
      config_sha256: '2'.repeat(64),
      estimate_usd: '0.000000000001',
    },
  };
}
function fixture(calls: unknown[] = [], failure = false) {
  const text = failure ? null : '{"inventory": [], "score": 3.0}';
  const callsText = JSON.stringify(calls);
  const summary = deriveModelAccounting(calls);
  const seal = {
    ...binding,
    serialization: 'postgres-jsonb-text-v1',
    calls_text: callsText,
    calls_sha256: hash(callsText),
    summary,
    requested_receipt: receipt('1'),
    agent_started_receipt: receipt('2'),
    agent_completed_receipt: receipt('5'),
    accounting_receipt: receipt('6'),
  };
  const value = {
    ...binding,
    kind: 'accounted_agent_result',
    status: failure ? 'failed' : 'succeeded',
    latency_ms: 1,
    ...legacyAccountingProjection(summary),
    error: failure ? 'agent_failed' : null,
    runtime_output_text: text,
    ledger_entry_ids: ['2', '5'],
    accounting_reference: { calls_sha256: seal.calls_sha256, receipt: seal.accounting_receipt },
  };
  return {
    value,
    expected: {
      binding,
      seal,
      terminalStatus: failure ? 'failed' : 'succeeded',
      runtimeOutputSha256: text === null ? null : hash(text),
    },
  };
}

/** Pure synthetic witnesses are neither persisted receipts nor peer authority. */
describe('accounted result consumer contract', () => {
  it('retains unknown-success nullable metrics and original business JSON bytes', () => {
    const call = {
      ...observed(),
      usage: {
        availability: 'unavailable',
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
      },
      pricing: {
        basis: 'unavailable',
        scope: 'successful_response_only',
        config_sha256: null,
        estimate_usd: null,
      },
    };
    const { value, expected } = fixture([call]);
    const parsed = verifyAccountedAgentResult(value, expected);
    expect([
      parsed.result.input_tokens,
      parsed.result.output_tokens,
      parsed.result.cost_usd,
    ]).toEqual([null, null, null]);
    expect(parsed.result.runtime_output_text).toBe('{"inventory": [], "score": 3.0}');
    expect(parsed.output).toEqual({ inventory: [], score: 3 });
  });
  it('never derives no_model from a rounded zero projection', () => {
    for (const calls of [[], [observed()]]) {
      const { value, expected } = fixture(calls);
      expect(verifyAccountedAgentResult(value, expected).result.cost_usd).toBe('0.000000');
      expect(expected.seal.summary.basis).toBe(calls.length ? 'all_known' : 'no_model');
    }
  });
  it.each([
    ['tenant_id', uid(99)],
    ['run_id', uid(99)],
    ['correlation_id', uid(99)],
    ['request_sha256', '9'.repeat(64)],
    ['agent_version', '0.2.0'],
    ['status', 'failed'],
    ['runtime_output_text', '{"score":3,"inventory":[]}'],
    ['ledger_entry_ids', ['2', '7']],
    ['cost_usd', '0.000001'],
    ['input_tokens', 0],
  ])('refuses %s substitution against an independently expected witness', (key, replacement) => {
    const { value, expected } = fixture([observed()]);
    expect(() =>
      verifyAccountedAgentResult({ ...value, [String(key)]: replacement }, expected),
    ).toThrow('accounted_result_contract_refused');
  });
  it.each(['calls_sha256', 'receipt'])('requires actual %s reference', (key) => {
    const { value, expected } = fixture();
    expect(() =>
      verifyAccountedAgentResult(
        {
          ...value,
          accounting_reference: {
            ...value.accounting_reference,
            [key]:
              key === 'calls_sha256' ? '9'.repeat(64) : { id: '6', entry_hash: '9'.repeat(64) },
          },
        },
        expected,
      ),
    ).toThrow('accounted_result_contract_refused');
  });
  it.each([
    '{"x":1,"x":1}',
    '{"x":NaN}',
    '{"x":9007199254740992}',
    '[]',
    '{"x":0.100000000000000005}',
    '{"x":"\\u0000"}',
  ])('matching hash cannot make malformed business output valid: %s', (text) => {
    const { value, expected } = fixture();
    expect(() =>
      verifyAccountedAgentResult(
        { ...value, runtime_output_text: text },
        { ...expected, runtimeOutputSha256: hash(text) },
      ),
    ).toThrow('accounted_result_contract_refused');
  });
  it('keeps historical scalar zero/null readable and unverified', () => {
    for (const count of [0, null]) {
      const value = legacyAccountingViewSchema.parse({
        input_tokens: count,
        output_tokens: count,
        total_tokens: count,
        cost_usd: count,
      });
      expect(value.accounting_status).toBe('legacy_unverified');
      expect(Object.values(value)).not.toContain('no_model');
    }
    expect(
      legacyAccountingViewSchema.safeParse({
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        cost_usd: 0,
        accounting_status: 'sealed_observed_journal',
      }).success,
    ).toBe(false);
  });
  it('parsing a self-declared envelope alone provides no verified accounting flag', () => {
    const { value } = fixture();
    const parsed = accountedAgentResultSchema.parse(value);
    expect(parsed).not.toHaveProperty('accounting_status');
    expect(parsed).not.toHaveProperty('verified');
  });
  it('failed status cannot carry a client-visible business output', () => {
    const { value, expected } = fixture([], true);
    expect(verifyAccountedAgentResult(value, expected).output).toBeNull();
    expect(() =>
      verifyAccountedAgentResult({ ...value, runtime_output_text: '{}' }, expected),
    ).toThrow('accounted_result_contract_refused');
  });
});
