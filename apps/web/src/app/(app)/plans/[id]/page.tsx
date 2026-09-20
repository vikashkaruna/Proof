import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireCapabilityContext, Capability } from '@/lib/tenant-context';
import { can } from '@axiom/types';
import {
  PageHeader,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Badge,
  StatusBadge,
  SeverityChip,
  Button,
  AgentIcon,
  ProofSeal,
  type StatusKind,
} from '@axiom/ui';
import { formatDateTime, formatINR, truncateHash } from '@axiom/ui';
import { ApprovalActions } from './approval-actions';
import { KillSwitchButton } from './kill-switch-button';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

interface BlastRadius {
  recordsAffected?: number;
  systemsAffected?: string[];
  environment?: string;
}

interface RemediationAction {
  id: string;
  sequence: number;
  action_type: string;
  description: string;
  risk_class: 'low' | 'medium' | 'high' | 'critical';
  risk_score: number;
  closes_finding_ids: string[] | null;
  dry_run_status: string;
  dry_run_completed_at: string | null;
  dry_run_expires_at: string | null;
  dry_run_result: unknown;
  rollback_validated: boolean;
  rollback_definition: { estimatedRollbackTimeSeconds?: number } | null;
  approval_status: string;
  approved_at: string | null;
  blast_radius: BlastRadius | null;
}

interface PlanDetail {
  id: string;
  title: string;
  description: string | null;
  tenant_id: string;
  version: number;
  status: string;
  library_version: string;
  created_at: string;
  aggregate_blast_radius: BlastRadius | null;
  remediation_actions: RemediationAction[];
  tenants: { name?: string } | null;
}

export default async function PlanDetailPage({ params }: PageProps) {
  const { id } = await params;
  // W1 · SEC-9/SEC-8: this page read the session directly, so any signed-in
  // user could open any plan the RLS policy let through, and — once login MFA
  // landed — could do so without having met the second factor.
  const { supabase, email, role, approvalScopes } = await requireCapabilityContext(
    Capability.PLAN_READ,
  );

  // Reading a plan and approving it are different authorities. A viewer sees
  // the actions, the blast radius and the dry-run diff, and no buttons.
  const canApprove = can(Capability.PLAN_APPROVE, { role, approvalScopes });
  const canReject = can(Capability.PLAN_REJECT, { role, approvalScopes });
  const canExecute = can(Capability.PLAN_EXECUTE, { role, approvalScopes });
  const canKillSwitch = can(Capability.KILL_SWITCH_ENGAGE_TENANT, { role });

  const { data: plan, error } = await supabase
    .from('remediation_plans')
    .select(
      `
      *,
      remediation_actions (*),
      tenants:tenant_id (id, name, slug)
    `,
    )
    .eq('id', id)
    .single();

  if (error || !plan) notFound();
  const typedPlan = plan as unknown as PlanDetail;

  const actions = [...(typedPlan.remediation_actions ?? [])].sort(
    (a, b) => a.sequence - b.sequence,
  );

  const eligible = actions.filter(
    (a) => a.dry_run_status === 'dry_run_complete' && a.rollback_validated,
  );
  const blocked = actions.filter(
    (a) => !(a.dry_run_status === 'dry_run_complete' && a.rollback_validated),
  );
  const aggregateBlast = typedPlan.aggregate_blast_radius;

  let activeApprovalToken: string | null = null;
  let activeApprovedActionIds: string[] = [];
  if (typedPlan.status === 'approved') {
    const { data: tokenRow } = await supabase
      .from('approval_tokens')
      .select('*')
      .eq('plan_id', id)
      .eq('status', 'issued')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (tokenRow && tokenRow.signed_payload && tokenRow.signature) {
      activeApprovalToken = JSON.stringify({
        spec: tokenRow.signed_payload,
        signature: tokenRow.signature,
      });
      activeApprovedActionIds = tokenRow.action_ids || [];
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={typedPlan.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700">
              Agent ·
              <span className="inline-flex items-center gap-1">
                <AgentIcon agent="sudhaar" size={16} />
                <span>Sudhaar</span>
              </span>
            </span>
            <span className="text-slate-400">·</span>
            <span>{typedPlan.description ?? 'Deterministic, rollbackable remediation plan.'}</span>
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            {canKillSwitch && (
              <KillSwitchButton planId={typedPlan.id} tenantId={typedPlan.tenant_id} />
            )}
            <Button variant="outline" size="sm" asChild>
              <Link href="/plans">← Back to plans</Link>
            </Button>
          </div>
        }
        meta={
          <>
            <StatusBadge status={typedPlan.status as StatusKind} />
            <Badge variant="indigo">v{typedPlan.version}</Badge>
            <Badge variant="neutral">Library {typedPlan.library_version}</Badge>
            <Badge variant="neutral">Created {formatDateTime(typedPlan.created_at)}</Badge>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
            Aggregate blast radius
          </p>
          <p className="mt-1 font-mono text-2xl font-semibold text-indigo-500">
            {aggregateBlast?.recordsAffected ?? 0}
          </p>
          <p className="text-xs text-slate-500">
            records across {aggregateBlast?.systemsAffected?.length ?? 0} system(s)
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
            Eligible for approval
          </p>
          <p className="mt-1 font-mono text-2xl font-semibold text-teal-700">{eligible.length}</p>
          <p className="text-xs text-slate-500">of {actions.length} actions</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wider text-slate-500">Blocked</p>
          <p className="mt-1 font-mono text-2xl font-semibold text-ember-700">{blocked.length}</p>
          <p className="text-xs text-slate-500">need dry-run or rollback fix</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
            Signed in as
          </p>
          <p className="mt-1 text-sm font-medium text-indigo-500">{email}</p>
          <p className="text-xs text-slate-500">{role} in this tenant</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Approval actions</CardTitle>
          <CardDescription>
            Per ADR-2 / BR-1, no mutating action executes without recorded human approval. The
            signature on the token is verified per-action, not just at batch start (per Doc 04
            §4.3). Each action below carries everything needed to make an informed decision: dry-run
            diff, blast radius, risk, and rollback plan.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ApprovalActions
            planId={typedPlan.id}
            tenantId={typedPlan.tenant_id}
            planStatus={typedPlan.status}
            actions={actions}
            eligible={eligible}
            blocked={blocked}
            initialApprovalToken={activeApprovalToken}
            initialApprovedActionIds={activeApprovedActionIds}
            canApprove={canApprove}
            canReject={canReject}
            canExecute={canExecute}
          />
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3">
        {actions.map((a) => (
          <ActionCard key={a.id} action={a} />
        ))}
      </div>
    </div>
  );
}

function ActionCard({ action }: { action: RemediationAction }) {
  const dryRunOk = action.dry_run_status === 'dry_run_complete';
  const rollbackOk = action.rollback_validated;
  const isApproved = action.approval_status === 'approved';
  const isEligible = dryRunOk && rollbackOk;

  return (
    <div
      className={
        isApproved
          ? 'rounded-xl border-2 border-teal-500 bg-white p-5 shadow-sm'
          : isEligible
            ? 'rounded-xl border border-slate-200 bg-white p-5 shadow-sm'
            : 'rounded-xl border border-ember-500 bg-ember-50/30 p-5 shadow-sm'
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-slate-500">#{action.sequence}</span>
              <code className="rounded bg-mist-100 px-1.5 py-0.5 font-mono text-xs text-indigo-700">
                {action.action_type}
              </code>
              <SeverityChip severity={action.risk_class} />
              {isApproved && <Badge variant="success">Approved</Badge>}
            </div>
            <p className="text-sm text-slate-700">{action.description}</p>
          </div>
          <div className="text-right text-xs text-slate-500">
            <p>
              Risk score: <span className="font-mono">{action.risk_score}</span>
            </p>
            <p>Closes: {action.closes_finding_ids?.length ?? 0} finding(s)</p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-md border border-slate-200 bg-mist-50 p-3">
            <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
              Blast radius
            </p>
            <p className="mt-1 font-mono text-sm text-slate-700">
              {action.blast_radius?.recordsAffected ?? 0} records
            </p>
            <p className="text-xs text-slate-500">
              env: {action.blast_radius?.environment ?? 'n/a'}
            </p>
          </div>
          <div className="rounded-md border border-slate-200 bg-mist-50 p-3">
            <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
              Dry-run
            </p>
            <p className="mt-1 text-sm">
              <StatusBadge status={action.dry_run_status as StatusKind} />
            </p>
            {action.dry_run_completed_at && (
              <p className="text-xs text-slate-500">
                {formatDateTime(action.dry_run_completed_at)}
              </p>
            )}
            {action.dry_run_expires_at && (
              <p className="text-xs text-slate-500">
                expires {formatDateTime(action.dry_run_expires_at)}
              </p>
            )}
          </div>
          <div className="rounded-md border border-slate-200 bg-mist-50 p-3">
            <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
              Rollback
            </p>
            <p className="mt-1 text-sm">
              {rollbackOk ? <StatusBadge status="approved" /> : <StatusBadge status="awaiting" />}
            </p>
            <p className="text-xs text-slate-500">
              ~{action.rollback_definition?.estimatedRollbackTimeSeconds ?? 0}s
            </p>
          </div>
          <div className="rounded-md border border-slate-200 bg-mist-50 p-3">
            <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
              Approval
            </p>
            <p className="mt-1 text-sm">
              <StatusBadge status={action.approval_status as StatusKind} />
            </p>
            {action.approved_at && (
              <p className="text-xs text-slate-500">{formatDateTime(action.approved_at)}</p>
            )}
          </div>
        </div>

        <details className="rounded-md border border-slate-200 bg-mist-50 p-3">
          <summary className="cursor-pointer text-sm font-medium text-indigo-700">
            View dry-run diff
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-md bg-slate-900 p-3 font-mono text-xs text-slate-100">
            {JSON.stringify(
              action.dry_run_result ?? { note: 'no dry-run result captured' },
              null,
              2,
            )}
          </pre>
        </details>

        <details className="rounded-md border border-slate-200 bg-mist-50 p-3">
          <summary className="cursor-pointer text-sm font-medium text-indigo-700">
            View rollback plan
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-md bg-slate-900 p-3 font-mono text-xs text-slate-100">
            {JSON.stringify(action.rollback_definition, null, 2)}
          </pre>
        </details>
      </div>
    </div>
  );
}
