import { Capability, can } from '@axiom/types';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  PageHeader,
  Stat,
  StatGrid,
  StatusBadge,
  SeverityChip,
  type StatusKind,
} from '@axiom/ui';
import { formatDateTime, relativeTime } from '@axiom/ui';
import { requireCapabilityContext } from '@/lib/tenant-context';
import { computeMonitoringHealth, isScheduleOverdue } from '@/lib/execution-view';
import { DispatchAlertsButton, DismissAlertButton } from './alert-actions';

export const dynamic = 'force-dynamic';

const SCHEDULE_LIMIT = 100;
const DRIFT_LIMIT = 100;

interface ScheduleRow {
  id: string;
  estate_id: string;
  name: string;
  kind: string;
  cadence: string;
  status: string;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  estates: { name?: string } | null;
}

interface DriftRow {
  id: string;
  estate_id: string;
  kind: string;
  severity: string;
  summary: string;
  source_ref: string | null;
  detected_at: string;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  estates: { name?: string } | null;
}

interface AlertRow {
  id: string;
  tenant_id: string;
  alert_type: string;
  severity: string;
  title: string;
  summary: string;
  source_id: string;
  source_type: string;
  status: string;
  dispatched_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  created_at: string;
}

const KIND_LABELS: Record<string, string> = {
  rediscovery: 'Re-discovery',
  reassessment: 'Re-assessment',
  drift_check: 'Drift check',
};

const DRIFT_KIND_LABELS: Record<string, string> = {
  system_added: 'System added',
  system_removed: 'System removed',
  system_changed: 'System changed',
  connection_lost: 'Connection lost',
  control_drift: 'Control drift',
};

const ALERT_TYPE_LABELS: Record<string, string> = {
  drift_critical: 'Critical Drift',
  drift_high: 'High Drift',
  schedule_overdue: 'Schedule Overdue',
  compliance_deadline_burning: 'Statutory Deadline Burning',
  compliance_deadline_breached: 'Statutory Deadline Breached',
};

/**
 * W6 monitoring surface: schedules, drift detections and continuous alerts.
 * Reads `monitoring_schedules`, `drift_events`, and `monitoring_alerts`
 * through the user-scoped client; the health figures are computed with the
 * same definition as the BFF's GET /v1/monitoring/health.
 */
export default async function MonitoringPage() {
  const { supabase, tenantId, role } = await requireCapabilityContext(Capability.POSTURE_READ);
  const canManage = can(Capability.ESTATE_MANAGE, { role });

  const [schedulesRes, driftRes, alertsRes] = await Promise.all([
    supabase
      .from('monitoring_schedules')
      .select(
        `id, estate_id, name, kind, cadence, status, last_run_at, next_run_at, created_at,
         estates (name)`,
      )
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(SCHEDULE_LIMIT),
    supabase
      .from('drift_events')
      .select(
        `id, estate_id, kind, severity, summary, source_ref, detected_at,
         acknowledged_by, acknowledged_at, estates (name)`,
      )
      .eq('tenant_id', tenantId)
      .order('detected_at', { ascending: false })
      .limit(DRIFT_LIMIT),
    supabase
      .from('monitoring_alerts')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(50),
  ]);

  if (schedulesRes.error || driftRes.error || alertsRes.error) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Continuous Monitoring"
          description="Scheduled re-discovery, drift detections and the health of the monitoring itself."
        />
        <p
          role="alert"
          className="rounded-md border border-ember-500 bg-ember-50 p-4 text-sm text-ember-700"
        >
          Monitoring records could not be loaded. Refresh to try again.
        </p>
      </div>
    );
  }

  const schedules = (schedulesRes.data ?? []) as unknown as ScheduleRow[];
  const driftEvents = (driftRes.data ?? []) as unknown as DriftRow[];
  const alerts = (alertsRes.data ?? []) as unknown as AlertRow[];

  const health = computeMonitoringHealth(schedules, driftEvents);
  const unreadAlerts = alerts.filter((a) => a.status === 'unread' || a.status === 'read');
  const criticalAlerts = unreadAlerts.filter((a) => a.severity === 'critical');
  const highAlerts = unreadAlerts.filter((a) => a.severity === 'high');

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <PageHeader
          title="Continuous Monitoring & Alerting"
          description="Registered schedules drive re-discovery, re-assessment and drift checks per estate. Detections and deadlines trigger automated alerts that remain open until acknowledged by a human."
        />
        <DispatchAlertsButton tenantId={tenantId} canManage={canManage} />
      </div>

      <StatGrid>
        <Stat
          label="Schedules shown"
          value={String(schedules.length)}
          hint={`${health.activeSchedules} active · ${schedules.length - health.activeSchedules} paused or retired`}
        />
        <Stat
          label="Overdue schedules shown"
          value={String(health.overdueSchedules)}
          hint={
            health.overdueSchedules > 0
              ? 'active with a next run in the past'
              : 'none overdue in the loaded page'
          }
        />
        <Stat
          label="Drift shown (7 days)"
          value={String(health.drift.detectedLast7Days)}
          hint={Object.entries(health.drift.bySeverity)
            .map(([severity, count]) => `${count} ${severity}`)
            .join(' · ')}
        />
        <Stat
          label="Active alerts shown"
          value={String(unreadAlerts.length)}
          hint={
            unreadAlerts.length > 0
              ? `${criticalAlerts.length} critical · ${highAlerts.length} high`
              : 'none active in the loaded page'
          }
        />
      </StatGrid>

      {/* ─── Continuous Monitoring Alerts ─── */}
      <Card>
        <CardHeader>
          <CardTitle>Continuous monitoring alerts</CardTitle>
          <p className="text-xs text-slate-500">
            Recorded alerts for configuration drift, overdue assessment schedules, and tracked
            deadlines. This view is bounded to recent records.
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {alerts.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 bg-mist-50 p-6 text-center">
              <p className="text-sm font-medium text-indigo-500">No alerts dispatched</p>
              <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
                Alerts recorded for this tenant will appear here and in the alert tray.
              </p>
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-slate-100">
              {alerts.map((a) => {
                const unread = a.status === 'unread' || a.status === 'read';
                return (
                  <div
                    key={a.id}
                    className="flex flex-col gap-1.5 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <SeverityChip severity={a.severity} />
                        <span className="text-xs font-semibold text-slate-700">
                          {ALERT_TYPE_LABELS[a.alert_type] ?? a.alert_type}
                        </span>
                        {unread && <Badge variant="warning">active alert</Badge>}
                        {!unread && <Badge variant="neutral">acknowledged</Badge>}
                      </div>
                      <p className="text-xs font-medium text-slate-800">{a.title}</p>
                      <p className="text-xs text-slate-600">{a.summary}</p>
                      <p className="text-[11px] text-slate-500">
                        dispatched {formatDateTime(a.dispatched_at)} (
                        {relativeTime(a.dispatched_at)})
                        {a.acknowledged_at
                          ? ` · acknowledged ${formatDateTime(a.acknowledged_at)}`
                          : ''}
                      </p>
                    </div>
                    {unread && canManage && (
                      <div className="shrink-0 mt-2 sm:mt-0">
                        <DismissAlertButton
                          tenantId={tenantId}
                          alertId={a.id}
                          canManage={canManage}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── Monitoring Schedules ─── */}
      <Card>
        <CardHeader>
          <CardTitle>Monitoring schedules</CardTitle>
          <p className="text-xs text-slate-500">
            One active schedule per kind per estate. A re-registration retires the schedule it
            replaces, so the cadence history stays readable.
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {schedules.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 bg-mist-50 p-6 text-center">
              <p className="text-sm font-medium text-indigo-500">No schedules registered</p>
              <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
                An estate manager registers re-discovery, re-assessment or drift-check schedules per
                estate. Nothing is sampled here until a schedule exists.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border border-slate-200">
              <table className="w-full text-left text-xs">
                <thead className="bg-mist-100 text-[10px] uppercase tracking-wider text-slate-500">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Name
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Estate
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Kind
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Cadence (cron)
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Status
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Last run
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Next run
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {schedules.map((s) => {
                    const isOverdue = isScheduleOverdue(s, health.checkedAt);
                    return (
                      <tr key={s.id} className={isOverdue ? 'bg-ember-50/50' : undefined}>
                        <td className="px-3 py-2 font-medium text-slate-700">{s.name}</td>
                        <td className="px-3 py-2 text-slate-600">
                          {s.estates?.name ?? s.estate_id.slice(0, 8)}
                        </td>
                        <td className="px-3 py-2 text-slate-600">
                          {KIND_LABELS[s.kind] ?? s.kind}
                        </td>
                        <td className="px-3 py-2 font-mono text-[11px] text-indigo-700">
                          {s.cadence}
                        </td>
                        <td className="px-3 py-2">
                          <StatusBadge status={s.status as StatusKind} />
                        </td>
                        <td className="px-3 py-2 text-slate-500">
                          {s.last_run_at ? formatDateTime(s.last_run_at) : 'never'}
                        </td>
                        <td className="px-3 py-2">
                          <span className="text-slate-600">
                            {s.next_run_at ? formatDateTime(s.next_run_at) : '—'}
                          </span>
                          {isOverdue && (
                            <Badge variant="danger" className="ml-2">
                              overdue
                            </Badge>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── Drift Events ─── */}
      <Card>
        <CardHeader>
          <CardTitle>Drift events</CardTitle>
          <p className="text-xs text-slate-500">
            Detections from the drift-check schedules: estate shape changes, lost connections and
            control drift. Severity uses the standard scale — high and critical are the alarms the
            unacknowledged count is about.
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {driftEvents.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 bg-mist-50 p-6 text-center">
              <p className="text-sm font-medium text-indigo-500">No drift detected</p>
              <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
                When a drift check finds the estate has moved — a new system, a lost connection, a
                control that no longer holds — the detection is recorded here and stays open until
                acknowledged.
              </p>
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-slate-100">
              {driftEvents.map((e) => {
                const acknowledged = e.acknowledged_at != null;
                return (
                  <div key={e.id} className="flex flex-col gap-1 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <SeverityChip severity={e.severity} />
                      <span className="text-xs font-semibold text-slate-700">
                        {DRIFT_KIND_LABELS[e.kind] ?? e.kind}
                      </span>
                      {!acknowledged && <Badge variant="warning">unacknowledged</Badge>}
                    </div>
                    <p className="text-xs text-slate-600">{e.summary}</p>
                    <p className="text-[11px] text-slate-500">
                      {e.estates?.name ?? e.estate_id.slice(0, 8)} · detected{' '}
                      {formatDateTime(e.detected_at)} ({relativeTime(e.detected_at)})
                      {e.source_ref ? ` · source ${e.source_ref}` : ''}
                      {acknowledged ? ` · acknowledged ${formatDateTime(e.acknowledged_at)}` : ''}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
          {health.unacknowledgedTotal > 0 && (
            <p className="rounded-md border border-ember-500 bg-ember-50 p-3 text-xs text-ember-700">
              {health.unacknowledgedTotal} detection(s) still lack a human acknowledgement.
              Acknowledging records who judged the detection and when — it is the close of the
              monitoring loop.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
