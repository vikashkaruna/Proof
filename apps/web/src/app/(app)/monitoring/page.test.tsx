import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import MonitoringPage from './page';

const state = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown[] | null; error: Error | null }>,
  calls: [] as Array<[string, string, unknown]>,
}));
vi.mock('@/lib/tenant-context', () => ({ requireCapabilityContext: async () => ({
  tenantId: 'tenant-1', role: 'viewer', supabase: { from: (table: string) => {
    const query = {
      select: () => query,
      eq: (field: string, value: unknown) => { state.calls.push([table, field, value]); return query; },
      order: () => query, limit: () => query,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(state.results[table] ?? { data: [], error: null }).then(resolve),
    };
    return query;
  } },
}) }));
vi.mock('./alert-actions', () => ({ DispatchAlertsButton: () => null, DismissAlertButton: () => null }));

beforeEach(() => { state.results = {}; state.calls = []; });

it('renders empty bounded monitoring lists without claiming full tenant health', async () => {
  const view = renderToStaticMarkup(await MonitoringPage());
  expect(view).toContain('No alerts dispatched');
  expect(view).toContain('none active in the loaded page');
  expect(view).toContain('none overdue in the loaded page');
  expect(view).not.toContain('all alerts acknowledged');
  expect(state.calls).toContainEqual(['monitoring_alerts', 'tenant_id', 'tenant-1']);
});

it('treats an alert-source error as unavailable rather than zero alerts', async () => {
  state.results.monitoring_alerts = { data: null, error: new Error('read refused') };
  const view = renderToStaticMarkup(await MonitoringPage());
  expect(view).toContain('Monitoring records could not be loaded');
  expect(view).not.toContain('No alerts dispatched');
});
