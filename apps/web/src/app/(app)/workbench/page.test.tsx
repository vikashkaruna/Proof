import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import WorkbenchPage from './page';

const state = vi.hoisted(() => ({
  calls: [] as Array<[string, string, unknown]>,
  reads: {} as Record<string, { data?: unknown; count?: number | null; error?: Error | null }>,
}));
vi.mock('@/lib/tenant-context', () => ({ requireInternalContext: async () => ({
  tenantId: 'tenant-1', email: 'operator@example.invalid',
  supabase: { from: (table: string) => {
    let filter = '';
    const query = {
      select: (_columns: string, options?: { head?: boolean }) => { filter = options?.head ? 'today' : ''; return query; },
      eq: (key: string, value: unknown) => { state.calls.push([table, key, value]); return query; },
      in: () => query, order: () => query, gte: () => query,
      limit: () => Promise.resolve(state.reads[`${table}:${filter || 'list'}`] ?? { data: [], count: 0, error: null }),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(state.reads[`${table}:${filter || 'list'}`] ?? { data: [], count: 0, error: null }).then(resolve),
    };
    return query;
  } },
}) }));
vi.mock('@axiom/config', () => ({ BRAND: { dataResidencyRegion: 'ap-south-1' }, loadWebEnv: () => ({ ENVIRONMENT: 'local' }) }));
vi.mock('./workbench-client', () => ({ AgentWorkbenchClient: (props: unknown) => <pre>{JSON.stringify(props)}</pre> }));
beforeEach(() => { state.calls = []; state.reads = {}; });

it('binds all activity and review reads to the internal tenant', async () => {
  state.reads['audit_ledger:list'] = { data: [{ sequence_no: 7, actor_id: 'agent-1', action_type: 'observed', target_ref: 'source-1', occurred_at: '2026-10-01', result: 'success', correlation_id: 'corr-1' }] };
  state.reads['remediation_plans:list'] = { data: [{ id: 'plan-1', title: 'Saved plan', status: 'review', version: 2, created_at: '2026-10-01' }], count: 1 };
  state.reads['audit_ledger:today'] = { count: 1 };
  const view = renderToStaticMarkup(await WorkbenchPage());
  expect(state.calls.filter(([table, key]) => ['audit_ledger', 'remediation_plans'].includes(table) && key === 'tenant_id')).toHaveLength(3);
  expect(state.calls.every(([, key, value]) => key !== 'tenant_id' || value === 'tenant-1')).toBe(true);
  expect(view).toContain('&quot;ledgerTodayCount&quot;:1');
  expect(view).toContain('&quot;awaitingReviewCount&quot;:1');
  expect(view).toContain('Saved plan');
});

it('does not translate failed or missing sources into zero recorded activity', async () => {
  state.reads['audit_ledger:list'] = { data: [], error: new Error('unavailable') };
  state.reads['remediation_plans:list'] = { data: null, count: null, error: null };
  state.reads['audit_ledger:today'] = { count: null, error: new Error('unavailable') };
  const view = renderToStaticMarkup(await WorkbenchPage());
  expect(view).toContain('&quot;recentRuns&quot;:null');
  expect(view).toContain('&quot;pendingPlans&quot;:null');
  expect(view).toContain('&quot;ledgerTodayCount&quot;:null');
  expect(view).toContain('&quot;awaitingReviewCount&quot;:null');
  expect(view).toContain('&quot;loadError&quot;:true');
});
