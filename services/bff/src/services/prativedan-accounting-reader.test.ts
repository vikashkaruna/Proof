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

it('refuses inherited argument names before obtaining controller authority', async () => {
  const port = { verifiedContext: vi.fn(), call: vi.fn() };
  const reader = prativedanAccountingReader(binding, port);
  const args: Record<string, unknown> = { unexpected: 1, extra: 2, unrelated: 3 };
  Object.setPrototypeOf(args, {
    t: binding.tenant_id,
    r: binding.run_id,
    rh: binding.request_sha256,
  });
  await expect(reader.call('read_model_accounting_result', args)).rejects.toThrow(
    'accounted_result_contract_refused',
  );
  expect(port.verifiedContext).not.toHaveBeenCalled();
  expect(port.call).not.toHaveBeenCalled();
});

it('pins SQL arguments while independent authority verification awaits', async () => {
  let release!: (value: Readonly<Record<string, unknown>>) => void;
  const authority = new Promise<Readonly<Record<string, unknown>>>((resolve) => {
    release = resolve;
  });
  const port = { verifiedContext: vi.fn(() => authority), call: vi.fn() };
  const reader = prativedanAccountingReader(binding, port);
  const args = { t: binding.tenant_id, r: binding.run_id, rh: binding.request_sha256 };
  const pending = reader.call('read_model_accounting_result', args);
  args.t = binding.run_id;
  args.r = binding.tenant_id;
  args.rh = 'b'.repeat(64);
  release({ fresh: 1 });
  await pending;
  expect(port.call).toHaveBeenCalledExactlyOnceWith('prativedan_read_model_accounting_result', {
    t: binding.tenant_id,
    r: binding.run_id,
    rh: binding.request_sha256,
    k: binding.correlation_id,
    authority: { fresh: 1 },
  });
});
