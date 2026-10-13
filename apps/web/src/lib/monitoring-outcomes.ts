import type { SupabaseClient } from '@supabase/supabase-js';
import {
  monitoringOutcomeRequestSchema,
  monitoringOutcomesSchema,
  type MonitoringOutcomes,
} from '@axiom/types';

/** User-session BFF read; missing/unreadable proof is never converted into zero runs. */
export async function loadMonitoringOutcomes(
  supabase: SupabaseClient,
  tenantId: string,
  scheduleIds: string[],
): Promise<MonitoringOutcomes | null> {
  if (!monitoringOutcomeRequestSchema.safeParse({ tenantId, scheduleIds }).success) return null;
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.access_token) return null;
    const url = new URL(
      '/v1/monitoring/outcomes',
      process.env.BFF_PUBLIC_URL || 'http://localhost:4000',
    );
    url.searchParams.set('scheduleIds', scheduleIds.join(','));
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${session.access_token}`, 'X-Tenant-Id': tenantId },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || !('data' in body)) return null;
    const parsed = monitoringOutcomesSchema.safeParse(body.data);
    if (
      !parsed.success ||
      parsed.data.tenantId !== tenantId ||
      parsed.data.schedules.length !== scheduleIds.length ||
      parsed.data.schedules.some((s, i) => s.scheduleId !== scheduleIds[i])
    )
      return null;
    return parsed.data;
  } catch {
    return null;
  }
}
