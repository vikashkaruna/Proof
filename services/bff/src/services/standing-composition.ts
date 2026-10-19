import type { Env } from '@axiom/config';
import type { ApprovalEngine } from '@axiom/approval-engine';
import { createSupabaseAdmin, createAgentLedgerWriter } from '@axiom/supabase';
import { StandingCoordinator, StandingReadinessRefused } from './standing-coordinator.js';
import { readPlanReadiness, approvalGateRefusal } from './approval-readiness.js';
export function createConfiguredStandingCoordinator(env: Env, engine: ApprovalEngine) {
  if (env.AXIOM_STANDING_POLICY_COORDINATOR_ENABLED !== 'true') return null;
  if (!['local', 'test'].includes(env.ENVIRONMENT ?? '') || env.AXIOM_AUTH_MODE !== 'strict')
    throw Error('Standing coordinator deployment refused');
  const db = createSupabaseAdmin();
  return new StandingCoordinator(createAgentLedgerWriter(), engine, {
    async requireReady(tenantId, planId, actionId, signal) {
      const checked = await readPlanReadiness(
        {
          rpc: (name, args) => db.rpc(name, args).abortSignal(signal ?? AbortSignal.timeout(5000)),
        },
        tenantId,
        planId,
      );
      if (!checked.ok) throw Error('Standing readiness unavailable');
      if (
        !checked.readiness.actions.some((a) => a.actionId === actionId) ||
        approvalGateRefusal(checked.readiness, [actionId])
      )
        throw new StandingReadinessRefused('Recorded BR2 proof refused');
    },
  });
}
