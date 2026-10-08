/** Unwired human cancellation of an original unrecorded owned request. No plan cancellation. */
import { z } from 'zod';
import {
  ownedHash,
  ownedPlanRequestSchema,
  type OwnedPlanContext,
} from './owned-execution-plan.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
export const ownedCancellationRequestSchema = z
  .object({
    request: ownedPlanRequestSchema,
    cancellationKey: uuid,
    reason: z.string().trim().min(20).max(2000),
  })
  .strict();
const cancelledReceipt = z
  .object({
    tenantId: uuid,
    actorId: uuid,
    operationKey: uuid,
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    cancellationKey: uuid,
    reason: z.string().min(20).max(2000),
    state: z.literal('cancelled'),
    humanReceipt: z.string().regex(/^[1-9][0-9]{0,18}$/),
    planId: z.null(),
    executionAllowed: z.literal(false),
  })
  .strict();
export type OwnedCancellationReceipt = z.infer<typeof cancelledReceipt>;
export interface OwnedCancellationPorts {
  /** Current normal identity, accepted dual-capability membership and MFA; stopping needs no active target. */
  authorizeCurrentHuman(context: OwnedPlanContext): Promise<void>;
  /** Narrow SQL writer repeats current human authority and locks original request against plan persistence. */
  cancelOriginalPendingRequest(args: Record<string, unknown>): Promise<unknown>;
}
export class OwnedCancellationRefused extends Error {
  constructor(
    readonly code:
      | 'owned_cancellation_invalid'
      | 'owned_cancellation_source_refused'
      | 'owned_cancellation_outcome_unconfirmed',
  ) {
    super(code);
  }
}
export async function cancelOwnedPendingRequest(
  context: OwnedPlanContext,
  input: unknown,
  ports: OwnedCancellationPorts,
): Promise<OwnedCancellationReceipt> {
  const parsed = ownedCancellationRequestSchema.safeParse(input);
  if (
    !parsed.success ||
    !uuid.safeParse(context.tenantId).success ||
    !uuid.safeParse(context.actorId).success ||
    context.actorId !== context.expectedActorId ||
    context.idempotencyKey !== parsed.data.cancellationKey ||
    !context.sessionId ||
    context.sessionId.length > 256
  )
    throw new OwnedCancellationRefused('owned_cancellation_invalid');
  await ports.authorizeCurrentHuman(context);
  const { request, cancellationKey, reason } = parsed.data;
  const requestHash = ownedHash({
    tenantId: context.tenantId,
    actorId: context.actorId,
    request,
  });
  let raw: unknown;
  try {
    raw = await ports.cancelOriginalPendingRequest({
      p_tenant_id: context.tenantId,
      p_actor_id: context.actorId,
      p_session_id: context.sessionId,
      p_operation_key: request.operationKey,
      p_request_hash: requestHash,
      p_cancellation_key: cancellationKey,
      p_reason: reason,
    });
  } catch {
    // An uncertain reply never authorizes dropping the original request journal.
    throw new OwnedCancellationRefused('owned_cancellation_outcome_unconfirmed');
  }
  const result = cancelledReceipt.safeParse(raw);
  if (
    !result.success ||
    result.data.tenantId !== context.tenantId ||
    result.data.actorId !== context.actorId ||
    result.data.operationKey !== request.operationKey ||
    result.data.requestHash !== requestHash ||
    result.data.cancellationKey !== cancellationKey ||
    result.data.reason !== reason
  )
    throw new OwnedCancellationRefused('owned_cancellation_source_refused');
  return result.data;
}
