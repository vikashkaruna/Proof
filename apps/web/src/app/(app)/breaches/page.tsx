import { requireTenantContext } from '@/lib/tenant-context';
import {
  BreachWorkflowClient,
  type BreachRow,
  type NotificationRow,
} from './breach-workflow-client';

export const dynamic = 'force-dynamic';

export default async function BreachesPage() {
  // SEC-3: user-scoped client — RLS applies, and the explicit filters state
  // the intent. The old page read through the service role with no tenant
  // filter and then fabricated an affected count and a countdown; the data
  // below is the recorded state, and every mutation goes through the BFF
  // routes whose RPCs own the clocks and the state machine.
  const { supabase, tenantId } = await requireTenantContext();

  const [breachesRes, notificationsRes] = await Promise.all([
    supabase
      .from('breaches')
      .select(
        'id, title, description, severity, status, occurred_at, detected_at, dpb_notification_due_by, affected_count, data_categories, dpb_notified_at, principals_notified_at',
      )
      .eq('tenant_id', tenantId)
      .order('dpb_notification_due_by', { ascending: true })
      .limit(100),
    supabase
      .from('breach_notifications')
      .select(
        'id, breach_id, kind, status, language, subject, body, reviewed_by, reviewed_at, sent_by, sent_at, delivery_outcome, delivery_attempts, created_at',
      )
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(200),
  ]);

  const breaches = (breachesRes.data ?? []) as unknown as BreachRow[];
  const notifications = (notificationsRes.data ?? []) as unknown as NotificationRow[];

  return <BreachWorkflowClient breaches={breaches} notifications={notifications} />;
}
