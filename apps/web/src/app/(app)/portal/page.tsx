import { requireTenantContext } from '@/lib/tenant-context';
import { loadAssessmentSnapshot } from '@/lib/assessment-snapshot';
import {
  PortalClient,
  type TenantSummary,
  type EngagementSummary,
  type PlanSummary,
  type EvidenceSummary,
  type DsarSummary,
  type BreachSummary,
  type LedgerSummary,
} from './portal-client';

export const dynamic = 'force-dynamic';

function computeSlaDays(dueBy: string | null | undefined): number | null {
  if (!dueBy) return null;
  return Math.max(0, Math.round((new Date(dueBy).getTime() - Date.now()) / 86_400_000));
}

/**
 * Client portal. C-W0-7: every figure is read from persisted rows for the
 * verified active tenant. Nothing is invented when data is missing — no demo
 * tenant, per-slug sample scores, default control counts or baseline deltas.
 */
export default async function ClientPortalPage({
  searchParams,
}: {
  searchParams: Promise<{ tenant?: string }>;
}) {
  const { tenant: requested } = await searchParams;
  // Membership is verified here; the query parameter and cookie are only requests.
  const ctx = await requireTenantContext(requested);
  const { supabase, tenantId } = ctx;
  const activeTenant: TenantSummary = { id: tenantId, name: ctx.tenantName, slug: ctx.tenantSlug };
  let loadError = false;

  // RLS lists only tenants this user belongs to (all tenants for Axiom internal).
  let tenants: TenantSummary[] = [activeTenant];
  const tenantList = await supabase
    .from('tenants')
    .select('id, name, slug, tier, is_sdf')
    .order('name');
  if (tenantList.error) loadError = true;
  else if (tenantList.data?.length)
    tenants = tenantList.data.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug || t.id,
      tier: t.tier ?? undefined,
      is_sdf: t.is_sdf ?? undefined,
    }));
  if (!tenants.some((t) => t.id === tenantId)) tenants = [activeTenant, ...tenants];

  const [snapshot, plansRes, evidenceRes, dsarsRes, breachesRes, ledgerRes] = await Promise.all([
    loadAssessmentSnapshot(supabase, tenantId),
    supabase
      .from('remediation_plans')
      .select('id, title, status, version, generated_by_agent, created_at')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(10),
    supabase
      .from('evidence')
      .select(
        'id, content_hash, storage_uri, evidence_type, description, collected_by_agent, collected_at, demonstrates_control_ids',
      )
      .eq('tenant_id', tenantId)
      .order('collected_at', { ascending: false })
      .limit(20),
    supabase
      .from('dsars')
      .select('id, kind, status, data_principal_name, due_by, received_at')
      .eq('tenant_id', tenantId)
      .order('received_at', { ascending: false })
      .limit(15),
    supabase
      .from('breaches')
      .select('id, title, status, severity, dpb_notification_due_by, occurred_at, affected_count')
      .eq('tenant_id', tenantId)
      .order('occurred_at', { ascending: false })
      .limit(10),
    supabase
      .from('audit_ledger')
      .select('sequence_no, actor_id, action_type, result, target_ref, entry_hash, occurred_at')
      .eq('tenant_id', tenantId)
      .order('sequence_no', { ascending: false })
      .limit(20),
  ]);
  if ([plansRes, evidenceRes, dsarsRes, breachesRes, ledgerRes].some((r) => r.error))
    loadError = true;

  // The saved-results projection is the single source for assessment figures.
  let engagement: EngagementSummary | null = null;
  const assessmentUnavailable = snapshot === null;
  if (snapshot?.engagement) {
    const detail = await supabase
      .from('engagements')
      .select('posture_score, started_at')
      .eq('tenant_id', tenantId)
      .eq('id', snapshot.engagement.id)
      .maybeSingle();
    if (detail.error) loadError = true;
    const posture = detail.data?.posture_score;
    engagement = {
      id: snapshot.engagement.id,
      title: snapshot.engagement.title,
      status: snapshot.engagement.status,
      postureScore: posture === null || posture === undefined ? null : Number(posture),
      estimatedExposureInr: snapshot.exposureInr,
      startedAt: detail.data?.started_at ?? undefined,
      summary: snapshot.summary,
      totalControls: snapshot.controls.length,
    };
  }

  const dbPlans = plansRes.data ?? [];
  // Actions only for this tenant's listed plans; never an unfiltered table read.
  let dbActions: Array<{
    id: string;
    plan_id: string;
    description: string | null;
    action_type: string | null;
    risk_class: string | null;
    blast_radius: unknown;
    approval_status: string | null;
  }> = [];
  if (dbPlans.length) {
    const actionsRes = await supabase
      .from('remediation_actions')
      .select('id, plan_id, description, action_type, risk_class, blast_radius, approval_status')
      .eq('tenant_id', tenantId)
      .in(
        'plan_id',
        dbPlans.map((p) => p.id),
      );
    if (actionsRes.error) loadError = true;
    dbActions = actionsRes.data ?? [];
  }

  const plans: PlanSummary[] = dbPlans.map((p) => ({
    id: p.id,
    title: p.title || 'Untitled plan',
    status: p.status,
    version: p.version,
    generatedByAgent: p.generated_by_agent || 'unknown',
    createdAt: p.created_at,
    actions: dbActions
      .filter((a) => a.plan_id === p.id)
      .map((a) => ({
        id: a.id,
        description: a.description || 'Untitled action',
        actionType: a.action_type || 'unknown',
        riskClass: a.risk_class || 'unknown',
        blastRadius: a.blast_radius,
        approvalStatus: a.approval_status || 'unknown',
      })),
  }));

  const evidence: EvidenceSummary[] = (evidenceRes.data ?? []).map((e) => ({
    id: e.id,
    contentHash: e.content_hash || '',
    storageUri: e.storage_uri || '',
    evidenceType: (e.evidence_type || 'unknown').toUpperCase(),
    description: e.description || '',
    collectedByAgent: e.collected_by_agent || 'unknown',
    collectedAt: e.collected_at,
    demonstratesControlIds: e.demonstrates_control_ids || [],
  }));

  const dsars: DsarSummary[] = (dsarsRes.data ?? []).map((d) => ({
    id: d.id,
    kind: d.kind,
    status: d.status,
    principalName: d.data_principal_name || 'Name withheld',
    dueBy: d.due_by,
    receivedAt: d.received_at,
    slaDays: computeSlaDays(d.due_by),
  }));

  const breaches: BreachSummary[] = (breachesRes.data ?? []).map((b) => ({
    id: b.id,
    title: b.title,
    status: b.status,
    severity: b.severity,
    dpbNotificationDueBy: b.dpb_notification_due_by,
    occurredAt: b.occurred_at,
    affectedCount: b.affected_count,
  }));

  const ledger: LedgerSummary[] = (ledgerRes.data ?? []).map((l) => ({
    sequenceNo: Number(l.sequence_no),
    actorId: l.actor_id || 'system',
    actionType: l.action_type,
    result: l.result,
    targetRef: l.target_ref,
    entryHash: l.entry_hash || '',
    occurredAt: l.occurred_at,
  }));

  return (
    <PortalClient
      tenants={tenants}
      activeTenant={activeTenant}
      engagement={engagement}
      plans={plans}
      evidence={evidence}
      dsars={dsars}
      breaches={breaches}
      ledger={ledger}
      assessmentUnavailable={assessmentUnavailable}
      loadError={loadError}
    />
  );
}
