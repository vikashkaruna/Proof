import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import DashboardPage from './page';

type Result = { data?: unknown; count?: number | null; error?: Error | null };
const state = vi.hoisted(() => ({
  results: {} as Record<string, Result>,
  from: vi.fn(),
}));
vi.mock('@/lib/tenant-context', () => ({ requireTenantContext: async () => ({
  tenantId: 'tenant-1', tenantName: 'Actual organization',
  supabase: { from: state.from },
}) }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));

beforeEach(() => {
  state.results = {};
  state.from.mockReset().mockImplementation((table: string) => {
    const result = () => state.results[table] ?? { data: [], count: 0, error: null };
    const query = {
      select: () => query,
      eq: () => query,
      order: () => query,
      limit: () => query,
      maybeSingle: async () => result(),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
    };
    return query;
  });
});

async function html() { return renderToStaticMarkup(await DashboardPage()); }

it('shows zero recorded data without invented posture, evidence, agents, or legal countdown', async () => {
  const view = await html();
  expect(view).toContain('Actual organization');
  expect(view).toContain('No verified posture score is available.');
  expect(view).toContain('No agent runs recorded for this tenant.');
  expect(view).toContain('>0<');
  for (const fiction of ['1,284', '182k', '48,102', 'Meridian', 'Karya is waiting', '13 May 2027', '2 new signals', 'dry-run ✓']) {
    expect(view).not.toContain(fiction);
  }
  expect(state.from).toHaveBeenCalledWith('consent_records');
});

it('distinguishes unavailable queries from zero counts', async () => {
  state.results.evidence = { data: null, count: null, error: new Error('read failed') };
  state.results.agent_runs = { data: null, error: new Error('read failed') };
  const view = await html();
  expect(view).toContain('Evidence records');
  expect(view).toContain('Unavailable');
  expect(view).toContain('Agent runs are unavailable.');
  expect(view).not.toContain('WORM · live from DB');
});

it('counts only recorded pending approvals and open findings', async () => {
  state.results.findings = { data: [{ id: 'f1', status: 'open' }, { id: 'f2', status: 'closed' }], error: null };
  state.results.remediation_actions = { data: [{ id: 'a1', approval_status: 'awaiting_approval' }, { id: 'a2', approval_status: 'draft' }], error: null };
  state.results.engagements = { data: { posture_score: 0.83 }, error: null };
  state.results.agent_runs = { data: [{ id: 'r1', agent: 'drishti', status: 'running', started_at: '2026-10-01T00:00:00Z' }], error: null };
  const view = await html();
  expect(view).toContain('83/100');
  expect(view).toMatch(/Recorded open findings<\/h2><p[^>]*>1<\/p>/);
  expect(view).toMatch(/Awaiting approval<\/h2><p[^>]*>1<\/p>/);
  expect(view).toContain('drishti');
  expect(view).toContain('Recorded actions awaiting human review');
  expect(view).not.toContain('executing task in ap-south-1');
});
