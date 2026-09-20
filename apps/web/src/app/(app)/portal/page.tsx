import { redirect } from 'next/navigation';
import { requireTenantContext } from '@/lib/tenant-context';
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

const DEFAULT_TENANT: TenantSummary = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Demo Client (Acme Fintech Pvt Ltd)',
  slug: 'demo-client',
  tier: 'growth',
  is_sdf: false,
};

function computeSlaDays(dueBy: string | null | undefined): number {
  const now = Date.now();
  const dueTime = dueBy ? new Date(dueBy).getTime() : now + 14 * 86400000;
  return Math.max(0, Math.round((dueTime - now) / (1000 * 60 * 60 * 24)));
}

import { cookies } from 'next/headers';

export default async function ClientPortalPage({
  searchParams,
}: {
  searchParams: Promise<{ tenant?: string }>;
}) {
  const resolvedParams = await searchParams;
  const cookieStore = await cookies();
  const { supabase, userId } = await requireTenantContext();
  const user = { id: userId };

  // SEC-3: was `createSupabaseAdmin()`, which listed EVERY tenant on the
  // platform regardless of who was asking. The `tenants_select_member` RLS
  // policy already expresses the correct rule — Axiom-internal users see all
  // tenants, everyone else sees the ones they belong to — so the user-scoped
  // client gives the right answer without a hand-written check.

  // 1. Fetch available tenants dynamically
  let tenants: TenantSummary[] = [];
  try {
    const { data: dbTenants } = await supabase
      .from('tenants')
      .select('id, name, slug, tier, is_sdf')
      .order('name');
    if (dbTenants && dbTenants.length > 0) {
      tenants = dbTenants.map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug || t.id,
        tier: t.tier,
        is_sdf: t.is_sdf,
      }));
    }
  } catch (err) {
    console.error('Failed to load tenants for portal:', err);
  }

  if (tenants.length === 0) {
    tenants = [DEFAULT_TENANT];
  }

  // 2. Select active tenant (from query param, then cookie, then default)
  const savedTenantSlug = cookieStore.get('axiom_active_tenant')?.value;
  const activeTenantSlug = resolvedParams.tenant || savedTenantSlug;
  const activeTenant: TenantSummary =
    (activeTenantSlug
      ? tenants.find(
          (t) =>
            t.slug === activeTenantSlug ||
            t.id === activeTenantSlug ||
            (activeTenantSlug === 'meridian' && t.slug === 'demo-client') ||
            (activeTenantSlug === 'demo-client' && t.slug === 'meridian'),
        )
      : null) ||
    tenants[0] ||
    DEFAULT_TENANT;

  // 3. Load live actuals for the active tenant
  let engagement: EngagementSummary | null = null;
  let plans: PlanSummary[] = [];
  let evidence: EvidenceSummary[] = [];
  let dsars: DsarSummary[] = [];
  let breaches: BreachSummary[] = [];
  let ledger: LedgerSummary[] = [];

  try {
    const [
      engagementsRes,
      controlsRes,
      findingsRes,
      plansRes,
      actionsRes,
      evidenceRes,
      dsarsRes,
      breachesRes,
      ledgerRes,
    ] = await Promise.all([
      supabase
        .from('engagements')
        .select('id, title, status, posture_score, estimated_exposure_inr, started_at')
        .eq('tenant_id', activeTenant.id)
        .order('started_at', { ascending: false })
        .limit(1),
      supabase.from('controls').select('id', { count: 'exact', head: true }),
      supabase.from('findings').select('id, status').eq('tenant_id', activeTenant.id),
      supabase
        .from('remediation_plans')
        .select('id, title, status, version, generated_by_agent, created_at')
        .eq('tenant_id', activeTenant.id)
        .order('created_at', { ascending: false })
        .limit(10),
      supabase
        .from('remediation_actions')
        .select('id, plan_id, description, action_type, risk_class, blast_radius, approval_status'),
      supabase
        .from('evidence')
        .select(
          'id, content_hash, storage_uri, evidence_type, description, collected_by_agent, collected_at, demonstrates_control_ids',
        )
        .eq('tenant_id', activeTenant.id)
        .order('collected_at', { ascending: false })
        .limit(20),
      supabase
        .from('dsars')
        .select('id, kind, status, data_principal_name, due_by, received_at')
        .eq('tenant_id', activeTenant.id)
        .order('received_at', { ascending: false })
        .limit(15),
      supabase
        .from('breaches')
        .select('id, title, status, severity, dpb_notification_due_by, occurred_at, affected_count')
        .eq('tenant_id', activeTenant.id)
        .order('occurred_at', { ascending: false })
        .limit(10),
      supabase
        .from('audit_ledger')
        .select('sequence_no, actor_id, action_type, result, target_ref, entry_hash, occurred_at')
        .eq('tenant_id', activeTenant.id)
        .order('sequence_no', { ascending: false })
        .limit(20),
    ]);

    // Parse engagement & control counts
    const dbEngagement = engagementsRes.data?.[0];
    const totalControls = controlsRes.count || 43;
    const openFindingsCount = (findingsRes.data || []).filter((f) => f.status === 'open').length;
    const passingControls = Math.max(
      0,
      totalControls -
        (openFindingsCount > 0
          ? openFindingsCount
          : activeTenant.slug === 'aarogya'
            ? 17
            : activeTenant.slug === 'streamline'
              ? 7
              : 11),
    );

    const defaultScore =
      activeTenant.slug === 'aarogya' ? 61 : activeTenant.slug === 'streamline' ? 83 : 74;
    const defaultExposure =
      activeTenant.slug === 'aarogya'
        ? 342000000
        : activeTenant.slug === 'streamline'
          ? 61000000
          : 184000000;

    if (dbEngagement) {
      engagement = {
        id: dbEngagement.id,
        title: dbEngagement.title || `${activeTenant.name} DPDPA Assessment`,
        status: dbEngagement.status || 'assessment',
        postureScore: Number(dbEngagement.posture_score) || defaultScore,
        estimatedExposureInr: Number(dbEngagement.estimated_exposure_inr) || defaultExposure,
        startedAt: dbEngagement.started_at,
        passingControls,
        totalControls,
      };
    } else {
      engagement = {
        id: 'eng-active',
        title: `${activeTenant.name} DPDPA Assessment`,
        status:
          activeTenant.slug === 'aarogya'
            ? 'discovery'
            : activeTenant.slug === 'streamline'
              ? 'review'
              : 'assessment',
        postureScore: defaultScore,
        estimatedExposureInr: defaultExposure,
        startedAt: new Date().toISOString(),
        passingControls,
        totalControls,
      };
    }

    // Parse plans & actions
    const dbPlans = plansRes.data || [];
    const dbActions = actionsRes.data || [];

    plans = dbPlans.map((p) => ({
      id: p.id,
      title: p.title || 'Remediation Plan',
      status: p.status || 'review',
      version: p.version || 1,
      generatedByAgent: p.generated_by_agent || 'sudhaar',
      createdAt: p.created_at,
      actions: dbActions
        .filter((a) => a.plan_id === p.id)
        .map((a) => ({
          id: a.id,
          description: a.description || 'Remediation Action',
          actionType: a.action_type || 'config.update',
          riskClass: a.risk_class || 'low',
          blastRadius: a.blast_radius,
          approvalStatus: a.approval_status || 'awaiting_approval',
        })),
    }));

    // Parse evidence
    if (evidenceRes.data && evidenceRes.data.length > 0) {
      evidence = evidenceRes.data.map((e) => ({
        id: e.id,
        contentHash: e.content_hash || '',
        storageUri: e.storage_uri || '',
        evidenceType: (e.evidence_type || 'document').toUpperCase(),
        description: e.description || 'Cryptographic proof artifact',
        collectedByAgent: e.collected_by_agent || 'saakshi',
        collectedAt: e.collected_at,
        demonstratesControlIds: e.demonstrates_control_ids || [],
      }));
    }

    // Parse DSARs
    if (dsarsRes.data && dsarsRes.data.length > 0) {
      dsars = dsarsRes.data.map((d) => {
        return {
          id: d.id,
          kind: d.kind || 'access',
          status: d.status || 'received',
          principalName: d.data_principal_name || 'Anonymous Principal',
          dueBy: d.due_by,
          receivedAt: d.received_at,
          slaDays: computeSlaDays(d.due_by),
        };
      });
    }

    // Parse Breaches
    if (breachesRes.data && breachesRes.data.length > 0) {
      breaches = breachesRes.data.map((b) => ({
        id: b.id,
        title: b.title,
        status: b.status,
        severity: b.severity,
        dpbNotificationDueBy: b.dpb_notification_due_by,
        occurredAt: b.occurred_at,
        affectedCount: b.affected_count,
      }));
    }

    // Parse Audit Ledger
    if (ledgerRes.data && ledgerRes.data.length > 0) {
      ledger = ledgerRes.data.map((l) => ({
        sequenceNo: Number(l.sequence_no) || 0,
        actorId: l.actor_id || 'system',
        actionType: l.action_type || 'operation',
        result: l.result || 'success',
        targetRef: l.target_ref,
        entryHash: l.entry_hash || '',
        occurredAt: l.occurred_at,
      }));
    }
  } catch (err) {
    console.error('Failed to load portal live data:', err);
  }

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
    />
  );
}
