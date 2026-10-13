import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import MonitoringPage from './page';

const state = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown[] | null; error: Error | null }>,
  calls: [] as Array<[string, string, unknown]>,
}));
vi.mock('@/lib/tenant-context', () => ({
  requireCapabilityContext: async () => ({
    tenantId: 'tenant-1',
    role: 'viewer',
    supabase: {
      from: (table: string) => {
        const query = {
          select: () => query,
          eq: (field: string, value: unknown) => {
            state.calls.push([table, field, value]);
            return query;
          },
          order: () => query,
          limit: () => query,
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve(state.results[table] ?? { data: [], error: null }).then(resolve),
        };
        return query;
      },
    },
  }),
}));
const outcomeLoader = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('@/lib/monitoring-outcomes', () => ({ loadMonitoringOutcomes: outcomeLoader.load }));
vi.mock('./alert-actions', () => ({
  DispatchAlertsButton: () => null,
  DismissAlertButton: () => null,
}));

beforeEach(() => {
  state.results = {};
  state.calls = [];
  outcomeLoader.load.mockResolvedValue(null);
});

it('renders empty bounded monitoring lists without claiming full tenant health', async () => {
  const view = renderToStaticMarkup(await MonitoringPage());
  expect(view).toContain('No alerts in the loaded page');
  expect(view).toContain('none active in the loaded page');
  expect(view).toContain('none overdue in the loaded page');
  expect(view).not.toContain('all alerts acknowledged');
  expect(view).not.toContain('rounded-xl bg-white p-1 text-slate-800 shadow-sm');
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
  state.results.monitoring_schedules = {
    data: [
      {
        id: 'schedule-1',
        estate_id: 'estate-1',
        name: 'Saved schedule',
        kind: 'drift_check',
        cadence: '0 0 * * *',
        status: 'active',
        last_run_at: null,
        next_run_at: '2020-01-01T00:00:00Z',
        created_at: '2026-10-01',
        estates: { name: 'Actual estate' },
      },
    ],
    error: null,
  };
  state.results.drift_events = {
    data: [
      {
        id: 'drift-1',
        estate_id: 'estate-1',
        kind: 'system_changed',
        severity: 'high',
        summary: 'Recorded drift',
        source_ref: 'source-1',
        detected_at: '2026-10-01T00:00:00Z',
        acknowledged_by: null,
        acknowledged_at: null,
        estates: { name: 'Actual estate' },
      },
    ],
    error: null,
  };
  state.results.monitoring_alerts = {
    data: [
      {
        id: 'alert-1',
        tenant_id: 'tenant-1',
        alert_type: 'drift_high',
        severity: 'high',
        title: 'Recorded alert',
        summary: 'Source-backed alert',
        source_id: 'drift-1',
        source_type: 'drift',
        status: 'unread',
        dispatched_at: '2026-10-01T00:00:00Z',
        acknowledged_at: null,
        acknowledged_by: null,
        created_at: '2026-10-01T00:00:00Z',
      },
    ],
    error: null,
  };
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

const retainedFire = {
  fireId: '11111111-1111-4111-8111-111111111111',
  estateId: '11111111-1111-4111-8111-111111111111',
  kind: 'drift_check',
  dueAt: '2026-01-01T00:00:00Z',
  calculationAfter: '2026-01-01T00:01:00Z',
  nextRunAt: '2026-01-01T00:15:00Z',
  correlationId: '11111111-1111-4111-8111-111111111111',
  observationOutcome: 'drift_detected',
  recordingOutcome: 'failed',
  failureCode: 'event_recording_failed',
  detectedCount: 2,
  recordedCount: 0,
  failedCount: 2,
  scheduleReceipt: { id: '12', entryHash: 'a'.repeat(64) },
};
function savedSchedule() {
  state.results.monitoring_schedules = {
    data: [
      {
        id: 'schedule-1',
        estate_id: 'estate-1',
        name: 'Saved schedule',
        kind: 'drift_check',
        cadence: '*/15 * * * *',
        status: 'active',
        last_run_at: '2026-01-01T00:01:00Z',
        next_run_at: '2099-01-01T00:00:00Z',
        created_at: '2026-01-01',
        estates: { name: 'Actual estate' },
      },
    ],
    error: null,
  };
}
it('a future next time does not conceal atomic event-recording failure or invent recorded events', async () => {
  savedSchedule();
  outcomeLoader.load.mockResolvedValue({
    tenantId: 'tenant-1',
    schedules: [{ scheduleId: 'schedule-1', state: 'retained', fire: retainedFire }],
  });
  const view = renderToStaticMarkup(await MonitoringPage());
  expect(view).toContain('recording failed');
  expect(view).toContain('Detected 2 · recorded 0 · failed 2');
  expect(view).toContain('Ledger receipt #12');
  expect(view).toContain('1 failed or unwired latest outcomes');
  expect(view).toContain('none overdue in the loaded page');
});
it('unwired execution is an explicit retained failure, not a successful fresh schedule', async () => {
  savedSchedule();
  outcomeLoader.load.mockResolvedValue({
    tenantId: 'tenant-1',
    schedules: [
      {
        scheduleId: 'schedule-1',
        state: 'retained',
        fire: {
          ...retainedFire,
          observationOutcome: 'unwired',
          failureCode: 'live_executor_unwired',
          detectedCount: 0,
          failedCount: 0,
        },
      },
    ],
  });
  const view = renderToStaticMarkup(await MonitoringPage());
  expect(view).toContain('live executor unwired');
  expect(view).toContain('Detected 0 · recorded 0 · failed 0');
  expect(view).toContain('recording failed');
});
it('missing journal is no retained outcome even when legacy last_run_at exists', async () => {
  savedSchedule();
  outcomeLoader.load.mockResolvedValue({
    tenantId: 'tenant-1',
    schedules: [{ scheduleId: 'schedule-1', state: 'never_recorded', fire: null }],
  });
  const view = renderToStaticMarkup(await MonitoringPage());
  expect(view).toContain('No retained outcome');
  expect(view).not.toContain('Detected 0');
  expect(view).not.toContain('never run');
});
it('readback outage keeps schedule visible but reports unavailable rather than invented zero', async () => {
  savedSchedule();
  const view = renderToStaticMarkup(await MonitoringPage());
  expect(view).toContain('Saved schedule');
  expect(view).toContain('Recorded schedule outcomes are unavailable');
  expect(view).toContain('Outcome unavailable');
  expect(view).not.toContain('0 failed or unwired latest outcomes');
});
