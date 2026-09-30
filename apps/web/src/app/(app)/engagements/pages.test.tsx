import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import EngagementsListPage from './page';
import EngagementDetailPage from './[id]/page';

const state = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown; error: Error | null }>,
  calls: [] as Array<[string, string, unknown]>,
}));
vi.mock('@/lib/tenant-context', () => ({ requireTenantContext: async () => ({
  tenantId: 'tenant-1', supabase: { from: (table: string) => {
    const result = () => state.results[table] ?? { data: table === 'engagements' ? null : [], error: null };
    const query = {
      select: () => query,
      eq: (field: string, value: unknown) => { state.calls.push([table, field, value]); return query; },
      order: () => query,
      single: async () => result(),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
    };
    return query;
  } },
}) }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NOT_FOUND'); } }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));

beforeEach(() => { state.results = {}; state.calls = []; });

it('binds the engagement list to the active tenant and reports source failure', async () => {
  state.results.engagements = { data: [], error: null };
  expect(renderToStaticMarkup(await EngagementsListPage())).toContain('No engagements yet.');
  expect(state.calls).toContainEqual(['engagements', 'tenant_id', 'tenant-1']);
  state.results.engagements = { data: null, error: new Error('read failed') };
  const failed = renderToStaticMarkup(await EngagementsListPage());
  expect(failed).toContain('Engagement records are unavailable.');
  expect(failed).not.toContain('No engagements yet.');
});

it('refuses missing or inaccessible engagement detail within the tenant boundary', async () => {
  await expect(EngagementDetailPage({ params: Promise.resolve({ id: 'foreign-1' }) })).rejects.toThrow('NOT_FOUND');
  expect(state.calls).toContainEqual(['engagements', 'tenant_id', 'tenant-1']);
  expect(state.calls).toContainEqual(['engagements', 'id', 'foreign-1']);
  state.results.engagements = { data: null, error: Object.assign(new Error('not found'), { code: 'PGRST116' }) };
  await expect(EngagementDetailPage({ params: Promise.resolve({ id: 'foreign-2' }) })).rejects.toThrow('NOT_FOUND');
  state.results.engagements = { data: null, error: new Error('read failed') };
  await expect(EngagementDetailPage({ params: Promise.resolve({ id: 'error-1' }) })).rejects.toThrow('Engagement record is unavailable');
});

it('shows findings and plan query failures as unavailable for a recorded engagement', async () => {
  state.results.engagements = { data: {
    id: 'eng-1', title: 'Actual assessment', tenants: { name: 'Actual tenant' }, library_version: '1',
    status: 'active', started_at: '2026-10-01T00:00:00Z', posture_score: 0.7, estimated_exposure_inr: 0,
  }, error: null };
  state.results.findings = { data: null, error: new Error('read failed') };
  state.results.remediation_plans = { data: null, error: new Error('read failed') };
  const view = renderToStaticMarkup(await EngagementDetailPage({ params: Promise.resolve({ id: 'eng-1' }) }));
  expect(view).toContain('Actual assessment');
  expect(view).toContain('Remediation plans are unavailable.');
  expect(view).toContain('Findings are unavailable.');
  expect(view).not.toContain('No findings recorded');
  expect(state.calls).toContainEqual(['findings', 'tenant_id', 'tenant-1']);
  expect(state.calls).toContainEqual(['remediation_plans', 'tenant_id', 'tenant-1']);
});
