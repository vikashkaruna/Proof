import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import LedgerPage from './page';
import { moduleMeta } from '@/lib/module-meta';

const state = vi.hoisted(() => ({
  ledger: {
    data: [] as Record<string, unknown>[] | null,
    count: 0 as number | null,
    error: null as Error | null,
  },
  total: { count: 0, error: null as Error | null },
  active: { data: [] as Record<string, unknown>[] | null, error: null as Error | null },
  verification: { data: [] as Record<string, unknown>[] | null, error: null as Error | null },
  context: vi.fn(),
}));

vi.mock('@/lib/tenant-context', () => ({
  Capability: { LEDGER_READ: 'ledger.read' },
  requireCapabilityContext: state.context,
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@axiom/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@axiom/ui')>()),
  AgentIcon: () => <span>Lekha</span>,
}));
vi.mock('./verify-button', () => ({ VerifyButton: () => null }));
vi.mock('./export-ledger-button', () => ({ ExportLedgerButton: () => null }));
vi.mock('./ledger-refresh', () => ({ LedgerRefresh: () => null }));
vi.mock('./ledger-filters', () => ({ LedgerFilters: () => null }));
vi.mock('./ledger-pagination', () => ({ LedgerPagination: () => null }));
vi.mock('./ledger-stream-view', () => ({
  LedgerStreamView: ({ entries }: { entries: unknown[] }) => (
    <span data-testid="rows">{entries.length} rows</span>
  ),
}));

function makeQuery(value: () => unknown) {
  const query = {
    select: (_columns?: string, options?: { head?: boolean }) => {
      if (options?.head) return makeQuery(() => state.total);
      return query;
    },
    eq: () => query,
    in: () => query,
    order: () => query,
    range: () => query,
    ilike: () => query,
    or: () => query,
    maybeSingle: async () => ({ data: { is_axiom_internal: true }, error: null }),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(value()).then(resolve),
  };
  return query;
}

beforeEach(() => {
  state.ledger = { data: [], count: 0, error: null };
  state.total = { count: 0, error: null };
  state.active = { data: [], error: null };
  state.verification = { data: [], error: null };
  state.context.mockReset();
  state.context.mockImplementation(async () => ({
    userId: 'auditor-1',
    tenantId: 'tenant-1',
    tenantName: 'Actual tenant',
    tenantSlug: 'actual',
    supabase: {
      from: (table: string) =>
        table === 'users'
          ? makeQuery(() => ({}))
          : table === 'agent_runs'
            ? makeQuery(() => state.active)
            : makeQuery(() => state.ledger),
      rpc: async () => state.verification,
    },
  }));
});

async function renderPage(searchParams: Record<string, string> = {}) {
  const page = await LedgerPage({ searchParams: Promise.resolve(searchParams) });
  return renderToStaticMarkup(page);
}

it('renders zero recorded events without fictional fallback rows or tenants', async () => {
  const html = await renderPage();
  expect(html).toContain('0 recorded entries');
  expect(html).toContain('0 rows');
  expect(html).toContain('Chain verified from genesis');
  expect(html).not.toContain('48102');
  expect(html).not.toContain('Meridian Pay');
  expect(html).not.toContain('evidence.sealed');
  expect(state.context).toHaveBeenCalledWith('ledger.read', undefined);
});

it('does not call verification intact when the RPC fails or returns no result', async () => {
  state.verification = { data: null, error: new Error('database unavailable') };
  expect(await renderPage()).toContain('Chain verification unavailable');
  state.verification = { data: null, error: null };
  expect(await renderPage()).toContain('Chain verification unavailable');
});

it('shows a recorded chain break and binds the requested tenant through capability context', async () => {
  state.verification = { data: [{ sequence_no: 3, reason: 'hash mismatch' }], error: null };
  const html = await renderPage({ tenant: 'actual' });
  expect(html).toContain('Chain break #3');
  expect(state.context).toHaveBeenCalledWith('ledger.read', 'actual');
});

it('refuses an unavailable requested tenant instead of silently displaying another tenant', async () => {
  await expect(renderPage({ tenant: 'foreign-tenant' })).rejects.toThrow(
    'Requested ledger tenant is unavailable',
  );
});

it('refuses to turn a ledger query error into an empty verified audit', async () => {
  state.ledger = { data: [], count: 0, error: new Error('read failed') };
  await expect(renderPage()).rejects.toThrow('Ledger records are unavailable');
});

it('refuses missing ledger rows, counts, or running-agent sources', async () => {
  state.ledger = { data: null, count: 0, error: null };
  await expect(renderPage()).rejects.toThrow('Ledger records are unavailable');
  state.ledger = { data: [], count: null, error: null };
  await expect(renderPage()).rejects.toThrow('Ledger records are unavailable');
  state.ledger = { data: [], count: 0, error: null };
  state.active = { data: null, error: null };
  await expect(renderPage()).rejects.toThrow('Ledger records are unavailable');
});

it('refuses untrusted filter syntax before building a ledger query', async () => {
  await expect(renderPage({ q: 'target),tenant_id.eq.foreign' })).rejects.toThrow(
    'Invalid ledger search query',
  );
});

it('keeps malformed pagination away from the ledger range query', async () => {
  const view = await renderPage({ page: 'NaN', limit: 'Infinity' });
  expect(view).toContain('0 rows');
});

it('renders the shared context line with the module id and agents, and prints the Hindi name once', async () => {
  const html = await renderPage();
  expect(html).toContain('data-testid="module-context"');
  const ctx = html.slice(html.indexOf('data-testid="module-context"'));
  expect(ctx).toContain('M2.5');
  expect(ctx).toContain('data-testid="related-agents"');
  expect(html.split(moduleMeta('ledger').hi)).toHaveLength(2);
});
