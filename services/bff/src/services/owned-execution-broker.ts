/** One synthetic boolean, exact Karya identity, signed singleton consumed batch.
 * This controller holds target RPC authority; neither worker nor planner does. */
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { ApprovalEngine, SignedApprovalToken } from '@axiom/approval-engine';
import type { JwtSvidVerifier } from '../workloads/jwt-svid.js';
import type { OwnedRpcClient } from './owned-synthetic-controller.js';
import { ownedHash, ownedRoundtripSchema } from './owned-execution-plan.js';
const uuid = z.uuid();
const snapshot = ownedRoundtripSchema.shape.before;
const signed = z
  .object({
    spec: z
      .object({
        planId: uuid,
        actionIds: z.array(uuid).length(1),
        approverId: uuid,
        mode: z.enum(['batch', 'individual']),
        concurrency: z.literal(1),
        stopOnFailure: z.boolean(),
        expiresAt: z.iso.datetime({ offset: true }),
        nonce: z.string().min(1).max(200),
        contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
        conditions: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
    signature: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const ownedExecutionRequest = z
  .object({
    tenantId: uuid,
    planId: uuid,
    actionId: uuid,
    requestKey: z.string().min(1).max(200),
    token: signed,
    operation: z.enum(['inspect', 'forward', 'simulate_rollback', 'rollback', 'verify']),
  })
  .strict();
export type OwnedExecutionRequest = z.infer<typeof ownedExecutionRequest>;
const binding = z
  .object({
    tenantId: uuid,
    planId: uuid,
    actionId: uuid,
    batchId: uuid,
    bindingId: uuid,
    engagementId: uuid,
    before: snapshot,
    forward: snapshot.nullable(),
    rollback: snapshot.nullable(),
  })
  .strict();
const KARYA = 'spiffe://local.axiomproof.test/agent/karya';
export function ownedOperationId(batchId: string, actionId: string, kind: 'forward' | 'rollback') {
  // Deterministic version 8 UUID over the same canonical SHA-256 as SQL.
  const bytes = Buffer.from(
    ownedHash({ domain: 'axiom.owned-synthetic.boolean.v1', batchId, actionId, kind }),
    'hex',
  ).subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 0x80;
  bytes[8] = (bytes[8]! & 63) | 0x80;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export class OwnedExecutionBroker {
  constructor(
    private readonly deps: {
      identity: Pick<JwtSvidVerifier, 'verify'>;
      approval: Pick<ApprovalEngine, 'sign'>;
      target: () => OwnedRpcClient;
    },
  ) {}
  async run(raw: unknown, proof: string, signal: AbortSignal): Promise<unknown> {
    const input = ownedExecutionRequest.parse(raw);
    const identity = await this.deps.identity.verify(proof);
    if (identity.spiffeId !== KARYA || signal.aborted) throw Error('Owned execution refused');
    // This is an already-consumed batch. Verify cryptography without the issuance
    // engine's in-memory "used nonce" shortcut; SQL checks the exact consumed row
    // and the target's durable operation journal enforces one actual transition.
    const expected = await this.deps.approval.sign(input.tenantId, input.token.spec);
    if (
      (input.token.spec.conditions?.purpose !== undefined &&
        input.token.spec.conditions.purpose !== 'remediation_execution_v1') ||
      !/^[a-f0-9]{64}$/.test(expected) ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(input.token.signature)) ||
      Date.parse(input.token.spec.expiresAt) <= Date.now() ||
      input.token.spec.planId !== input.planId ||
      input.token.spec.actionIds[0] !== input.actionId
    )
      throw Error('Owned execution refused');
    const rpc = async (name: string, args: Record<string, unknown>) => {
      if (signal.aborted || identity.expiresAt <= Date.now())
        throw Error('Owned execution refused');
      const result = await this.deps.target().rpc(name, args).abortSignal(signal);
      if (result.error || signal.aborted) throw Error('Owned execution refused');
      return result.data;
    };
    const current = binding.parse(
      await rpc('resolve_owned_execution_target', {
        p_tenant_id: input.tenantId,
        p_plan_id: input.planId,
        p_action_id: input.actionId,
        p_request_key: input.requestKey,
        p_signed_token: input.token as SignedApprovalToken,
        p_spiffe_id: identity.spiffeId,
      }),
    );
    if (
      current.tenantId !== input.tenantId ||
      current.planId !== input.planId ||
      current.actionId !== input.actionId ||
      current.before.audit_log_enabled
    )
      throw Error('Owned execution refused');
    const args = {
      p_tenant_id: input.tenantId,
      p_binding_id: current.bindingId,
      p_engagement_id: current.engagementId,
    };
    const read = async () => snapshot.parse(await rpc('read_owned_synthetic_target', args));
    if (input.operation === 'inspect') return { registered: true, actionId: input.actionId };
    const projected = {
      ...current.before,
      version: current.before.version + 1,
      audit_log_enabled: true,
    };
    const restored = { ...projected, version: projected.version + 1, audit_log_enabled: false };
    if (current.forward && ownedHash(current.forward) !== ownedHash(projected))
      throw Error('Owned execution refused');
    if (
      current.rollback &&
      (!current.forward || ownedHash(current.rollback) !== ownedHash(restored))
    )
      throw Error('Owned execution refused');
    if (input.operation === 'verify') {
      const actual = await read();
      const desired = current.rollback ?? current.forward;
      return {
        checks: [
          {
            check_id: 'owned.synthetic.audit_log_boolean',
            outcome: desired && ownedHash(actual) === ownedHash(desired) ? 'passed' : 'failed',
            detail:
              'Dedicated synthetic PostgreSQL boolean; no customer estate or compliance assertion.',
          },
        ],
      };
    }
    const rollback = input.operation !== 'forward';
    if (rollback && !current.forward) throw Error('Owned rollback refused');
    const before = rollback ? current.forward! : current.before,
      after = rollback ? restored : projected;
    if (input.operation === 'simulate_rollback') {
      if (ownedHash(await read()) !== ownedHash(current.rollback ?? before))
        throw Error('Owned rollback refused');
    } else {
      const freshIdentity = await this.deps.identity.verify(proof);
      if (freshIdentity.spiffeId !== KARYA || freshIdentity.expiresAt <= Date.now())
        throw Error('Owned execution refused');
      const result = snapshot.parse(
        await rpc('execute_owned_synthetic_action', {
          p_tenant_id: input.tenantId,
          p_plan_id: input.planId,
          p_action_id: input.actionId,
          p_request_key: input.requestKey,
          p_signed_token: input.token,
          p_spiffe_id: freshIdentity.spiffeId,
          p_operation: rollback ? 'rollback' : 'forward',
        }),
      );
      if (ownedHash(result) !== ownedHash(after) || ownedHash(await read()) !== ownedHash(after))
        throw Error('Owned execution unconfirmed');
    }
    return {
      rows_affected: 1,
      pre_state_ref: `owned-synthetic/snapshot/${ownedHash(before)}`,
      post_state_ref: `owned-synthetic/snapshot/${ownedHash(after)}`,
    };
  }
}
