import Link from 'next/link';
import { Capability } from '@axiom/types';
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
  type StatusKind,
} from '@axiom/ui';
import { formatDateTime, relativeTime, truncateHash } from '@axiom/ui';
import { requireCapabilityContext } from '@/lib/tenant-context';

export const dynamic = 'force-dynamic';

const POLICY_LIMIT = 100;
const EVALUATION_LIMIT = 50;

interface PolicyRow {
  id: string;
  name: string;
  version: number;
  scope: Record<string, unknown> | null;
  status: string;
  created_by: string;
  approved_by: string;
  expires_at: string;
  created_at: string;
}

interface EvaluationRow {
  id: string;
  policy_id: string;
  plan_id: string | null;
  decision: string;
  matched_scope: unknown;
  evaluated_at: string;
  standing_approval_policies: { name?: string } | null;
}

const DECISION_VARIANTS: Record<
  string,
  { label: string; variant: 'success' | 'warning' | 'danger' | 'neutral' }
> = {
  within_policy: { label: 'Within policy', variant: 'success' },
  escalated: { label: 'Escalated to human', variant: 'warning' },
  expired: { label: 'Policy expired', variant: 'neutral' },
  revoked: { label: 'Policy revoked', variant: 'danger' },
};

/**
 * Render the policy's scope object. `action_types` is mandatory (the table
 * check requires it); every other key the author recorded is shown as-is
 * rather than guessed at.
 */
function ScopeSummary({ scope }: { scope: Record<string, unknown> | null }) {
  if (!scope) return null;
  const actionTypes = Array.isArray(scope.action_types) ? scope.action_types : [];
  const rest = Object.entries(scope).filter(([key]) => key !== 'action_types');
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        {actionTypes.length === 0 ? (
          <span className="text-[11px] text-ember-700">
            No action types scoped — the policy can match nothing.
          </span>
        ) : (
          actionTypes.map((t) => (
            <code
              key={String(t)}
              className="rounded bg-mist-100 px-1.5 py-0.5 font-mono text-[10px] text-indigo-700"
            >
              {String(t)}
            </code>
          ))
        )}
      </div>
      {rest.length > 0 && (
        <p className="text-[11px] text-slate-500">
          {rest
            .map(([key, value]) => {
              const rendered = Array.isArray(value)
                ? value.join(', ')
                : typeof value === 'object' && value !== null
                  ? JSON.stringify(value)
                  : String(value);
              return `${key}: ${rendered}`;
            })
            .join(' · ')}
        </p>
      )}
    </div>
  );
}

/**
 * W6 standing-policy surface: the human-authored, human-approved, expiring
 * policies and what the policy engine did with them.
 *
 * The standing-policy engine itself (which issues scoped approval tokens
 * through the existing gate or escalates) has not landed — its BFF routes do
 * not exist yet — so this page is deliberately read-only: it shows the
 * policies recorded in `standing_approval_policies` and the decisions in
 * `policy_evaluations` (migration 0065), through the user-scoped client.
 */
export default async function PoliciesPage() {
  const { supabase, tenantId } = await requireCapabilityContext(Capability.TENANT_SETTINGS_WRITE);

  const [policiesRes, evaluationsRes] = await Promise.all([
    supabase
      .from('standing_approval_policies')
      .select('id, name, version, scope, status, created_by, approved_by, expires_at, created_at')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(POLICY_LIMIT),
    supabase
      .from('policy_evaluations')
      .select(
        `id, policy_id, plan_id, decision, matched_scope, evaluated_at,
         standing_approval_policies (name)`,
      )
      .eq('tenant_id', tenantId)
      .order('evaluated_at', { ascending: false })
      .limit(EVALUATION_LIMIT),
  ]);

  if (policiesRes.error || evaluationsRes.error) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Standing Approval Policies"
          description="Human-authored, expiring policies the engine evaluates actions against — through the approval gate, never around it."
        />
        <p
          role="alert"
          className="rounded-md border border-ember-500 bg-ember-50 p-4 text-sm text-ember-700"
        >
          Policy records could not be loaded. Refresh to try again.
        </p>
      </div>
    );
  }

  const policies = (policiesRes.data ?? []) as unknown as PolicyRow[];
  const evaluations = (evaluationsRes.data ?? []) as unknown as EvaluationRow[];

  const active = policies.filter((p) => p.status === 'active');
  const escalated = evaluations.filter((e) => e.decision === 'escalated').length;
  const withinPolicy = evaluations.filter((e) => e.decision === 'within_policy').length;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Standing Approval Policies"
        description="A standing policy is authored by a human and approved by a different human, is bounded in scope, and expires. When the policy engine lands it will issue scoped approval tokens through the existing approval gate for in-policy actions and escalate everything else — it never bypasses the dry-run, rollback and token checks (BR-1/BR-2)."
      />

      <StatGrid>
        <Stat label="Policies" value={String(policies.length)} hint={`${active.length} active`} />
        <Stat
          label="Evaluations recorded"
          value={String(evaluations.length)}
          hint="most recent decisions"
        />
        <Stat label="Within policy" value={String(withinPolicy)} hint="matched a standing policy" />
        <Stat label="Escalated" value={String(escalated)} hint="sent to a human approver" />
      </StatGrid>

      <Card>
        <CardHeader>
          <CardTitle>Standing policies</CardTitle>
          <p className="text-xs text-slate-500">
            Each policy is versioned and expiring. A policy row with no named author or approver
            cannot exist — the columns are mandatory, because an orphan policy is an unaccountable
            one.
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {policies.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 bg-mist-50 p-6 text-center">
              <p className="text-sm font-medium text-indigo-500">No standing policies</p>
              <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-slate-500">
                No policy has been authored for this tenant yet. Every action therefore takes the
                normal path: dry-run, validated rollback, a recorded human approval per instance,
                and execution under a signed token. The authoring surface arrives with the
                standing-policy engine.
              </p>
            </div>
          ) : (
            policies.map((p) => (
              <div key={p.id} className="rounded-lg border border-slate-200 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-slate-800">{p.name}</span>
                  <Badge variant="indigo">v{p.version}</Badge>
                  <StatusBadge status={p.status as StatusKind} />
                </div>
                <ScopeSummary scope={p.scope} />
                <p className="mt-2 text-[11px] text-slate-500">
                  Created {formatDateTime(p.created_at)} · expires {formatDateTime(p.expires_at)} (
                  {relativeTime(p.expires_at)}) · author{' '}
                  <span className="font-mono">{truncateHash(p.created_by, 6)}</span> · approver{' '}
                  <span className="font-mono">{truncateHash(p.approved_by, 6)}</span>
                </p>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Policy evaluations</CardTitle>
          <p className="text-xs text-slate-500">
            What the engine decided and when — append-only, so a policy&apos;s history cannot be
            rewritten after the fact.
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {evaluations.length === 0 ? (
            <p className="rounded-md bg-mist-50 p-3 text-xs text-slate-500">
              No evaluations recorded. Evaluations appear once the standing-policy engine is live
              and has judged a plan against one of these policies.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-slate-200">
              <table className="w-full text-left text-xs">
                <thead className="bg-mist-100 text-[10px] uppercase tracking-wider text-slate-500">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Policy
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Decision
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Plan
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Evaluated
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {evaluations.map((e) => {
                    const decision = DECISION_VARIANTS[e.decision] ?? {
                      label: e.decision,
                      variant: 'neutral' as const,
                    };
                    return (
                      <tr key={e.id}>
                        <td className="px-3 py-2 font-medium text-slate-700">
                          {e.standing_approval_policies?.name ?? e.policy_id.slice(0, 8)}
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant={decision.variant}>{decision.label}</Badge>
                        </td>
                        <td className="px-3 py-2">
                          {e.plan_id ? (
                            <Link href={`/plans/${e.plan_id}`} className="text-teal-700 underline">
                              {e.plan_id.slice(0, 8)}
                            </Link>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-slate-500">
                          {formatDateTime(e.evaluated_at)}
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
    </div>
  );
}
