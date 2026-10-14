import { describe, expect, it } from 'vitest';
import {
  type ModelCallOutcome,
  modelAccountingSealSchema,
  modelCallStartSchema,
  modelCallOutcomeSchema,
  deriveModelAccounting,
  modelAccountingSummarySchema,
  legacyAccountingProjection,
} from './model-call-accounting';

// Synthetic metadata only; these tests do not establish database receipt authority.
const uuid = (n: number) => `10000000-0000-0000-0000-${n.toString().padStart(12, '0')}`;
const start = (n = 1) => ({
  schema_version: 2 as const,
  tenant_id: uuid(1),
  run_id: uuid(2),
  correlation_id: uuid(3),
  request_sha256: 'a'.repeat(64),
  agent: 'sudhaar' as const,
  agent_version: '0.1.0',
  call_id: uuid(10 + n),
  request_json_sha256: 'b'.repeat(64),
  request_json_basis: 'canonical_decoded_request_not_http_wire' as const,
  template_sha256: 'c'.repeat(64),
  model_selector: 'fast',
  task: 'reasoning' as const,
});
const outcome = (n = 1): ModelCallOutcome => ({
  ...start(n),
  state: 'completed' as const,
  failure_code: null,
  content_sha256: 'd'.repeat(64),
  planned: { provider: 'self_hosted' as const, model: 'qwen/Qwen3' },
  serving: { provider: 'self_hosted' as const, model: 'qwen/Qwen3', reported_model: null },
  commitments: {
    composed_sha256: 'e'.repeat(64),
    transport_prompt_sha256: 'f'.repeat(64),
    sdk_handoff_sha256: '1'.repeat(64),
    basis: 'sdk_handoff_not_http_wire' as const,
  },
  attempts: [
    { provider: 'self_hosted' as const, model: 'qwen/Qwen3', outcome: 'succeeded' as const },
  ],
  usage: { availability: 'reported' as const, input_tokens: 4, output_tokens: 6, total_tokens: 10 },
  pricing: {
    basis: 'configuration_estimate' as const,
    scope: 'successful_response_only' as const,
    config_sha256: '2'.repeat(64),
    estimate_usd: '0.000000000001',
  },
});
const failed = (n = 1) => ({
  ...start(n),
  state: 'failed' as const,
  failure_code: 'gateway_unavailable' as const,
  content_sha256: null,
  planned: null,
  serving: null,
  commitments: null,
  attempts: null,
  usage: {
    availability: 'unavailable' as const,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
  },
  pricing: {
    basis: 'unavailable' as const,
    scope: 'successful_response_only' as const,
    config_sha256: null,
    estimate_usd: null,
  },
});

describe('unmounted model accounting contracts', () => {
  it('standalone empty arithmetic has no receipt or invocation authority', () => {
    const provisional = deriveModelAccounting([]);
    expect(provisional).not.toHaveProperty('seal_receipt');
    expect(provisional).not.toHaveProperty('callset_sha256');
    expect(provisional).not.toHaveProperty('verified');
  });
  it('refuses absent/foreign-format tenant before model defaults', () => {
    for (const tenant_id of [
      undefined,
      '',
      uuid(1).toUpperCase().replace('100', 'ABC'),
      '00000000-0000-0000-0000-000000000000',
    ]) {
      expect(modelCallStartSchema.safeParse({ ...start(), tenant_id }).success).toBe(false);
    }
  });
  it('rejects trailing-newline identities and digest/domain values', () => {
    for (const patch of [
      { model_selector: 'fast\n' },
      { tenant_id: uuid(1) + '\n' },
      { request_sha256: 'a'.repeat(64) + '\n' },
    ]) {
      expect(modelCallStartSchema.safeParse({ ...start(), ...patch }).success).toBe(false);
    }
  });
  it('does not accept raw payloads or unsafe model selectors', () => {
    expect(modelCallStartSchema.safeParse({ ...start(), prompt: 'private' }).success).toBe(false);
    expect(
      modelCallStartSchema.safeParse({ ...start(), model_selector: 'person@example.com' }).success,
    ).toBe(false);
  });
  it('zero scalar usage is still a model call, not verified no_model', () => {
    const v = outcome();
    v.usage = { availability: 'reported', input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    expect(deriveModelAccounting([v]).basis).toBe('all_known');
    expect(deriveModelAccounting([])).toMatchObject({
      basis: 'no_model',
      call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      estimate_usd: '0',
    });
  });
  it('retains exact tiny configured estimates independently of rounded compatibility', () => {
    const sum = deriveModelAccounting([outcome(), outcome(2)]);
    expect(sum.estimate_usd).toBe('0.000000000002');
    expect(legacyAccountingProjection(sum).cost_usd).toBe('0.000000');
    expect(sum.basis).toBe('all_known');
  });
  it('unknown call nulls complete totals while preserving known partial facts', () => {
    expect(deriveModelAccounting([outcome(), failed(2)])).toMatchObject({
      basis: 'known_partial',
      call_count: 2,
      input_tokens: null,
      output_tokens: null,
      estimate_usd: null,
      known_input_tokens: 4,
      known_output_tokens: 6,
      known_estimate_usd: '0.000000000001',
    });
  });
  it('accepts configured bare model IDs without guessing ownership by prefix', () => {
    const v = outcome();
    v.planned = { provider: 'openai', model: 'same' };
    v.serving = { provider: 'openai', model: 'same', reported_model: null };
    v.attempts = [{ provider: 'openai', model: 'same', outcome: 'succeeded' }];
    expect(modelCallOutcomeSchema.safeParse(v).success).toBe(true);
  });
  it('failed fallback usage is unknown even with reported final success', () => {
    const v = outcome();
    v.attempts!.unshift({ provider: 'self_hosted', model: 'qwen/other', outcome: 'failed' });
    expect(deriveModelAccounting([v])).toMatchObject({
      basis: 'known_partial',
      total_tokens: null,
      known_total_tokens: 10,
    });
  });
  it('unavailable price does not erase independently reported usage', () => {
    const v = { ...outcome(), pricing: failed().pricing };
    expect(deriveModelAccounting([v])).toMatchObject({
      basis: 'known_partial',
      input_tokens: 4,
      output_tokens: 6,
      estimate_usd: null,
    });
  });
  it('rejects fabricated unavailable counters, booleans, and inconsistent totals', () => {
    for (const usage of [
      { ...failed().usage, input_tokens: 0 },
      { ...outcome().usage, input_tokens: true },
      { ...outcome().usage, total_tokens: 11 },
    ]) {
      expect(modelCallOutcomeSchema.safeParse({ ...outcome(), usage }).success).toBe(false);
    }
  });
  it('rejects unsafe reported models and fabricated failed-call metadata', () => {
    expect(
      modelCallOutcomeSchema.safeParse({
        ...outcome(),
        serving: { ...outcome().serving, reported_model: 'person@example.com' },
      }).success,
    ).toBe(false);
    expect(
      modelCallOutcomeSchema.safeParse({ ...failed(), content_sha256: 'a'.repeat(64) }).success,
    ).toBe(false);
  });
  it('refuses duplicate or mixed invocation callsets', () => {
    expect(() => deriveModelAccounting([outcome(), outcome()])).toThrow();
    expect(() =>
      deriveModelAccounting([outcome(), { ...outcome(2), tenant_id: uuid(99) }]),
    ).toThrow();
  });
  it('does not fabricate no_model on failed-only or cancelled callsets', () => {
    expect(deriveModelAccounting([failed()])).toMatchObject({
      basis: 'unknown',
      input_tokens: null,
      known_input_tokens: 0,
    });
    expect(
      deriveModelAccounting([
        { ...failed(), state: 'cancelled', failure_code: 'invocation_cancelled' },
      ]),
    ).toMatchObject({ basis: 'unknown', call_count: 1 });
  });
  it('refuses scalar compatibility overflow rather than clamping', () => {
    const v = outcome();
    v.pricing.estimate_usd = '9999.999999';
    expect(() =>
      legacyAccountingProjection(deriveModelAccounting([v, { ...v, ...start(2) }])),
    ).toThrow();
  });
  it('refuses fabricated known partial sums without observed calls', () => {
    expect(
      modelAccountingSummarySchema.safeParse({
        ...deriveModelAccounting([failed()]),
        known_input_tokens: 1,
        known_total_tokens: 1,
      }).success,
    ).toBe(false);
    expect(
      modelAccountingSummarySchema.safeParse({
        ...deriveModelAccounting([failed()]),
        known_estimate_usd: '1',
      }).success,
    ).toBe(false);
  });
  it('summary shape refuses zero no_model with nonempty callset or invented unknown totals', () => {
    expect(
      modelAccountingSummarySchema.safeParse({ ...deriveModelAccounting([]), call_count: 1 })
        .success,
    ).toBe(false);
    expect(
      modelAccountingSummarySchema.safeParse({
        ...deriveModelAccounting([failed()]),
        input_tokens: 0,
      }).success,
    ).toBe(false);
  });
});

describe('independently loaded seal shape (not database authority)', () => {
  const seal = () => ({
    schema_version: 2,
    tenant_id: uuid(1),
    run_id: uuid(2),
    correlation_id: uuid(3),
    request_sha256: 'a'.repeat(64),
    agent: 'sudhaar',
    agent_version: '0.1.0',
    serialization: 'postgres-jsonb-text-v1',
    calls_text: '[]',
    calls_sha256: 'b'.repeat(64),
    summary: deriveModelAccounting([]),
    requested_receipt: { id: '1', entry_hash: 'c'.repeat(64) },
    agent_started_receipt: { id: '2', entry_hash: 'd'.repeat(64) },
    agent_completed_receipt: { id: '3', entry_hash: 'e'.repeat(64) },
    accounting_receipt: { id: '4', entry_hash: 'f'.repeat(64) },
  });
  it('refuses provisional empty arithmetic as an accounting proof', () => {
    expect(modelAccountingSealSchema.safeParse(deriveModelAccounting([])).success).toBe(false);
  });
  it('requires original run/request and all receipt links', () => {
    const complete = seal();
    expect(modelAccountingSealSchema.safeParse(complete).success).toBe(true);
    for (const key of Object.keys(complete)) {
      const incomplete: Record<string, unknown> = { ...complete };
      delete incomplete[key];
      expect(modelAccountingSealSchema.safeParse(incomplete).success).toBe(false);
    }
  });
  it('refuses unordered or overflow ledger receipt identities', () => {
    expect(
      modelAccountingSealSchema.safeParse({
        ...seal(),
        accounting_receipt: { id: '2', entry_hash: 'f'.repeat(64) },
      }).success,
    ).toBe(false);
    expect(
      modelAccountingSealSchema.safeParse({
        ...seal(),
        accounting_receipt: { id: '9223372036854775808', entry_hash: 'f'.repeat(64) },
      }).success,
    ).toBe(false);
  });
});

describe('invalid scalar parsing remains bounded', () => {
  it.each(['x', '', '1e-12', '0.0', '1..2'])(
    'refuses malformed estimate %s without throwing from safeParse',
    (estimate_usd) => {
      expect(() =>
        modelCallOutcomeSchema.safeParse({
          ...outcome(),
          pricing: { ...outcome().pricing, estimate_usd },
        }),
      ).not.toThrow();
      expect(
        modelCallOutcomeSchema.safeParse({
          ...outcome(),
          pricing: { ...outcome().pricing, estimate_usd },
        }).success,
      ).toBe(false);
      expect(() =>
        modelAccountingSummarySchema.safeParse({
          ...deriveModelAccounting([]),
          known_estimate_usd: estimate_usd,
        }),
      ).not.toThrow();
    },
  );
  it('refuses impossible usage sum for the reported call count', () => {
    const value = {
      ...deriveModelAccounting([outcome()]),
      input_tokens: 2147483648,
      output_tokens: 0,
      total_tokens: 2147483648,
      known_input_tokens: 2147483648,
      known_output_tokens: 0,
      known_total_tokens: 2147483648,
    };
    expect(modelAccountingSummarySchema.safeParse(value).success).toBe(false);
  });
});
