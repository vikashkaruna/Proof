import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { settleAccountedGenericResult } from './accounted-generic-settlement.js';
const { cases } = JSON.parse(
  readFileSync(
    new URL('../../../../tests/fixtures/model-accounting/accounted-results.json', import.meta.url),
    'utf8',
  ),
) as {
  cases: {
    name: string;
    wire_text: string;
    expected: { binding: { run_id: string; [key: string]: unknown }; terminal_status: string };
  }[];
};
for (const p of cases)
  it(`settles ${p.name} only after independent read`, async () => {
    const reader = { call: vi.fn().mockResolvedValue(p.expected) };
    const settlement = {
      call: vi.fn().mockResolvedValue({
        run_id: p.expected.binding.run_id,
        status: p.expected.terminal_status,
        replayed: false,
      }),
    };
    const actual = await settleAccountedGenericResult(
      JSON.parse(p.wire_text),
      {
        binding: p.expected.binding,
        actorId: '10000000-0000-4000-8000-000000000009',
        engagementId: null,
      },
      { reader, settlement },
    );
    expect(actual.accounting_status).toBe('sealed_observed_journal');
    const args = settlement.call.mock.calls[0]![1] as Record<string, unknown>;
    expect(args.p_input_tokens).toBe(actual.result.input_tokens);
    expect(args.p_cost_usd).toBe(
      actual.result.cost_usd === null ? null : Number(actual.result.cost_usd),
    );
    expect(args.p_started_receipt).toBe(actual.result.ledger_entry_ids[0]);
    expect(args.p_completed_receipt).toBe(actual.result.ledger_entry_ids[1]);
  });
it('refused source never settles or retries', async () => {
  const p = cases[0]!;
  const reader = { call: vi.fn().mockRejectedValue(new Error('private-canary')) };
  const settlement = { call: vi.fn() };
  await expect(
    settleAccountedGenericResult(
      JSON.parse(p.wire_text),
      {
        binding: p.expected.binding,
        actorId: '10000000-0000-4000-8000-000000000009',
        engagementId: null,
      },
      { reader, settlement },
    ),
  ).rejects.toThrow('accounted_result_contract_refused');
  expect(settlement.call).not.toHaveBeenCalled();
  expect(reader.call).toHaveBeenCalledOnce();
});
it('lost settlement never returns verified success or retries', async () => {
  const p = cases[0]!;
  const reader = { call: vi.fn().mockResolvedValue(p.expected) };
  const settlement = { call: vi.fn().mockRejectedValue(new Error('private-canary')) };
  await expect(
    settleAccountedGenericResult(
      JSON.parse(p.wire_text),
      {
        binding: p.expected.binding,
        actorId: '10000000-0000-4000-8000-000000000009',
        engagementId: null,
      },
      { reader, settlement },
    ),
  ).rejects.toThrow('accounted_result_contract_refused');
  expect(settlement.call).toHaveBeenCalledOnce();
});
