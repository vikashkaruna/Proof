import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ActorType, LedgerActionType, LedgerResult } from '@axiom/types';
import { canonicalJson, sha256 } from './canonicalise';
import {
  createLedgerClient,
  LedgerClient,
  LedgerWriteError,
  type AppendLedgerInput,
} from './append';

const input: AppendLedgerInput = {
  tenantId: 'tenant-a',
  correlationId: 'operation-a',
  actorType: ActorType.HUMAN,
  actorId: 'reviewer-a',
  actionType: LedgerActionType.DISCOVERY_STARTED,
  result: LedgerResult.SUCCESS,
  detail: { b: 2, a: 1 },
};

function client(rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>) {
  return new LedgerClient({ rpc } as unknown as SupabaseClient);
}

// Appends go through the scoped writer clients (migration 0099); the generic
// client is used only for the read paths (verify_ledger and queries).
function writer(rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>) {
  const scoped = { rpc } as unknown as SupabaseClient;
  const generic = {
    rpc: async () => {
      throw new Error('the generic client must not append');
    },
  } as unknown as SupabaseClient;
  return new LedgerClient(generic, { human: () => scoped, agent: () => scoped });
}

describe('append-only ledger boundary', () => {
  it('calls only append_human_ledger on the human writer with tenant, correlation and canonical detail hashes', async () => {
    const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({
      data: 17,
      error: null,
    }));
    const result = await writer(rpc).append(input);
    expect(rpc).toHaveBeenCalledOnce();
    const [name, args] = rpc.mock.calls[0]!;
    expect(name).toBe('append_human_ledger');
    expect(args).toMatchObject({
      p_tenant_id: 'tenant-a',
      p_correlation_id: 'operation-a',
      p_actor_type: 'human',
      p_action_type: 'discovery.started',
      p_detail: { b: 2, a: 1 },
      p_agent_version: null,
      p_approval_token_id: null,
    });
    expect(args.p_input_hash).toBe(await sha256(canonicalJson({ b: 2, a: 1, _kind: 'input' })));
    expect(args.p_output_hash).toBe(await sha256(canonicalJson({ b: 2, a: 1, _kind: 'output' })));
    expect(result.id).toBe('17');
    expect(Number.isNaN(Date.parse(result.occurredAt))).toBe(false);
  });

  it('uses supplied hashes without recomputing and preserves optional proof links', async () => {
    const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({
      data: '18',
      error: null,
    }));
    await writer(rpc).append({
      ...input,
      inputHash: 'input-proof',
      outputHash: 'output-proof',
      approvalTokenId: 'approval-a',
      approverId: 'reviewer-a',
      preStateRef: 'before',
      postStateRef: 'after',
    });
    expect(rpc.mock.calls[0]![1]).toMatchObject({
      p_input_hash: 'input-proof',
      p_output_hash: 'output-proof',
      p_approval_token_id: 'approval-a',
      p_approver_id: 'reviewer-a',
      p_pre_state_ref: 'before',
      p_post_state_ref: 'after',
    });
  });

  it('fails the parent operation on RPC error or absent append receipt', async () => {
    const failing = writer(async () => ({
      data: null,
      error: { message: 'denied', code: '42501', hint: 'no grant', details: 'RLS' },
    }));
    await expect(failing.append(input)).rejects.toMatchObject({
      name: 'LedgerWriteError',
      context: { code: '42501', hint: 'no grant', details: 'RLS' },
    });
    await expect(writer(async () => ({ data: null, error: null })).append(input)).rejects.toThrow(
      'append_human_ledger returned no data',
    );
    expect(new LedgerWriteError('unavailable').name).toBe('LedgerWriteError');
  });

  it('reports an intact chain, first break, and verification errors without mutation', async () => {
    const rpc = vi.fn(
      async (
        _name: string,
        _args: Record<string, unknown>,
      ): Promise<{
        data: unknown;
        error: { message: string } | null;
      }> => ({ data: [], error: null }),
    );
    const ledger = client(rpc);
    expect(await ledger.verify('tenant-a')).toEqual({ intact: true });
    expect(rpc.mock.calls[0]).toEqual([
      'verify_ledger',
      { p_tenant_id: 'tenant-a', p_from_sequence: 1 },
    ]);
    rpc.mockResolvedValueOnce({ data: [{ sequence_no: 9, reason: 'hash mismatch' }], error: null });
    expect(await ledger.verify('tenant-a', 5)).toEqual({
      intact: false,
      firstBreak: { sequenceNo: 9, reason: 'hash mismatch' },
    });
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'read denied' } });
    await expect(ledger.verify('tenant-a')).rejects.toThrow('verify_ledger failed: read denied');
    expect(rpc.mock.calls.every(([name]) => name === 'verify_ledger')).toBe(true);
  });

  it('scopes and bounds ledger queries, and propagates read failures', async () => {
    const calls: Array<[string, unknown[]]> = [];
    let response: { data: unknown; error: { message: string } | null } = {
      data: [{ id: 'row-a' }],
      error: null,
    };
    const query = {
      select: (...args: unknown[]) => {
        calls.push(['select', args]);
        return query;
      },
      eq: (...args: unknown[]) => {
        calls.push(['eq', args]);
        return query;
      },
      gte: (...args: unknown[]) => {
        calls.push(['gte', args]);
        return query;
      },
      lte: (...args: unknown[]) => {
        calls.push(['lte', args]);
        return query;
      },
      order: (...args: unknown[]) => {
        calls.push(['order', args]);
        return query;
      },
      limit: (...args: unknown[]) => {
        calls.push(['limit', args]);
        return query;
      },
      range: (...args: unknown[]) => {
        calls.push(['range', args]);
        return query;
      },
      then: (resolve: (value: typeof response) => void) => Promise.resolve(response).then(resolve),
    };
    const ledger = new LedgerClient({
      from: (table: string) => {
        expect(table).toBe('audit_ledger');
        return query;
      },
    } as unknown as SupabaseClient);
    expect(
      await ledger.query({
        tenantId: 'tenant-a',
        fromSequence: 2,
        toSequence: 8,
        fromTime: '2026-01-01',
        toTime: '2026-02-01',
        actorType: ActorType.HUMAN,
        actorId: 'reviewer-a',
        actionType: LedgerActionType.DISCOVERY_STARTED,
        correlationId: 'operation-a',
        result: LedgerResult.SUCCESS,
        limit: 20,
        offset: 40,
      }),
    ).toEqual([{ id: 'row-a' }]);
    expect(calls).toContainEqual(['eq', ['tenant_id', 'tenant-a']]);
    expect(calls).toContainEqual(['gte', ['sequence_no', 2]]);
    expect(calls).toContainEqual(['lte', ['sequence_no', 8]]);
    expect(calls).toContainEqual(['limit', [20]]);
    expect(calls).toContainEqual(['range', [40, 59]]);
    response = { data: null, error: null };
    expect(await ledger.query({ tenantId: 'tenant-a' })).toEqual([]);
    response = { data: null, error: { message: 'read denied' } };
    await expect(ledger.query({ tenantId: 'tenant-a' })).rejects.toThrow(
      'ledger query failed: read denied',
    );
  });

  it('constructs a server-side ledger client without network access', () => {
    expect(createLedgerClient('http://127.0.0.1:54321', 'server-only-key')).toBeInstanceOf(
      LedgerClient,
    );
  });
});

function fake(data: unknown = 7) {
  const rpc = vi.fn(async () => ({ data, error: null }));
  return { rpc, client: { rpc } as unknown as SupabaseClient };
}

const routed: AppendLedgerInput = {
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
    await ledger.append(routed);
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
      await ledger.append({ ...routed, actorType, actorId: 'drishti' });
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
    await expect(ledger.append(routed)).rejects.toThrow(/No human ledger writer/);
    const humanOnly = new LedgerClient(generic.client, { human: () => fake().client });
    await expect(humanOnly.append({ ...routed, actorType: 'agent' })).rejects.toThrow(
      /No agent ledger writer/,
    );
    await expect(new LedgerClient(generic.client).append(routed)).rejects.toBeInstanceOf(
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
    await expect(ledger.append(routed)).rejects.toThrow(/credential is unavailable/);
    await expect(
      ledger.append({ ...routed, actorType: 'robot' as AppendLedgerInput['actorType'] }),
    ).rejects.toThrow(/Unsupported ledger actor type/);
    expect(generic.rpc).not.toHaveBeenCalled();
  });
});
