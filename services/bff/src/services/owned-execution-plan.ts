/** Unwired owned-synthetic plan producer. No default writer, transport or approval issuance. */
import { createHash } from 'node:crypto';
import { z } from 'zod';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const receipt = z.string().regex(/^[1-9][0-9]{0,18}$/);
export const ownedPlanRequestSchema = z
  .object({
    operationKey: uuid,
    bindingId: uuid,
    engagementId: uuid,
    expectedSnapshotHash: hash,
    reason: z.string().trim().min(20).max(2000),
    acknowledgeOwnedSynthetic: z.literal(true),
    actionType: z.literal('config.audit_log_enable'),
    desiredEnabled: z.literal(true),
  })
  .strict();
export type OwnedPlanRequest = z.infer<typeof ownedPlanRequestSchema>;
const snapshot = z
  .object({
    fixture_id: uuid,
    resource_id: uuid,
    version: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 2),
    audit_log_enabled: z.boolean(),
  })
  .strict();
const roundtrip = z
  .object({
    engine: z
      .object({
        engine: z.literal('owned_boolean_cas_v1'),
        implementation_sha256: hash,
        capability_sha256: hash,
        capabilities: z.tuple([
          z.literal('atomic_exact_operation_journal'),
          z.literal('version_and_snapshot_cas'),
          z.literal('no_write_roundtrip'),
        ]),
      })
      .strict(),
    before: snapshot,
    projected_after: snapshot,
    restored: snapshot,
    persistent_mutations: z.literal(0),
    resources_measured: z.literal(1),
  })
  .strict();
export type OwnedRoundtrip = z.infer<typeof roundtrip>;
const binding = z
  .object({
    id: uuid,
    tenantId: uuid,
    engagementId: uuid,
    fixtureId: uuid,
    resourceId: uuid,
    registeredEngineHash: hash,
    registeredCapabilitiesHash: hash,
    scope: z.literal('owned_synthetic_config.audit_log_enable'),
    state: z.literal('active'),
  })
  .strict();
export type OwnedBinding = z.infer<typeof binding>;
const planReceipt = z
  .object({
    tenantId: uuid,
    actorId: uuid,
    operationKey: uuid,
    requestHash: hash,
    bindingId: uuid,
    engagementId: uuid,
    planId: uuid,
    actionId: uuid,
    purpose: z.literal('remediation'),
    generatedBy: z.literal('human'),
    status: z.literal('review'),
    actionCount: z.literal(1),
    closesFindingCount: z.literal(0),
    approvalTokenId: z.null(),
    executionAllowed: z.literal(false),
    humanReceipt: receipt,
    snapshotHash: hash,
    validationHash: hash,
  })
  .strict();
export type OwnedPlanReceipt = z.infer<typeof planReceipt>;
const source = z
  .object({
    tenantId: uuid,
    actorId: uuid,
    operationKey: uuid,
    requestHash: hash,
    binding,
    state: z.enum(['pending', 'recorded']),
    recorded: planReceipt.nullable(),
    recordedValidation: roundtrip.nullable(),
  })
  .strict();
export interface OwnedPlanContext {
  tenantId: string;
  actorId: string;
  expectedActorId: string;
  sessionId: string;
  idempotencyKey: string;
}
export interface OwnedPlanSourcePorts {
  /** Normal server authority/MFA session verifier; rechecked even on exact recovery. */
  authorizeCurrent(context: OwnedPlanContext): Promise<void>;
  /** Future narrow human writer RPC; SQL must repeat current source/authority checks atomically. */
  rpc(
    name: 'prepare_owned_human_plan' | 'record_owned_measured_plan',
    args: Record<string, unknown>,
  ): Promise<unknown>;
  /** Bound server-configured target; no caller URLs/credentials or declared-only simulator. */
  validateRoundtrip(binding: OwnedBinding): Promise<unknown>;
}
export interface OwnedPlanPorts extends OwnedPlanSourcePorts {
  /** Real target read fence must hold the measured snapshot through the atomic writer commit. */
  withCurrentSnapshot(
    binding: OwnedBinding,
    proof: OwnedRoundtrip,
    commit: (fence: {
      fenceId: string;
      bindingId: string;
      snapshotHash: string;
    }) => Promise<unknown>,
  ): Promise<unknown>;
}
/** The actual SQL writer owns the resource and plan in one transaction domain. */
export interface OwnedPostgresPlanPorts extends OwnedPlanSourcePorts {
  persistInResourceTransaction(
    binding: OwnedBinding,
    proof: OwnedRoundtrip,
    args: Record<string, unknown>,
  ): Promise<unknown>;
}
export class OwnedPlanRefused extends Error {
  constructor(
    readonly code:
      | 'owned_plan_invalid'
      | 'owned_plan_source_refused'
      | 'owned_plan_validation_refused'
      | 'owned_plan_outcome_unconfirmed',
  ) {
    super(code);
  }
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new OwnedPlanRefused('owned_plan_invalid');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(',')}}`;
}
export function ownedHash(value: unknown): string {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}
function validateReceipt(
  value: unknown,
  context: OwnedPlanContext,
  request: OwnedPlanRequest,
  requestHash: string,
  validationHash?: string,
): OwnedPlanReceipt {
  const parsed = planReceipt.safeParse(value);
  if (!parsed.success) throw new OwnedPlanRefused('owned_plan_outcome_unconfirmed');
  const result = parsed.data;
  if (
    result.tenantId !== context.tenantId ||
    result.actorId !== context.actorId ||
    result.operationKey !== request.operationKey ||
    result.requestHash !== requestHash ||
    result.bindingId !== request.bindingId ||
    result.engagementId !== request.engagementId ||
    result.snapshotHash !== request.expectedSnapshotHash ||
    result.planId === result.actionId ||
    (validationHash !== undefined && result.validationHash !== validationHash)
  )
    throw new OwnedPlanRefused('owned_plan_outcome_unconfirmed');
  return result;
}
async function writerCall(
  ports: OwnedPlanSourcePorts,
  name: Parameters<OwnedPlanPorts['rpc']>[0],
  args: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await ports.rpc(name, args);
  } catch {
    throw new OwnedPlanRefused(
      name === 'prepare_owned_human_plan'
        ? 'owned_plan_source_refused'
        : 'owned_plan_outcome_unconfirmed',
    );
  }
}
async function measuredCall(ports: OwnedPlanSourcePorts, value: OwnedBinding): Promise<unknown> {
  try {
    return await ports.validateRoundtrip(value);
  } catch {
    throw new OwnedPlanRefused('owned_plan_validation_refused');
  }
}
/** Creates a NEW human plan; review-only plan conversion and caller-created approvals are absent. */
async function produceWithOwnedSource(
  context: OwnedPlanContext,
  input: unknown,
  ports: OwnedPlanSourcePorts,
  persist: (
    binding: OwnedBinding,
    proof: OwnedRoundtrip,
    args: Record<string, unknown>,
  ) => Promise<unknown>,
): Promise<OwnedPlanReceipt> {
  const parsed = ownedPlanRequestSchema.safeParse(input);
  if (
    !parsed.success ||
    !uuid.safeParse(context.tenantId).success ||
    !uuid.safeParse(context.actorId).success ||
    context.actorId !== context.expectedActorId ||
    !context.sessionId ||
    context.idempotencyKey !== parsed.data.operationKey
  )
    throw new OwnedPlanRefused('owned_plan_invalid');
  const request = parsed.data;
  const requestHash = ownedHash({ tenantId: context.tenantId, actorId: context.actorId, request });
  await ports.authorizeCurrent(context);
  const prepared = source.safeParse(
    await writerCall(ports, 'prepare_owned_human_plan', {
      p_tenant_id: context.tenantId,
      p_actor_id: context.actorId,
      p_session_id: context.sessionId,
      p_operation_key: request.operationKey,
      p_request: request,
      p_request_hash: requestHash,
    }),
  );
  if (!prepared.success) throw new OwnedPlanRefused('owned_plan_source_refused');
  const current = prepared.data;
  if (
    current.tenantId !== context.tenantId ||
    current.actorId !== context.actorId ||
    current.operationKey !== request.operationKey ||
    current.requestHash !== requestHash ||
    current.binding.id !== request.bindingId ||
    current.binding.tenantId !== context.tenantId ||
    current.binding.engagementId !== request.engagementId
  )
    throw new OwnedPlanRefused('owned_plan_source_refused');
  if (
    current.state === 'pending' &&
    (current.recorded !== null || current.recordedValidation !== null)
  )
    throw new OwnedPlanRefused('owned_plan_source_refused');
  const measured = roundtrip.safeParse(
    current.state === 'recorded'
      ? current.recordedValidation
      : await measuredCall(ports, current.binding),
  );
  if (!measured.success) throw new OwnedPlanRefused('owned_plan_validation_refused');
  const proof = measured.data;
  const original = proof.before;
  const projected = { ...original, version: original.version + 1, audit_log_enabled: true };
  const restored = { ...original, version: original.version + 2 };
  if (
    original.fixture_id !== current.binding.fixtureId ||
    original.resource_id !== current.binding.resourceId ||
    original.audit_log_enabled ||
    ownedHash(original) !== request.expectedSnapshotHash ||
    proof.engine.implementation_sha256 !== current.binding.registeredEngineHash ||
    proof.engine.capability_sha256 !== current.binding.registeredCapabilitiesHash ||
    proof.engine.capability_sha256 !== ownedHash(proof.engine.capabilities) ||
    ownedHash(proof.projected_after) !== ownedHash(projected) ||
    ownedHash(proof.restored) !== ownedHash(restored)
  )
    throw new OwnedPlanRefused('owned_plan_validation_refused');
  const validationHash = ownedHash(proof);
  if (current.state === 'recorded')
    return validateReceipt(current.recorded, context, request, requestHash, validationHash);
  const recorded = await persist(current.binding, proof, {
    p_tenant_id: context.tenantId,
    p_actor_id: context.actorId,
    p_session_id: context.sessionId,
    p_operation_key: request.operationKey,
    p_request_hash: requestHash,
    p_binding_id: request.bindingId,
    p_engagement_id: request.engagementId,
    p_roundtrip: proof,
    p_validation_hash: validationHash,
  });
  return validateReceipt(recorded, context, request, requestHash, validationHash);
}

/** Separate target: an actual external read fence spans the atomic writer commit. */
export async function produceOwnedMeasuredPlan(
  context: OwnedPlanContext,
  input: unknown,
  ports: OwnedPlanPorts,
): Promise<OwnedPlanReceipt> {
  return produceWithOwnedSource(context, input, ports, (binding, proof, args) =>
    ports.withCurrentSnapshot(binding, proof, async (fence) => {
      if (
        !uuid.safeParse(fence.fenceId).success ||
        fence.bindingId !== binding.id ||
        fence.snapshotHash !== ownedHash(proof.before)
      )
        throw new OwnedPlanRefused('owned_plan_source_refused');
      await ports.authorizeCurrent(context);
      return writerCall(ports, 'record_owned_measured_plan', {
        ...args,
        p_snapshot_fence_id: fence.fenceId,
      });
    }),
  );
}

/** Same PostgreSQL target: a narrow writer rechecks and locks the source through its own commit.
 * This port has no default implementation and cannot be selected by the request body.
 * Native row locks are mandatory; no fabricated external lease is accepted or issued.
 */
export async function produceOwnedPostgresMeasuredPlan(
  context: OwnedPlanContext,
  input: unknown,
  ports: OwnedPostgresPlanPorts,
): Promise<OwnedPlanReceipt> {
  return produceWithOwnedSource(context, input, ports, async (binding, proof, args) => {
    await ports.authorizeCurrent(context);
    try {
      return await ports.persistInResourceTransaction(binding, proof, args);
    } catch {
      throw new OwnedPlanRefused('owned_plan_outcome_unconfirmed');
    }
  });
}
