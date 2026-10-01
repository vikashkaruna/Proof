import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = {
  generic: vi.fn(async () => ({ data: 1, error: null })),
  human: vi.fn(async () => ({ data: 2, error: null })),
  agent: vi.fn(async () => ({ data: 3, error: null })),
};
const agentWriter = vi.fn(() => ({ rpc: rpc.agent }));
vi.mock('@axiom/config', () => ({
  loadEnv: () => ({ SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_KEY: 'service' }),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ rpc: rpc.generic }) }));
vi.mock('@axiom/supabase', () => ({
  createHumanActionWriter: () => ({ rpc: rpc.human }),
  createAgentLedgerWriter: () => agentWriter(),
}));

const entry = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  correlationId: '22222222-2222-4222-8222-222222222222',
  actorId: '33333333-3333-4333-8333-333333333333',
  actionType: 'approval.granted',
  result: 'success',
} as never;

beforeEach(() => {
  for (const fn of Object.values(rpc)) fn.mockClear();
  agentWriter.mockClear();
});

describe('BFF ledger service append routing', () => {
  it('writes human events only with the human action writer, never the service role', async () => {
    const { createLedgerService } = await import('./ledger.js');
    await createLedgerService().append({ ...(entry as object), actorType: 'human' } as never);
    expect(rpc.human).toHaveBeenCalledWith('append_human_ledger', expect.any(Object));
    expect(rpc.generic).not.toHaveBeenCalled();
    expect(rpc.agent).not.toHaveBeenCalled();
  });

  it('writes agent events only with the agent ledger writer, resolved lazily', async () => {
    const { createLedgerService } = await import('./ledger.js');
    const service = createLedgerService();
    expect(agentWriter).not.toHaveBeenCalled();
    await service.append({ ...(entry as object), actorType: 'agent', actorId: 'drishti' } as never);
    expect(rpc.agent).toHaveBeenCalledWith('append_agent_ledger', expect.any(Object));
    expect(rpc.generic).not.toHaveBeenCalled();
    expect(rpc.human).not.toHaveBeenCalled();
  });

  it('fails closed when the agent writer credential is unavailable', async () => {
    agentWriter.mockImplementationOnce(() => {
      throw new Error('Agent ledger writer credential is unavailable');
    });
    const { createLedgerService } = await import('./ledger.js');
    await expect(
      createLedgerService().append({
        ...(entry as object),
        actorType: 'system',
        actorId: 'bff',
      } as never),
    ).rejects.toThrow(/credential is unavailable/);
    expect(rpc.generic).not.toHaveBeenCalled();
  });
});
