/**
 * W6 Continuous Alerting Service
 *
 * Scans and queries tenant monitoring alerts for configuration drift,
 * overdue monitoring schedules, and burning/breached compliance deadlines.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EvidenceError, type EvidenceDatabase } from './evidence-ingestion.js';

export const listAlertsQuerySchema = z.object({
  status: z.enum(['unread', 'read', 'dismissed', 'acknowledged']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListAlertsQuery = z.infer<typeof listAlertsQuerySchema>;

export interface AlertSummary {
  total: number;
  unread: number;
  critical: number;
  high: number;
}

const timestamp = z.iso.datetime({ offset: true });
const monitoringAlertRowSchema = z
  .object({
    id: z.uuid(),
    tenant_id: z.uuid(),
    alert_type: z.enum([
      'drift_critical',
      'drift_high',
      'schedule_overdue',
      'compliance_deadline_burning',
      'compliance_deadline_breached',
    ]),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(500),
    source_id: z.string().min(1).max(100),
    source_type: z.enum([
      'drift_event',
      'monitoring_schedule',
      'compliance_event',
      'breach',
      'dsar',
    ]),
    status: z.enum(['unread', 'read', 'dismissed', 'acknowledged']),
    dispatched_at: timestamp,
    created_at: timestamp,
    acknowledged_at: timestamp.nullable(),
    acknowledged_by: z.uuid().nullable(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .strict();
export type MonitoringAlertRow = z.infer<typeof monitoringAlertRowSchema>;

// RPCs return JSON numbers and exact identities. Missing fields are not confirmations.
const count = z.number().int().min(0).max(2_147_483_647);
const dispatchResultSchema = z
  .object({
    dispatchedCount: count,
    totalUnread: count,
    criticalCount: count,
    highCount: count,
  })
  .strict()
  .refine((value) => value.criticalCount + value.highCount <= value.totalUnread);
const dismissalResultSchema = z
  .object({
    dismissed: z.literal(true),
    alertId: z.uuid(),
    acknowledgedBy: z.uuid(),
  })
  .strict();
const dispatchRefusalSchema = z.object({ error: z.literal('tenant_not_found') }).strict();
const dismissalRefusalSchema = z
  .object({
    error: z.enum(['invalid_user', 'alert_not_found', 'already_dismissed']),
  })
  .strict();

export class MonitoringAlertsService {
  constructor(
    private readonly db: EvidenceDatabase,
    private readonly writer: Pick<EvidenceDatabase, 'rpc'> = db,
  ) {}

  private async rpc(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const query = this.db.rpc(name, args);
    const { data, error } = signal ? await query.abortSignal(signal) : await query;
    if (error) {
      throw new EvidenceError('database_unavailable', 503);
    }
    return data as unknown;
  }

  async listAlerts(
    tenantId: string,
    query: ListAlertsQuery = { limit: 50 },
    signal?: AbortSignal,
  ): Promise<{ alerts: MonitoringAlertRow[]; summary: AlertSummary }> {
    const q = this.db
      .from('monitoring_alerts')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(query.limit);

    if (query.status) {
      q.eq('status', query.status);
    }

    const { data, error } = signal ? await q.abortSignal(signal) : await q;
    if (error || !Array.isArray(data)) {
      throw new EvidenceError('database_unavailable', 503);
    }

    const parsed = z.array(monitoringAlertRowSchema).safeParse(data);
    if (!parsed.success || parsed.data.some((alert) => alert.tenant_id !== tenantId.toLowerCase()))
      throw new EvidenceError('database_unavailable', 503);
    const alerts = parsed.data;
    const unread = alerts.filter((a) => a.status === 'unread' || a.status === 'read').length;
    const critical = alerts.filter(
      (a) => (a.status === 'unread' || a.status === 'read') && a.severity === 'critical',
    ).length;
    const high = alerts.filter(
      (a) => (a.status === 'unread' || a.status === 'read') && a.severity === 'high',
    ).length;

    return {
      alerts,
      summary: {
        total: alerts.length,
        unread,
        critical,
        high,
      },
    };
  }

  async dispatchAlerts(
    tenantId: string,
    correlationId: string = randomUUID(),
    signal?: AbortSignal,
  ): Promise<{
    dispatchedCount: number;
    totalUnread: number;
    criticalCount: number;
    highCount: number;
  }> {
    const result = await this.rpc(
      'dispatch_monitoring_alerts',
      {
        p_tenant_id: tenantId,
        p_correlation_id: correlationId,
      },
      signal,
    );

    const refusal = dispatchRefusalSchema.safeParse(result);
    if (refusal.success) throw new EvidenceError(refusal.data.error, 409);
    const confirmed = dispatchResultSchema.safeParse(result);
    if (!confirmed.success) throw new EvidenceError('database_unavailable', 503);
    return confirmed.data;
  }

  async dismissAlert(
    tenantId: string,
    alertId: string,
    userId: string,
    correlationId: string = randomUUID(),
    signal?: AbortSignal,
  ): Promise<{ dismissed: boolean; alertId: string; acknowledgedBy: string }> {
    const query = this.writer.rpc('dismiss_monitoring_alert', {
      p_tenant_id: tenantId,
      p_alert_id: alertId.toLowerCase(),
      p_user_id: userId.toLowerCase(),
      p_correlation_id: correlationId,
    });
    const { data, error } = signal ? await query.abortSignal(signal) : await query;
    if (error) throw new EvidenceError('database_unavailable', 503);
    const refusal = dismissalRefusalSchema.safeParse(data);
    if (refusal.success) {
      throw new EvidenceError(
        refusal.data.error,
        refusal.data.error === 'alert_not_found' ? 404 : 409,
      );
    }
    const confirmed = dismissalResultSchema.safeParse(data);
    if (
      !confirmed.success ||
      confirmed.data.alertId !== alertId.toLowerCase() ||
      confirmed.data.acknowledgedBy !== userId.toLowerCase()
    )
      throw new EvidenceError('database_unavailable', 503);
    return confirmed.data;
  }
}
