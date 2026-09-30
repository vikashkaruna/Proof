import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({
  calls: [] as Array<[string, string, unknown]>,
  records: [] as Array<Record<string, unknown>>,
  queryError: null as { message: string } | null,
  breaks: [] as Array<Record<string, unknown>>,
  verifyError: null as { message: string } | null,
  tenantLookup: null as { id: string; name: string; slug: string } | null,
  tenantError: null as Error | null,
  availableCount: null as number | null,
}));

vi.mock('@/lib/tenant-context', () => ({ requireTenantContext: async () => {
  if (state.tenantError) throw state.tenantError;
  return {
  tenantId: 'tenant-a',
  supabase: {
    from: (table: string) => {
      const builder = {
        select: (...args: unknown[]) => { state.calls.push([table, 'select', args]); return builder; },
        eq: (field: string, value: unknown) => { state.calls.push([table, `eq:${field}`, value]); return builder; },
        order: (field: string) => { state.calls.push([table, 'order', field]); return builder; },
        limit: (value: number) => { state.calls.push([table, 'limit', value]); return builder; },
        range: (from: number, to: number) => { state.calls.push([table, 'range', [from, to]]); return builder; },
        ilike: (field: string, value: string) => { state.calls.push([table, `ilike:${field}`, value]); return builder; },
        or: (value: string) => { state.calls.push([table, 'or', value]); return builder; },
        maybeSingle: async () => ({ data: state.tenantLookup }),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve({ data: state.records, count: state.availableCount ?? state.records.length, error: state.queryError })),
      };
      return builder;
    },
    rpc: async () => ({ data: state.breaks, error: state.verifyError }),
  },
  };
} }));
import { GET } from './route';

const entry = {
  id: 'entry-1', sequence_no: 1, actor_id: 'agent-1', actor_type: 'agent',
  action_type: 'evidence.sealed', result: 'success', target_ref: 'object-v1',
  occurred_at: '2026-09-30T12:00:00Z', correlation_id: 'corr-1',
  entry_hash: 'a'.repeat(64), prev_entry_hash: '0'.repeat(64), detail: {},
};
const request = (query: string) => new NextRequest(`https://app.axiomproof.ai/api/ledger${query}`);

beforeEach(() => {
  state.calls = [];
  state.records = [entry];
  state.queryError = null;
  state.breaks = [];
  state.verifyError = null;
  state.tenantLookup = null;
  state.tenantError = null;
  state.availableCount = null;
});

it('binds a paginated ledger read to the authenticated tenant and caps its page size', async () => {
  const response = await GET(request('?page=2&limit=500&agent=human&result=success&q=12'));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ page: 2, limit: 100, totalCount: 1 });
  expect(state.calls).toContainEqual(['audit_ledger', 'eq:tenant_id', 'tenant-a']);
  expect(state.calls).toContainEqual(['audit_ledger', 'range', [100, 199]]);
  expect(state.calls).toContainEqual(['audit_ledger', 'eq:actor_type', 'human']);
  expect(state.calls).toContainEqual(['audit_ledger', 'eq:sequence_no', 12]);
});

it('normalizes malformed pagination values before constructing a range', async () => {
  const response = await GET(request('?page=NaN&limit=Infinity'));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ page: 1, limit: 25 });
  expect(state.calls).toContainEqual(['audit_ledger', 'range', [0, 24]]);
});

it('does not select an unknown tenant requested through a query parameter', async () => {
  const response = await GET(request('?tenantId=foreign-tenant'));
  expect(response.status).toBe(403);
  expect(state.calls.filter(([table, method]) => table === 'audit_ledger' && method === 'eq:tenant_id'))
    .toEqual([]);
});

it('rejects PostgREST filter grammar in untrusted ledger search', async () => {
  const response = await GET(request('?q=target),tenant_id.eq.foreign'));
  expect(response.status).toBe(400);
  expect(state.calls.filter(([table]) => table === 'audit_ledger')).toEqual([]);
});

it('does not invent event fields when a ledger row has absent optional data', async () => {
  state.records = [{ id: 'record-1', sequence_no: 1, action_type: 'assessment.started' }];
  const response = await GET(request(''));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.entries[0]).toMatchObject({
    corr: 'No correlation ID', target: 'No target recorded', entryHash: 'Unavailable',
    prevHash: 'Genesis or unavailable', result: 'unknown',
  });
  expect(JSON.stringify(body)).not.toContain('cr-118');
});

it('exports an integrity result and never labels a broken chain intact', async () => {
  state.tenantLookup = { id: 'tenant-a', name: 'Alpha', slug: 'alpha' };
  state.breaks = [{ sequence_no: 1, reason: 'hash mismatch' }];
  const response = await GET(request('?export=true&action=evidence'));
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('content-disposition')).toContain('alpha-');
  const bundle = await response.json();
  expect(bundle.export_metadata.chain_integrity).toMatchObject({ status: 'broken', verified: false, first_break: state.breaks[0] });
  expect(bundle.export_metadata).toMatchObject({ total_records: 1, export_truncated: false });
  expect(bundle.export_metadata).toMatchObject({ first_exported_sequence: 1, last_exported_sequence: 1 });
  expect(bundle.export_metadata.chain_integrity).not.toHaveProperty('genesis_hash');
  expect(bundle.records[0].cryptography.entry_hash).toBe(entry.entry_hash);
  expect(state.calls).toContainEqual(['audit_ledger', 'eq:tenant_id', 'tenant-a']);
});

it('marks an export truncated when more records exist than were returned', async () => {
  state.tenantLookup = { id: 'tenant-a', name: 'Alpha', slug: 'alpha' };
  state.availableCount = 5001;
  const response = await GET(request('?export=true'));
  expect(response.status).toBe(200);
  const bundle = await response.json();
  expect(bundle.export_metadata).toMatchObject({
    total_records: 1, total_records_available: 5001, export_truncated: true,
  });
  expect(JSON.stringify(bundle)).not.toContain('Statutory Audit Trail');
});

it('returns a failure when the ledger query fails rather than an empty successful export', async () => {
  state.tenantLookup = { id: 'tenant-a', name: 'Alpha', slug: 'alpha' };
  state.queryError = { message: 'ledger unavailable' };
  const response = await GET(request('?export=true'));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: 'ledger unavailable' });
});

it('refuses an auditor export when its tenant cannot be resolved or verification fails', async () => {
  const unresolved = await GET(request('?export=true'));
  expect(unresolved.status).toBe(503);
  state.tenantLookup = { id: 'tenant-a', name: 'Alpha', slug: 'alpha' };
  state.verifyError = { message: 'RPC unavailable' };
  const unverified = await GET(request('?export=true'));
  expect(unverified.status).toBe(503);
  expect(await unverified.json()).toEqual({ error: 'Ledger verification is unavailable' });
});

it('preserves the authentication gate instead of converting its refusal into a server error', async () => {
  state.tenantError = new Error('NEXT_REDIRECT:/login');
  await expect(GET(request(''))).rejects.toThrow('NEXT_REDIRECT:/login');
});
