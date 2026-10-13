import { createClient } from '@supabase/supabase-js';
import { loadEnv } from '@axiom/config';
import {
  monitoringOutcomeRequestSchema,
  monitoringOutcomesSchema,
  type MonitoringOutcomes,
} from '@axiom/types';

/** The caller's authenticated JWT, never a privileged writer or admin fallback. */
export async function loadMonitoringOutcomes(
  tenantId: string,
  token: string,
  scheduleIds: string[],
): Promise<MonitoringOutcomes | null> {
  const request = monitoringOutcomeRequestSchema.safeParse({ tenantId, scheduleIds });
  if (!request.success || !token) return null;
  try {
    const env = loadEnv();
    const client = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data, error } = await client.rpc('read_monitoring_outcomes', {
      p_tenant_id: tenantId,
      p_schedule_ids: scheduleIds,
    });
    const parsed = monitoringOutcomesSchema.safeParse(data);
    if (
      error ||
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
