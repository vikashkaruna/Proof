import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { LedgerClient, LedgerWriteError, type AppendLedgerInput } from './append';

function fake(data: unknown = 7) {
  const rpc = vi.fn(async () => ({ data, error: null }));
  return { rpc, client: { rpc } as unknown as SupabaseClient };
}

const base: AppendLedgerInput = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  correlationId: '22222222-2222-2222-2222-222222222222',
  actorType: 'human',
  actorId: '33333333-3333-3333-3333-333333333333',
  actionType: 'approval.granted' as AppendLedgerInput['actionType'],
  result: 'success' as AppendLedgerInput['result'],
};

describe('LedgerClient actor routing', () => {
  it('routes human events only to append_human_ledger on the human writer', async () => {
    const generic = fake();
    const human = fake();
    const agent = fake();
    const ledger = new LedgerClient(generic.client, {
      human: () => human.client,
      agent: () => agent.client,
    });
    await ledger.append(base);
    expect(human.rpc).toHaveBeenCalledWith(
      'append_human_ledger',
      expect.objectContaining({ p_actor_type: 'human' }),
    );
    expect(agent.rpc).not.toHaveBeenCalled();
    expect(generic.rpc).not.toHaveBeenCalled();
  });

  it.each(['agent', 'system'] as const)(
    'routes %s events only to append_agent_ledger',
    async (actorType) => {
      const generic = fake();
      const human = fake();
      const agent = fake();
      const ledger = new LedgerClient(generic.client, {
        human: () => human.client,
        agent: () => agent.client,
      });
      await ledger.append({ ...base, actorType, actorId: 'drishti' });
      expect(agent.rpc).toHaveBeenCalledWith(
        'append_agent_ledger',
        expect.objectContaining({ p_actor_type: actorType }),
      );
      expect(human.rpc).not.toHaveBeenCalled();
      expect(generic.rpc).not.toHaveBeenCalled();
    },
  );

  it('fails closed when the matching writer is not configured, without falling back', async () => {
    const generic = fake();
    const agent = fake();
    const ledger = new LedgerClient(generic.client, { agent: () => agent.client });
    await expect(ledger.append(base)).rejects.toThrow(/No human ledger writer/);
    const humanOnly = new LedgerClient(generic.client, { human: () => fake().client });
    await expect(humanOnly.append({ ...base, actorType: 'agent' })).rejects.toThrow(
      /No agent ledger writer/,
    );
    await expect(new LedgerClient(generic.client).append(base)).rejects.toBeInstanceOf(
      LedgerWriteError,
    );
    expect(generic.rpc).not.toHaveBeenCalled();
    expect(agent.rpc).not.toHaveBeenCalled();
  });

  it('fails closed when the credential resolver throws, and rejects unknown actor types', async () => {
    const generic = fake();
    const ledger = new LedgerClient(generic.client, {
      human: () => {
        throw new Error('BFF human action writer credential is unavailable');
      },
    });
    await expect(ledger.append(base)).rejects.toThrow(/credential is unavailable/);
    await expect(
      ledger.append({ ...base, actorType: 'robot' as AppendLedgerInput['actorType'] }),
    ).rejects.toThrow(/Unsupported ledger actor type/);
    expect(generic.rpc).not.toHaveBeenCalled();
  });
});
