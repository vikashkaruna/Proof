import { requireTenantContext } from '@/lib/tenant-context';
import { BreachClient, type BreachItem } from './breach-client';

export const dynamic = 'force-dynamic';

export default async function BreachesPage() {
  // SEC-3: was `createSupabaseAdmin()`. The service-role key bypasses RLS
  // by design, and these queries carried no tenant filter, so any
  // authenticated user saw every tenant's data. The client below is
  // user-scoped: RLS applies, and the explicit filters state the intent.
  const { supabase, tenantId } = await requireTenantContext();
  let breachItem: BreachItem | null = null;

  try {
    const { data: dbBreaches } = await supabase
      .from('breaches')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('detected_at', { ascending: false })
      .limit(1);

    if (dbBreaches && dbBreaches.length > 0) {
      const b = dbBreaches[0];
      breachItem = {
        id: b.id,
        title: b.title,
        description: b.description,
        severity: b.severity,
        status: b.status,
        detectedAt: b.detected_at,
        dueAt: b.dpb_notification_due_by,
        affectedCount: b.affected_count || 2100,
        dataCategories: b.data_categories || ['PAN', 'contact'],
      };
    }
  } catch {
    // Fallback
  }

  return <BreachClient initialBreach={breachItem} />;
}
