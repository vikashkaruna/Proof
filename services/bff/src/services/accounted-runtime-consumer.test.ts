import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { readAndVerifyAccountedRuntimeResult } from './accounted-runtime-consumer.js';
const { cases } = JSON.parse(
  readFileSync(
    new URL('../../../../tests/fixtures/model-accounting/accounted-results.json', import.meta.url),
    'utf8',
  ),
) as {
  cases: { name: string; wire_text: string; expected: { binding: Record<string, unknown> } }[];
};
describe('independent controller consumption', () => {
  for (const packet of cases)
    it(packet.name, async () => {
      const call = vi.fn().mockResolvedValue(packet.expected);
      const actual = await readAndVerifyAccountedRuntimeResult(
        JSON.parse(packet.wire_text),
        packet.expected.binding,
        { call },
      );
      expect(actual.accounting_status).toBe('sealed_observed_journal');
      expect(call).toHaveBeenCalledOnce();
      expect(call).toHaveBeenCalledWith('read_model_accounting_result', {
        t: packet.expected.binding.tenant_id,
        r: packet.expected.binding.run_id,
        rh: packet.expected.binding.request_sha256,
      });
    });
  it('caller witness cannot replace missing read', async () => {
    const packet = cases[0]!;
    const call = vi.fn().mockRejectedValue(new Error('private-canary'));
    await expect(
      readAndVerifyAccountedRuntimeResult(
        { ...JSON.parse(packet.wire_text), expected: packet.expected },
        packet.expected.binding,
        { call },
      ),
    ).rejects.toThrow('accounted_result_contract_refused');
    expect(call).toHaveBeenCalledOnce();
  });
  it('foreign independently read dispatch refuses', async () => {
    const packet = cases[0]!;
    const call = vi.fn().mockResolvedValue({
      ...packet.expected,
      binding: { ...packet.expected.binding, run_id: '10000000-0000-0000-0000-000000000099' },
    });
    await expect(
      readAndVerifyAccountedRuntimeResult(JSON.parse(packet.wire_text), packet.expected.binding, {
        call,
      }),
    ).rejects.toThrow('accounted_result_contract_refused');
  });
});
