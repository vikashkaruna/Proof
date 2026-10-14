import { expect, it, vi } from 'vitest';
import { prativedanAccountingReader } from './prativedan-accounting-reader.js';
const binding = {
  schema_version: 2,
  tenant_id: '10000000-0000-4000-8000-000000000001',
  run_id: '10000000-0000-4000-8000-000000000002',
  correlation_id: '10000000-0000-4000-8000-000000000003',
  request_sha256: 'a'.repeat(64),
  agent: 'prativedan',
  agent_version: '0.1.0',
};
it('fresh independent126 context per read; scoped original identity', async () => {
  const port = {
    verifiedContext: vi
      .fn()
      .mockResolvedValueOnce({ fresh: 1 })
      .mockResolvedValueOnce({ fresh: 2 }),
    call: vi.fn().mockResolvedValue({}),
  };
  const reader = prativedanAccountingReader(binding, port);
  const args = { t: binding.tenant_id, r: binding.run_id, rh: binding.request_sha256 };
  await reader.call('read_model_accounting_result', args);
  await reader.call('read_model_accounting_result', args);
  expect(port.call.mock.calls[0]![1]).toEqual({
    ...args,
    k: binding.correlation_id,
    authority: { fresh: 1 },
  });
  expect(port.call.mock.calls[1]![1]).toEqual({
    ...args,
    k: binding.correlation_id,
    authority: { fresh: 2 },
  });
  await expect(
    reader.call('read_model_accounting_result', { ...args, r: binding.tenant_id }),
  ).rejects.toThrow('accounted_result_contract_refused');
  expect(port.verifiedContext).toHaveBeenCalledTimes(2);
});
