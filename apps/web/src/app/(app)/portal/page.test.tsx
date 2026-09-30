import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import ClientPortalPage from './page';

const state = vi.hoisted(() => ({
  requestedTenant: '' as string | undefined,
  calls: [] as Array<[string, string, unknown]>,
  data: {} as Record<string, unknown>,
  errors: {} as Record<string, Error | null>,
  snapshot: null as unknown,
}));
vi.mock('@/lib/tenant-context', () => ({ requireTenantContext: async (requested?: string) => {
  state.requestedTenant = requested;
  return {
    tenantId: 'tenant-1', tenantName: 'Actual tenant', tenantSlug: 'actual',
    supabase: { from: (table: string) => {
      const result = () => ({ data: state.data[table] ?? [], error: state.errors[table] ?? null });
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => { state.calls.push([table, key, value]); return query; },
        in: () => query,
        order: () => query,
        limit: () => query,
        maybeSingle: async () => result(),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
      };
      return query;
    } },
  };
} }));
vi.mock('@/lib/assessment-snapshot', () => ({ loadAssessmentSnapshot: async () => state.snapshot }));
vi.mock('./portal-client', () => ({ PortalClient: (props: unknown) => <pre>{JSON.stringify(props)}</pre> }));
beforeEach(() => { state.requestedTenant = ''; state.calls = []; state.data = {}; state.errors = {}; state.snapshot = null; });

it('renders unavailable assessment without inventing posture or cross-tenant data', async () => {
  const view = renderToStaticMarkup(await ClientPortalPage({ searchParams: Promise.resolve({ tenant: 'actual' }) }));
  expect(state.requestedTenant).toBe('actual');
  expect(view).toContain('&quot;assessmentUnavailable&quot;:true');
  expect(view).toContain('&quot;engagement&quot;:null');
  expect(view).toContain('Actual tenant');
  for (const table of ['remediation_plans', 'evidence', 'dsars', 'breaches', 'audit_ledger']) {
    expect(state.calls).toContainEqual([table, 'tenant_id', 'tenant-1']);
  }
});

it('marks partial source failure and does not convert missing dates into SLA values', async () => {
  state.errors.evidence = new Error('read unavailable');
  state.data.dsars = [{ id: 'dsar-1', kind: 'access', status: 'open', data_principal_name: 'Asha', due_by: 'invalid', received_at: '2026-10-01' }];
  const view = renderToStaticMarkup(await ClientPortalPage({ searchParams: Promise.resolve({}) }));
  expect(view).toContain('&quot;loadError&quot;:true');
  expect(view).toContain('&quot;slaDays&quot;:null');
  expect(view).not.toContain('NaN');
});

it('reads the exact saved engagement within the tenant and preserves its source figures', async () => {
  state.snapshot = {
    engagement: { id: 'eng-1', title: 'Saved review', status: 'active' },
    exposureInr: 0, summary: { pass: 1, partial: 0, fail: 0, unassessed: 0 },
    controls: [{ id: 'control-1' }],
  };
  state.data.engagements = { posture_score: 0.7, started_at: '2026-10-01' };
  const view = renderToStaticMarkup(await ClientPortalPage({ searchParams: Promise.resolve({}) }));
  expect(state.calls).toContainEqual(['engagements', 'tenant_id', 'tenant-1']);
  expect(state.calls).toContainEqual(['engagements', 'id', 'eng-1']);
  expect(view).toContain('&quot;postureScore&quot;:0.7');
  expect(view).toContain('&quot;estimatedExposureInr&quot;:0');
  expect(view).toContain('&quot;assessmentUnavailable&quot;:false');
});
