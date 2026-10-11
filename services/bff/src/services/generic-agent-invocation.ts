import { canonicalJson, sha256 } from '@axiom/ledger';
import { createHumanActionWriter } from '@axiom/supabase';
import { z } from 'zod';
import { logger } from '../lib/logger.js';
import type { RealtimeService } from './realtime.js';
import { serviceAuthHeaders } from './service-auth.js';
import { retainedStageSource } from './saakshi-staging-port.js';
import { retainedSanketInputSchema } from './retained-sanket-source.js';

/** Capability, name/workflow, UUID and owned-engagement checks belong to the caller.
 * The configured start RPC checks live authority again before peer dispatch.
 */
export interface GenericAgentInvocationContext {
  readonly agent: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly engagementId: string | null;
  readonly correlationId: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/** Trusted server-side preparation receives only the recorded immutable dispatch.
 * Its canonical bytes must be persisted verbatim, never reserialized for hashing.
 */
export interface GenericAgentPreparationContext {
  readonly agent: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly engagementId: string | null;
  readonly correlationId: string;
  readonly runId: string;
  readonly requestHash: string;
  readonly canonicalInput: string;
}

export interface GenericAgentInvocationDeps {
  readonly runtimeUrl: string;
  readonly runtimeToken: string;
  readonly prepareDispatch?: (
    context: GenericAgentPreparationContext,
  ) => Promise<{ readonly kind: 'public_source' }>;
  readonly validateOutput?: (output: unknown) => void | Promise<void>;
  /** Only the reviewed Vibhaag route may provide this retained-source transport. */
  readonly reviewedWorkflow?: {
    readonly start: (context: Omit<GenericAgentPreparationContext, 'runId'>) => Promise<unknown>;
    readonly settleSuccess: NonNullable<GenericAgentInvocationDeps['settleSudhaarSuccess']>;
  };
  /** Dedicated Saakshi-only persisted human evidence transport, never a generic storage grant. */
  readonly stagedEvidence?: {
    readonly start: (context: Omit<GenericAgentPreparationContext, 'runId'>) => Promise<unknown>;
    readonly settleSuccess: NonNullable<GenericAgentInvocationDeps['settleSudhaarSuccess']>;
  };
  /** Dedicated Sanket-only retained human capture; never caller source authority. */
  readonly retainedSanket?: {
    readonly start: (context: Omit<GenericAgentPreparationContext, 'runId'>) => Promise<unknown>;
    readonly settleSuccess: NonNullable<GenericAgentInvocationDeps['settleSudhaarSuccess']>;
  };
  /** Trusted Sudhaar-only atomic success capture; failure settlement stays unchanged. */
  readonly settleSudhaarSuccess?: (
    context: GenericAgentPreparationContext & {
      readonly result: GenericAgentRuntimeResult;
      readonly canonicalOutput: string;
      readonly responseHash: string;
    },
  ) => Promise<unknown>;
  readonly sudhaarDispatch?: (context: {
    runId: string;
    requestHash: string;
    wireInput: string;
    correlationId: string;
  }) => Readonly<Record<string, unknown>>;
  readonly realtime: Pick<RealtimeService, 'broadcast'>;
  readonly writerFactory?: () => Pick<ReturnType<typeof createHumanActionWriter>, 'rpc'>;
  readonly fetchImpl?: typeof fetch;
  readonly authHeaders?: typeof serviceAuthHeaders;
  readonly logger?: Pick<typeof logger, 'error'>;
}

export interface GenericAgentRuntimeResult {
  agent: string;
  correlation_id: string;
  status: 'succeeded' | 'failed';
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  error: string | null;
  output: Record<string, unknown> | null;
  ledger_entry_ids: string[];
}

interface GenericAgentError {
  error: {
    code: string;
    message: string;
    runId?: string;
    correlationId?: string;
    runtimeOutcome?: 'unconfirmed' | 'runtime_reported_failure';
  };
}

export type GenericAgentInvocationOutcome =
  | {
      status: 200;
      body: GenericAgentRuntimeResult;
      /** Internal execution provenance only, never an assessment/domain claim. */
      run: { runId: string; correlationId: string; requestHash: string; responseHash: string };
    }
  | { status: 403 | 409 | 502 | 503; body: GenericAgentError };

/** One proof-bound lifecycle for validated, human-triggered generic invocations.
 * Keep BFF request/response hashes separate from normalized runtime receipt hashes.
 * Ambiguous transport or settlement never retries or publishes a success event.
 */
export async function invokeGenericAgent(
  context: GenericAgentInvocationContext,
  deps: GenericAgentInvocationDeps,
): Promise<GenericAgentInvocationOutcome> {
  const { agent, tenantId, actorId, engagementId, correlationId, input } = context;
  const { runtimeUrl, runtimeToken, prepareDispatch } = deps;
  const log = deps.logger ?? logger;
  if (deps.settleSudhaarSuccess && agent !== 'sudhaar')
    return {
      status: 403,
      body: {
        error: { code: 'planning_settlement_refused', message: 'Planning settlement was refused.' },
      },
    };
  if (
    deps.reviewedWorkflow &&
    (agent !== 'vibhaag' ||
      input.mode !== 'reviewed_workflow' ||
      engagementId === null ||
      prepareDispatch ||
      deps.sudhaarDispatch ||
      deps.settleSudhaarSuccess ||
      deps.retainedSanket ||
      !deps.validateOutput)
  )
    return {
      status: 403,
      body: {
        error: {
          code: 'reviewed_workflow_transport_refused',
          message: 'Reviewed workflow transport was refused.',
        },
      },
    };
  const stage = retainedStageSource.safeParse(input);
  if (
    (agent === 'saakshi' && !deps.stagedEvidence) ||
    (deps.stagedEvidence &&
      (agent !== 'saakshi' ||
        !stage.success ||
        stage.data.tenant_id !== tenantId ||
        stage.data.actor_id !== actorId ||
        stage.data.engagement_id !== engagementId ||
        stage.data.operation_key !== correlationId ||
        prepareDispatch ||
        deps.reviewedWorkflow ||
        deps.sudhaarDispatch ||
        deps.settleSudhaarSuccess ||
        deps.retainedSanket ||
        !deps.validateOutput))
  )
    return {
      status: 403,
      body: {
        error: {
          code: 'staged_evidence_transport_refused',
          message: 'Evidence staging was refused.',
        },
      },
    };
  const retained = retainedSanketInputSchema.safeParse(input);
  if (
    (agent === 'sanket' && !deps.retainedSanket) ||
    (deps.retainedSanket &&
      (agent !== 'sanket' ||
        !retained.success ||
        retained.data.tenant_id !== tenantId ||
        retained.data.engagement_id !== engagementId ||
        retained.data.correlation_id !== correlationId ||
        prepareDispatch ||
        deps.reviewedWorkflow ||
        deps.stagedEvidence ||
        deps.sudhaarDispatch ||
        deps.settleSudhaarSuccess ||
        !deps.validateOutput))
  )
    return {
      status: 403,
      body: {
        error: {
          code: 'retained_sanket_transport_refused',
          message: 'Retained public observation transport was refused.',
        },
      },
    };
  // Snapshot wire input before the first await. The request hash still uses
  // the original canonical domain, including its existing undefined semantics.
  const wireInput = JSON.stringify(input);
  const canonicalInput = canonicalJson(input);
  const requestHash = await sha256(canonicalInput);
  let runId: string;
  let writer: Pick<ReturnType<typeof createHumanActionWriter>, 'rpc'>;
  try {
    writer = (deps.writerFactory ?? createHumanActionWriter)();
    const { data, error } =
      (deps.reviewedWorkflow ?? deps.stagedEvidence ?? deps.retainedSanket)
        ? {
            data: await (deps.reviewedWorkflow ??
              deps.stagedEvidence ??
              deps.retainedSanket)!.start(
              Object.freeze({
                agent,
                tenantId,
                actorId,
                engagementId,
                correlationId,
                requestHash,
                canonicalInput,
              }),
            ),
            error: null,
          }
        : await writer
            .rpc('record_generic_agent_run_start', {
              p_tenant_id: tenantId,
              p_actor_id: actorId,
              p_agent: agent,
              p_engagement_id: engagementId,
              p_correlation_id: correlationId,
              p_request_hash: requestHash,
            })
            .abortSignal(AbortSignal.timeout(10000));
    if (error) throw new Error('start_unconfirmed');
    const parsed = z
      .object({ run_id: z.uuid(), created: z.boolean(), status: z.string() })
      .safeParse(data);
    if (!parsed.success) {
      const refusal = z
        .object({ error: z.enum(['forbidden', 'context_refused', 'dispatch_conflict']) })
        .safeParse(data);
      if (refusal.success)
        return {
          status: refusal.data.error === 'forbidden' ? 403 : 409,
          body: { error: { code: refusal.data.error, message: 'Agent dispatch was refused.' } },
        };
      throw new Error('start_unconfirmed');
    }
    runId = parsed.data.run_id;
    if (!parsed.data.created)
      return {
        status: 409,
        body: {
          error: {
            code: 'agent_dispatch_exists',
            message:
              'This invocation is already recorded. Inspect the existing run before retrying.',
            runId,
            correlationId,
          },
        },
      };
    if (parsed.data.status !== 'running') throw new Error('start_unconfirmed');
  } catch {
    log.error({ agent, correlationId }, 'could not record initial agent_run row');
    return {
      status: 503,
      body: {
        error: { code: 'persistence_failed', message: 'Could not record agent invocation.' },
      },
    };
  }

  deps.realtime.broadcast({
    type: 'agent.progress',
    agent,
    correlationId,
    runId,
    step: `${agent}.started`,
    progress: 0.1,
    message: `Agent ${agent} started execution`,
    occurredAt: new Date().toISOString(),
  });

  // The runtime is an authenticated transport peer, not a source of arbitrary
  // public fields or lifecycle authority. Bind its response to this dispatch.
  const resultSchema = z.object({
    agent: z.literal(agent),
    correlation_id: z.literal(correlationId),
    status: z.enum(['succeeded', 'failed']),
    latency_ms: z.number().int().nonnegative().max(2147483647),
    input_tokens: z.number().int().nonnegative().max(2147483647),
    output_tokens: z.number().int().nonnegative().max(2147483647),
    cost_usd: z.number().nonnegative().max(9999.999999),
    error: z.string().max(256).nullable(),
    output: z.record(z.string(), z.unknown()).nullable(),
    ledger_entry_ids: z
      .array(
        z
          .string()
          .regex(/^[1-9][0-9]{0,18}$/)
          .refine((id) => BigInt(id) <= 9223372036854775807n),
      )
      .max(2),
  });
  type RuntimeResult = z.infer<typeof resultSchema>;
  let result: RuntimeResult | null = null;
  let failureCode = 'agent_invocation_failed';
  try {
    let path = `/agents/${agent}/invoke`;
    let transportBody: Record<string, unknown> = {
      correlation_id: correlationId,
      input: JSON.parse(wireInput),
      dispatch_context: { run_id: runId, request_hash: requestHash },
    };
    if (deps.sudhaarDispatch) {
      if (agent !== 'sudhaar') throw new Error('planning_dispatch_refused');
      path = '/assessment-source/sudhaar/invoke';
      transportBody = {
        ...deps.sudhaarDispatch({ runId, requestHash, wireInput: canonicalInput, correlationId }),
      };
    }
    if (prepareDispatch) {
      if (
        (agent !== 'drishti' && agent !== 'vibhaag') ||
        JSON.parse(wireInput).mode !== 'public_website'
      )
        throw new Error('preparation_mode_refused');
      const prepared = await prepareDispatch(
        Object.freeze({
          agent,
          tenantId,
          actorId,
          engagementId,
          correlationId,
          runId,
          requestHash,
          canonicalInput,
        }),
      );
      z.object({ kind: z.literal('public_source') })
        .strict()
        .parse(prepared);
      // The dedicated peer must load the stored dispatch. Never transport
      // public source facts, preparation-controlled URLs, headers or context.
      path = `/public-source/agents/${agent}/invoke`;
      transportBody = { tenant_id: tenantId, run_id: runId, correlation_id: correlationId };
    }
    if (deps.reviewedWorkflow) {
      path = '/reviewed-workflows/agents/vibhaag/invoke';
      transportBody = { tenant_id: tenantId, run_id: runId, operation_key: correlationId };
    }
    if (deps.stagedEvidence) {
      path = '/staged-evidence/agents/saakshi/invoke';
      transportBody = { tenant_id: tenantId, run_id: runId, operation_key: correlationId };
    }
    if (deps.retainedSanket) {
      path = '/retained-public-sources/agents/sanket/invoke';
      transportBody = { tenant_id: tenantId, run_id: runId, operation_key: correlationId };
    }
    const res = await (deps.fetchImpl ?? fetch)(`${runtimeUrl}${path}`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': runtimeToken,
        ...(await (deps.authHeaders ?? serviceAuthHeaders)(runtimeUrl)),
      },
      body: JSON.stringify(transportBody),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error('runtime_http_refused');
    }
    const parsedResult = resultSchema.parse(await res.json());
    if (
      parsedResult.status === 'succeeded' &&
      (parsedResult.error !== null ||
        parsedResult.output === null ||
        parsedResult.ledger_entry_ids.length !== 2 ||
        new Set(parsedResult.ledger_entry_ids).size !== parsedResult.ledger_entry_ids.length)
    )
      throw new Error('runtime_result_refused');
    if (parsedResult.input_tokens + parsedResult.output_tokens > 2147483647)
      throw new Error('runtime_accounting_refused');
    if (parsedResult.status === 'succeeded') await deps.validateOutput?.(parsedResult.output);
    result = parsedResult;
    if (result.status === 'failed') failureCode = 'agent_reported_failure';
  } catch {
    // Fetch, validation and provider errors may include private payloads or
    // bearer credentials. Only fixed failure codes cross this boundary.
    log.error({ agent, correlationId }, 'agent runtime invocation refused');
  }

  const succeeded = result?.status === 'succeeded';
  const terminalStatus = succeeded ? 'succeeded' : 'failed';
  let responseHash: string | null = null;
  try {
    responseHash = succeeded && result ? await sha256(canonicalJson(result.output)) : null;
    if (succeeded && deps.settleSudhaarSuccess && agent !== 'sudhaar')
      throw new Error('planning_settlement_refused');
    const successCapture =
      deps.stagedEvidence?.settleSuccess ??
      deps.retainedSanket?.settleSuccess ??
      deps.reviewedWorkflow?.settleSuccess ??
      deps.settleSudhaarSuccess;
    const { data: recorded, error } =
      succeeded && successCapture
        ? {
            data: await successCapture(
              Object.freeze({
                agent,
                tenantId,
                actorId,
                engagementId,
                correlationId,
                runId,
                requestHash,
                canonicalInput,
                result: result!,
                canonicalOutput: canonicalJson(result!.output),
                responseHash: responseHash!,
              }),
            ),
            error: null,
          }
        : await writer
            .rpc('record_generic_agent_run_finish', {
              p_tenant_id: tenantId,
              p_actor_id: actorId,
              p_run_id: runId,
              p_agent: agent,
              p_engagement_id: engagementId,
              p_correlation_id: correlationId,
              p_request_hash: requestHash,
              p_status: terminalStatus,
              p_error_code: succeeded ? null : failureCode,
              p_latency_ms: result?.latency_ms ?? null,
              p_input_tokens: result?.input_tokens ?? null,
              p_output_tokens: result?.output_tokens ?? null,
              p_cost_usd: result?.cost_usd ?? null,
              p_started_receipt: succeeded ? result!.ledger_entry_ids[0] : null,
              p_completed_receipt: succeeded ? result!.ledger_entry_ids[1] : null,
              p_response_hash: responseHash,
            })
            .abortSignal(AbortSignal.timeout(10000));
    const confirmed = z
      .object({
        run_id: z.literal(runId),
        status: z.literal(terminalStatus),
        replayed: z.boolean(),
      })
      .safeParse(recorded);
    if (error || !confirmed.success) throw new Error('completion_not_confirmed');
  } catch {
    // An ambiguous commit is not proof of failure or rollback. Do not write
    // over a concurrently cancelled/terminal row, retry dispatch or publish
    // an unconfirmed completion event. Reconcile the recorded run instead.
    log.error({ agent, correlationId, runId }, 'agent completion persistence unconfirmed');
    return {
      status: 503,
      body: {
        error: {
          code: 'agent_completion_unconfirmed',
          message: 'Could not confirm the recorded outcome. Inspect this run before retrying.',
          runId,
          correlationId,
        },
      },
    };
  }

  const outcomeStep = succeeded
    ? 'succeeded'
    : failureCode === 'agent_reported_failure'
      ? 'runtime_reported_failure'
      : 'outcome_unconfirmed';
  deps.realtime.broadcast({
    type: 'agent.progress',
    agent,
    correlationId,
    runId,
    step: `${agent}.${outcomeStep}`,
    progress: 1,
    message: succeeded
      ? `Agent ${agent} succeeded`
      : outcomeStep === 'outcome_unconfirmed'
        ? `The runtime outcome for agent ${agent} is unconfirmed. Inspect this run before retrying.`
        : `The runtime reported failure for agent ${agent}.`,
    occurredAt: new Date().toISOString(),
  });
  if (!succeeded)
    return {
      status: 502,
      body: {
        error: {
          code: failureCode,
          message:
            failureCode === 'agent_invocation_failed'
              ? 'The runtime outcome is unconfirmed. Inspect this run before retrying.'
              : `Could not complete agent ${agent}.`,
          runtimeOutcome:
            failureCode === 'agent_invocation_failed' ? 'unconfirmed' : 'runtime_reported_failure',
          runId,
          correlationId,
        },
      },
    };
  return {
    status: 200,
    body: result!,
    run: { runId, correlationId, requestHash, responseHash: responseHash! },
  };
}
