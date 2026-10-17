import {
  PlanReadinessSchema,
  describeApprovalBlocker,
  describePlanStatusBlocker,
  type ActionApprovalBlocker,
  type PlanReadiness,
} from '@axiom/types';

/**
 * BR-2 readiness for the approval routes, read from `plan_approval_readiness`
 * (migration 0157) — the same rule the approval trigger enforces and the plan
 * screen displays. The route refuses here, before any step-up is spent, with
 * each missing requirement named; the trigger is the backstop under the locks.
 */

interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

export type ReadinessRead =
  { ok: true; readiness: PlanReadiness } | { ok: false; reason: 'not_found' | 'unavailable' };

export async function readPlanReadiness(
  client: RpcClient,
  tenantId: string,
  planId: string,
): Promise<ReadinessRead> {
  const { data, error } = await client.rpc('plan_approval_readiness', {
    p_tenant_id: tenantId,
    p_plan_id: planId,
  });
  if (error) return { ok: false, reason: 'unavailable' };
  if (data == null) return { ok: false, reason: 'not_found' };
  const parsed = PlanReadinessSchema.safeParse(data);
  return parsed.success
    ? { ok: true, readiness: parsed.data }
    : { ok: false, reason: 'unavailable' };
}

export interface GateRefusal {
  status: 422;
  body: {
    error: {
      code: 'plan_not_approvable' | 'actions_ineligible' | 'dry_run_expired';
      message: string;
      details: Record<string, unknown>;
    };
  };
}

/** The refusal for these actions on this plan, or null when all are ready. */
export function approvalGateRefusal(
  readiness: PlanReadiness,
  actionIds: readonly string[],
): GateRefusal | null {
  const statusBlocker = describePlanStatusBlocker(readiness.planStatus);
  if (statusBlocker) {
    return {
      status: 422,
      body: {
        error: {
          code: 'plan_not_approvable',
          message: statusBlocker,
          details: {
            planStatus: readiness.planStatus,
            approvableStatuses: readiness.approvableStatuses,
          },
        },
      },
    };
  }
  const wanted = new Set(actionIds);
  const notReady = readiness.actions.filter((a) => wanted.has(a.actionId) && !a.ready);
  if (notReady.length === 0) return null;

  const ineligible = notReady.map((a) => ({
    id: a.actionId,
    sequence: a.sequence,
    actionType: a.actionType,
    blockers: a.blockers,
    reasons: a.blockers.map((b: ActionApprovalBlocker) => describeApprovalBlocker(b)),
  }));
  const onlyExpired = notReady.every((a) => a.blockers.every((b) => b === 'dry_run_expired'));
  if (onlyExpired) {
    return {
      status: 422,
      body: {
        error: {
          code: 'dry_run_expired',
          message: 'Dry-runs have expired; please re-run before approving',
          details: { expired: notReady.map((a) => a.actionId), ineligible },
        },
      },
    };
  }
  const first = ineligible[0]!;
  return {
    status: 422,
    body: {
      error: {
        code: 'actions_ineligible',
        message:
          `${notReady.length} action(s) are not eligible for approval. ` +
          `Action #${first.sequence} (${first.actionType}): ${first.reasons.join(' ')}`,
        details: { ineligible },
      },
    },
  };
}
