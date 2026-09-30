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

export interface MonitoringAlertRow {
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
  metadata: Record<string, unknown>;
  created_at: string;
}

export class MonitoringAlertsService {
  constructor(private readonly db: EvidenceDatabase) {}

  private async rpc(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const query = this.db.rpc(name, args);
    const { data, error } = signal ? await query.abortSignal(signal) : await query;
    if (error) {
      throw new EvidenceError('database_unavailable', 503);
    }
    return data as Record<string, unknown>;
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

    const alerts = data as MonitoringAlertRow[];
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

    if (result.error) {
      throw new EvidenceError(String(result.error), 409);
    }

    return {
      dispatchedCount: Number(result.dispatchedCount ?? 0),
      totalUnread: Number(result.totalUnread ?? 0),
      criticalCount: Number(result.criticalCount ?? 0),
      highCount: Number(result.highCount ?? 0),
    };
  }

  async dismissAlert(
    tenantId: string,
    alertId: string,
    userId: string,
    correlationId: string = randomUUID(),
    signal?: AbortSignal,
  ): Promise<{ dismissed: boolean; alertId: string; acknowledgedBy?: string }> {
    const result = await this.rpc(
      'dismiss_monitoring_alert',
      {
        p_tenant_id: tenantId,
        p_alert_id: alertId,
        p_user_id: userId,
        p_correlation_id: correlationId,
      },
      signal,
    );

    if (result.error) {
      const status = result.error === 'alert_not_found' ? 404 : 409;
      throw new EvidenceError(String(result.error), status);
    }

    return {
      dismissed: Boolean(result.dismissed),
      alertId: String(result.alertId ?? alertId),
      acknowledgedBy: result.acknowledgedBy ? String(result.acknowledgedBy) : undefined,
    };
  }
}
