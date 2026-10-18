/** Trusted server composition. Target RPC credentials are distinct from the human source writer. */
import { z } from 'zod';
import type { OwnedSyntheticRouteDeps } from '../routes/owned-synthetic-plans.js';
import type { OwnedPlanContext, OwnedPostgresPlanPorts } from './owned-execution-plan.js';
import type { OwnedCancellationPorts } from './owned-execution-cancellation.js';
export interface OwnedRpcClient {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): {
    abortSignal(signal: AbortSignal): PromiseLike<{ data: unknown; error: unknown }>;
  };
}
export interface OwnedSyntheticControllerConfig {
  humanWriterFactory(): OwnedRpcClient;
  /** Non-login scoped owned_target_controller RPC role; never runtime business or human-writer credentials. */
  targetControllerFactory(): OwnedRpcClient;
  isKilled(tenantId: string): Promise<boolean>;
}
const authority = z.object({ verified: z.literal(true) }).strict();
export function createOwnedSyntheticController(
  config: OwnedSyntheticControllerConfig,
): OwnedSyntheticRouteDeps {
  const humanRpc = async (name: string, args: Record<string, unknown>) => {
    const result = await config
      .humanWriterFactory()
      .rpc(name, args)
      .abortSignal(AbortSignal.timeout(15000));
    if (result.error) throw Error('Owned human source unavailable');
    return result.data;
  };
  const authArgs = (c: OwnedPlanContext) => ({
    p_tenant_id: c.tenantId,
    p_actor_id: c.actorId,
    p_session_id: c.sessionId,
  });
  const authorize = async (c: OwnedPlanContext, kind: 'plan' | 'stop') => {
    authority.parse(
      await humanRpc(
        kind === 'plan' ? 'verify_owned_human_plan_authority' : 'verify_owned_human_stop_authority',
        authArgs(c),
      ),
    );
  };
  const planPorts = (context: OwnedPlanContext): OwnedPostgresPlanPorts => ({
    authorizeCurrent: async (current) => {
      if (current !== context) throw Error('Owned authority context changed');
      await authorize(current, 'plan');
    },
    rpc: humanRpc,
    validateRoundtrip: async (binding) => {
      if (binding.tenantId !== context.tenantId) throw Error('Owned measurement tenant changed');
      const result = await config
        .targetControllerFactory()
        .rpc('measure_owned_synthetic_target', {
          p_tenant_id: context.tenantId,
          p_binding_id: binding.id,
          p_engagement_id: binding.engagementId,
        })
        .abortSignal(AbortSignal.timeout(15000));
      if (result.error) throw Error('Owned target measurement unavailable');
      return result.data;
    },
    persistInResourceTransaction: async (binding, _proof, args) => {
      if (
        binding.tenantId !== context.tenantId ||
        args.p_tenant_id !== context.tenantId ||
        args.p_actor_id !== context.actorId ||
        args.p_session_id !== context.sessionId ||
        args.p_binding_id !== binding.id ||
        args.p_engagement_id !== binding.engagementId
      )
        throw Error('Owned write source changed');
      return humanRpc('record_owned_measured_plan', args);
    },
  });
  const cancellationPorts = (context: OwnedPlanContext): OwnedCancellationPorts => ({
    authorizeCurrentHuman: async (current) => {
      if (current !== context) throw Error('Owned stop context changed');
      await authorize(current, 'stop');
    },
    cancelOriginalPendingRequest: async (args) => {
      if (
        args.p_tenant_id !== context.tenantId ||
        args.p_actor_id !== context.actorId ||
        args.p_session_id !== context.sessionId ||
        args.p_cancellation_key !== context.idempotencyKey
      )
        throw Error('Owned stop source changed');
      return humanRpc('cancel_owned_human_request', args);
    },
  });
  return {
    isKilled: config.isKilled,
    planPorts,
    cancellationPorts,
    observeEffect: async (context, request) =>
      humanRpc('observe_owned_execution_effect', {
        ...authArgs(context),
        p_operation_key: request.operationKey,
        p_plan_id: request.planId,
        p_action_id: request.actionId,
        p_batch_id: request.batchId,
      }),
    readTargets: async (context, engagementId) =>
      humanRpc('read_owned_human_targets', { ...authArgs(context), p_engagement_id: engagementId }),
    readOriginalOutcome: async (context, operationKey, requestHash) =>
      humanRpc('read_owned_human_request_outcome', {
        ...authArgs(context),
        p_operation_key: operationKey,
        p_request_hash: requestHash,
      }),
  };
}
