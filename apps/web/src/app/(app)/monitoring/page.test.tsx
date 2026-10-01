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
  expect(view).toContain('No alerts in the loaded page');
  expect(view).toContain('none active in the loaded page');
  expect(view).toContain('none overdue in the loaded page');
  expect(view).not.toContain('all alerts acknowledged');
  expect(state.calls).toContainEqual(['monitoring_alerts', 'tenant_id', 'tenant-1']);
});

it('treats an alert-source error as unavailable rather than zero alerts', async () => {
  state.results.monitoring_alerts = { data: null, error: new Error('read refused') };
  const view = renderToStaticMarkup(await MonitoringPage());
  expect(view).toContain('Monitoring records could not be loaded');
  expect(view).not.toContain('No alerts in the loaded page');
});

it('refuses a missing successful source body rather than converting it into empty monitoring', async () => {
  state.results.monitoring_alerts = { data: null, error: null };
  const view = renderToStaticMarkup(await MonitoringPage());
  expect(view).toContain('Monitoring records could not be loaded');
  expect(view).not.toContain('No alerts in the loaded page');
});

it('renders only recorded tenant alerts, schedules and drift with visible loaded-page limits', async () => {
  state.results.monitoring_schedules = { data: [{ id: 'schedule-1', estate_id: 'estate-1', name: 'Saved schedule', kind: 'drift_check', cadence: '0 0 * * *', status: 'active', last_run_at: null, next_run_at: '2020-01-01T00:00:00Z', created_at: '2026-10-01', estates: { name: 'Actual estate' } }], error: null };
  state.results.drift_events = { data: [{ id: 'drift-1', estate_id: 'estate-1', kind: 'system_changed', severity: 'high', summary: 'Recorded drift', source_ref: 'source-1', detected_at: '2026-10-01T00:00:00Z', acknowledged_by: null, acknowledged_at: null, estates: { name: 'Actual estate' } }], error: null };
  state.results.monitoring_alerts = { data: [{ id: 'alert-1', tenant_id: 'tenant-1', alert_type: 'drift_high', severity: 'high', title: 'Recorded alert', summary: 'Source-backed alert', source_id: 'drift-1', source_type: 'drift', status: 'unread', dispatched_at: '2026-10-01T00:00:00Z', acknowledged_at: null, acknowledged_by: null, created_at: '2026-10-01T00:00:00Z' }], error: null };
  const view = renderToStaticMarkup(await MonitoringPage());
  for (const table of ['monitoring_schedules', 'drift_events', 'monitoring_alerts']) {
    expect(state.calls).toContainEqual([table, 'tenant_id', 'tenant-1']);
  }
  expect(view).toContain('Recorded alert');
  expect(view).toContain('Saved schedule');
  expect(view).toContain('Recorded drift');
  expect(view).toContain('loaded detection(s) lack a human acknowledgement');
  expect(view).not.toContain('No alerts in the loaded page');
});
