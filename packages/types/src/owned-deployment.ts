/** Browser contract for explicit local synthetic enrollment, never remediation
 * approval. Server configuration selects the reviewed manifest; no browser can
 * choose a role, UID, SQL statement, endpoint, key, image or filesystem path. */
import { z } from 'zod';
const uuid = z.uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const reason = z.string().trim().min(20).max(2000);
export const OWNED_DEPLOYMENT_PURPOSE = 'owned_synthetic_enrollment_v1' as const;
export const ownedDeploymentState = z.enum([
  'requested',
  'preflight_ready',
  'preflight_refused',
  'approved',
  'installing',
  'active',
  'unconfirmed',
  'revoked',
  'expired',
]);
export const OWNED_DEPLOYMENT_STEPS = [
  'enroll_synthetic_resource',
  'authorize_role_switch',
  'publish_scoped_credential',
  'register_karya_identity',
  'stage_owned_controller',
  'verify_installed_scope',
] as const;
export const ownedDeploymentStep = z.enum(OWNED_DEPLOYMENT_STEPS);
export const ownedDeploymentRequest = z
  .object({
    operationKey: uuid,
    engagementId: uuid,
    connectorId: uuid,
    manifestSha256: hash,
    reason,
    acknowledgeOwnedSynthetic: z.literal(true),
  })
  .strict();
export const ownedDeploymentPreflight = z
  .object({ operationKey: uuid, expectedManifestSha256: hash })
  .strict();
export const ownedDeploymentDecision = z
  .object({
    operationKey: uuid,
    expectedManifestSha256: hash,
    expectedPreflightSha256: hash,
    expectedRollbackSha256: hash,
    reason,
    acknowledgeOwnedSynthetic: z.literal(true),
  })
  .strict();
export const ownedDeploymentMfaEnvelope = z
  .object({
    request: ownedDeploymentDecision,
    challengeId: uuid.optional(),
    code: z.string().min(1).max(256).optional(),
  })
  .strict();
/** Human-only stop of the exact recorded enrollment. Never grants installation
 * authority, replaces its founder approval, or undoes a target setting. */
export const ownedDeploymentRevocation = z
  .object({
    operationKey: uuid,
    expectedManifestSha256: hash,
    expectedApprovalId: uuid,
    reason,
    acknowledgeOwnedSynthetic: z.literal(true),
  })
  .strict();
export const ownedDeploymentRevocationMfaEnvelope = z
  .object({
    request: ownedDeploymentRevocation,
    challengeId: uuid.optional(),
    code: z.string().min(1).max(256).optional(),
  })
  .strict();
export type OwnedDeploymentRevocation = z.infer<typeof ownedDeploymentRevocation>;
/** Explicit human retirement of a request/read-only preflight/decision intent.
 * Server serializes with all old phase writers, proves no mutating/uncertain
 * installation effect, and appends an immutable fence checked by late callers.
 * This NEVER authorizes target undo, installer retry or a new approval. */
export const ownedDeploymentFence = z
  .object({
    operationKey: uuid,
    target: z
      .object({
        phase: z.enum(['request', 'preflight', 'decision', 'revocation']),
        operationKey: uuid,
        canonicalRequestHash: hash,
      })
      .strict(),
    reason: z.enum(['expired', 'superseded_after_no_effect']),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.operationKey === value.target.operationKey)
      context.addIssue({ code: 'custom', message: 'Distinct fence operation key required' });
  });
export const ownedDeploymentInstall = z
  .object({ operationKey: uuid, expectedManifestSha256: hash, expectedApprovalId: uuid })
  .strict();
const receipt = z.string().regex(/^[1-9][0-9]{0,18}$/);
export const ownedDeploymentFenceReceipt = z
  .object({
    requestId: uuid,
    tenantId: uuid,
    actorId: uuid,
    operationKey: uuid,
    target: ownedDeploymentFence.shape.target,
    disposition: z.literal('fenced_no_mutation'),
    previousState: z.enum(['not_recorded', 'recorded_readonly_no_effect', 'expired_decision']),
    requiresPreflight: z.boolean(),
    fenceReceiptId: receipt,
  })
  .strict();
export const ownedDeploymentFenceResult = z.object({ data: ownedDeploymentFenceReceipt }).strict();
const date = z.iso.datetime({ offset: true });
export const ownedDeploymentSummary = z
  .object({
    requestId: uuid,
    tenantId: uuid,
    actorId: uuid,
    engagementId: uuid,
    connectorId: uuid,
    state: ownedDeploymentState,
    manifestSha256: hash,
    environment: z.literal('local'),
    label: z.literal('Owned synthetic audit configuration'),
    scope: z.literal('owned_synthetic_config.audit_log_enable'),
    fixtureId: uuid,
    resourceId: uuid,
    bindingId: uuid,
    custodyPolicyId: uuid,
    custodyEpoch: z.number().int().positive().safe(),
    requestedAt: date,
    expiresAt: date,
    reason,
    preflight: z
      .object({
        sha256: hash,
        completedAt: date,
        expiresAt: date,
        rollbackSha256: hash,
        dryRunCompleted: z.boolean(),
        rollbackValidated: z.boolean(),
        checks: z
          .array(
            z
              .object({
                name: z.string().max(100),
                outcome: z.enum(['passed', 'failed']),
                detail: z.string().max(300),
              })
              .strict(),
          )
          .min(1)
          .max(30),
        receiptId: receipt,
      })
      .strict()
      .nullable(),
    approval: z
      .object({
        approvalId: uuid,
        approvedBy: uuid,
        approvedAt: date,
        expiresAt: date,
        receiptId: receipt,
      })
      .strict()
      .nullable(),
    installation: z
      .object({
        operationKey: uuid,
        steps: z
          .array(
            z
              .object({
                step: ownedDeploymentStep,
                state: z.enum(['pending', 'authorized', 'confirmed', 'unconfirmed', 'revoked']),
                receiptId: receipt.nullable(),
                detail: z.string().max(300).nullable(),
              })
              .strict(),
          )
          .length(6),
        receiptId: receipt.nullable(),
      })
      .strict()
      .nullable(),
    limitations: z.array(z.string().min(1).max(300)).min(1).max(10),
  })
  .strict()
  .superRefine((value, context) => {
    const ready = ['preflight_ready', 'approved', 'installing', 'active'].includes(value.state);
    if (
      ready &&
      (!value.preflight?.dryRunCompleted ||
        !value.preflight.rollbackValidated ||
        value.preflight.checks.some((check) => check.outcome !== 'passed'))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['preflight'],
        message: 'Completed deployment dry-run and validated rollback required',
      });
    }
    if (['approved', 'installing', 'active'].includes(value.state) && !value.approval) {
      context.addIssue({
        code: 'custom',
        path: ['approval'],
        message: 'Recorded approval required',
      });
    }
    if (['installing', 'active'].includes(value.state) && !value.installation) {
      context.addIssue({
        code: 'custom',
        path: ['installation'],
        message: 'Recorded installation required',
      });
    }
    if (
      value.installation &&
      value.installation.steps.some((step, index) => step.step !== OWNED_DEPLOYMENT_STEPS[index])
    ) {
      context.addIssue({
        code: 'custom',
        path: ['installation', 'steps'],
        message: 'Exact ordered installation steps required',
      });
    }
    if (
      value.state === 'active' &&
      value.installation?.steps.some((step) => step.state !== 'confirmed')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['installation', 'steps'],
        message: 'Independent readback required for every installed step',
      });
    }
  });
export const ownedDeploymentList = z
  .object({ data: z.array(ownedDeploymentSummary).max(100) })
  .strict();
export const ownedDeploymentOptions = z
  .object({
    data: z
      .array(
        z
          .object({
            manifestSha256: hash,
            engagementId: uuid,
            connectorId: uuid,
            label: z.literal('Owned synthetic audit configuration'),
            environment: z.literal('local'),
            expiresAt: date,
            limitations: z.array(z.string().max(300)).min(1).max(10),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
export const ownedDeploymentError = z.enum([
  'owned_deployment_unavailable',
  'owned_deployment_invalid',
  'owned_deployment_forbidden',
  'owned_deployment_source_changed',
  'owned_deployment_preflight_required',
  'owned_deployment_rollback_required',
  'owned_deployment_mfa_required',
  'owned_deployment_mfa_refused',
  'owned_deployment_expired',
  'owned_deployment_revoked',
  'owned_deployment_conflict',
  'owned_deployment_unconfirmed',
  'owned_deployment_decision_fenced',
  'owned_deployment_approval_exists',
  'owned_deployment_effect_unresolved',
]);
export const ownedDeploymentResult = z.object({ data: ownedDeploymentSummary }).strict();
export const ownedDeploymentChallenge = z
  .object({
    data: z
      .object({ challengeId: uuid, expiresAt: date, maxAttempts: z.number().int().min(1).max(10) })
      .strict(),
  })
  .strict();
export const ownedDeploymentVerified = z
  .object({ data: z.object({ verified: z.literal(true) }).strict() })
  .strict();
export const ownedDeploymentFailure = z
  .object({
    error: z.object({ code: ownedDeploymentError, message: z.string().min(1).max(300) }).strict(),
  })
  .strict();
/** Readback is exact to the durable request and phase. The same decision key
 * is deliberately shared by challenge/verify/approve, with distinct phase rows.
 * Canonical hashes cover {requestId, phase, operationKey, request}; verification
 * includes challengeId, NEVER the TOTP/recovery code or a hash of that code. */
export const ownedDeploymentOperationPhase = z.enum([
  'request',
  'preflight',
  'challenge',
  'verify',
  'approve',
  'install',
  'fence',
  'revoke_challenge',
  'revoke_verify',
  'revoke',
]);
export const ownedDeploymentOperationIntent = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('request'), request: ownedDeploymentRequest }).strict(),
  z.object({ phase: z.literal('preflight'), request: ownedDeploymentPreflight }).strict(),
  z.object({ phase: z.literal('challenge'), request: ownedDeploymentDecision }).strict(),
  z
    .object({ phase: z.literal('verify'), request: ownedDeploymentDecision, challengeId: uuid })
    .strict(),
  z
    .object({ phase: z.literal('approve'), request: ownedDeploymentDecision, challengeId: uuid })
    .strict(),
  z.object({ phase: z.literal('install'), request: ownedDeploymentInstall }).strict(),
  z.object({ phase: z.literal('fence'), request: ownedDeploymentFence }).strict(),
  z.object({ phase: z.literal('revoke_challenge'), request: ownedDeploymentRevocation }).strict(),
  z
    .object({
      phase: z.literal('revoke_verify'),
      request: ownedDeploymentRevocation,
      challengeId: uuid,
    })
    .strict(),
  z
    .object({ phase: z.literal('revoke'), request: ownedDeploymentRevocation, challengeId: uuid })
    .strict(),
]);
export const ownedDeploymentOperationReadback = z
  .object({
    data: z
      .object({
        requestId: uuid,
        tenantId: uuid,
        actorId: uuid,
        operationKey: uuid,
        phase: ownedDeploymentOperationPhase,
        outcome: z.enum(['not_recorded', 'recorded', 'unconfirmed']),
        canonicalRequestHash: hash.nullable(),
        intent: ownedDeploymentOperationIntent.nullable(),
        receiptId: receipt.nullable(),
        result: ownedDeploymentSummary.nullable(),
        phaseResult: z
          .discriminatedUnion('phase', [
            z
              .object({
                phase: z.literal('challenge'),
                challenge: ownedDeploymentChallenge.shape.data,
              })
              .strict(),
            z.object({ phase: z.literal('verify'), verified: z.literal(true) }).strict(),
            z
              .object({
                phase: z.literal('revoke_challenge'),
                challenge: ownedDeploymentChallenge.shape.data,
              })
              .strict(),
            z.object({ phase: z.literal('revoke_verify'), verified: z.literal(true) }).strict(),
            z.object({ phase: z.literal('fence'), receipt: ownedDeploymentFenceReceipt }).strict(),
          ])
          .nullable(),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.outcome === 'not_recorded') {
          if (
            value.canonicalRequestHash ||
            value.intent ||
            value.receiptId ||
            value.result ||
            value.phaseResult
          )
            context.addIssue({
              code: 'custom',
              message: 'Absent operation must not claim a retained receipt',
            });
          return;
        }
        if (
          !value.canonicalRequestHash ||
          !value.intent ||
          value.intent.phase !== value.phase ||
          value.intent.request.operationKey !== value.operationKey
        )
          context.addIssue({
            code: 'custom',
            message: 'Exact retained phase and canonical intent required',
          });
        if (value.phaseResult && value.phaseResult.phase !== value.phase)
          context.addIssue({ code: 'custom', message: 'Foreign phase result refused' });
        if (
          value.outcome === 'recorded' &&
          ['challenge', 'verify', 'fence', 'revoke_challenge', 'revoke_verify'].includes(
            value.phase,
          ) &&
          !value.phaseResult
        )
          context.addIssue({ code: 'custom', message: 'Retained MFA phase result required' });
        if (value.phaseResult?.phase === 'fence') {
          const fence = value.phaseResult.receipt;
          if (
            fence.requestId !== value.requestId ||
            fence.tenantId !== value.tenantId ||
            fence.actorId !== value.actorId ||
            fence.operationKey !== value.operationKey ||
            fence.fenceReceiptId !== value.receiptId ||
            value.intent?.phase !== 'fence' ||
            ownedOperationCanonical(fence.target) !==
              ownedOperationCanonical(value.intent.request.target)
          )
            context.addIssue({ code: 'custom', message: 'Foreign fence receipt refused' });
        }
        if (value.outcome === 'recorded' && !value.receiptId)
          context.addIssue({ code: 'custom', message: 'Confirmed operation receipt required' });
        if (
          value.result &&
          (value.result.requestId !== value.requestId || value.result.tenantId !== value.tenantId)
        )
          context.addIssue({ code: 'custom', message: 'Foreign operation result refused' });
      }),
  })
  .strict();
export const ownedDeploymentOperationIdentity = z
  .object({
    tenantId: uuid,
    actorId: uuid,
    requestId: uuid,
    operationKey: uuid,
    intent: ownedDeploymentOperationIntent,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.intent.request.operationKey !== value.operationKey)
      context.addIssue({ code: 'custom', message: 'Operation key mismatch' });
  });
function ownedOperationCanonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(ownedOperationCanonical).join(',') + ']';
  if (typeof value === 'object' && value !== null)
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ':' +
            ownedOperationCanonical((value as Record<string, unknown>)[key]),
        )
        .join(',') +
      '}'
    );
  throw Error('Owned deployment canonical intent refused');
}
/** SHA-256 over UTF-8 of this exact string. Browser uses crypto.subtle.digest;
 * server/SQL must use the same codec. No MFA code or code hash is included. */
export function ownedDeploymentOperationCanonicalJSON(raw: unknown): string {
  const value = ownedDeploymentOperationIdentity.parse(raw);
  return ownedOperationCanonical({
    domain: 'axiom.owned-synthetic.deployment-operation.v1',
    ...value,
  });
}
export type OwnedDeploymentOperationReadback = z.infer<typeof ownedDeploymentOperationReadback>;
export type OwnedDeploymentSummary = z.infer<typeof ownedDeploymentSummary>;
export type OwnedDeploymentDecision = z.infer<typeof ownedDeploymentDecision>;
export type OwnedDeploymentRequest = z.infer<typeof ownedDeploymentRequest>;
export type OwnedDeploymentState = z.infer<typeof ownedDeploymentState>;
export type OwnedDeploymentStep = z.infer<typeof ownedDeploymentStep>;
export type OwnedDeploymentFence = z.infer<typeof ownedDeploymentFence>;
export type OwnedDeploymentFenceReceipt = z.infer<typeof ownedDeploymentFenceReceipt>;
export type OwnedDeploymentOptions = z.infer<typeof ownedDeploymentOptions>;
/** Routes mounted under normal /v1 Auth/current-session/MFA/tenant middleware:
 * GET /owned-deployments, /owned-deployments/:id,
 *     /owned-deployments/options/:engagementId
 * GET /owned-deployments/:id/operations/:phase/:operationKey
 * requestId is the initial request operationKey. Exact readback authorizes
 * current tenant/session before returning not_recorded or retained phase state.
 * Lost approve replies recover the original receipt before MFA consume checks.
 * POST /owned-deployments                      request
 * POST /owned-deployments/:id/preflight         preflight
 * POST /owned-deployments/:id/{challenge,verify,approve} MFA envelope
 * POST /owned-deployments/:id/fence-intent fence (new key; never install scope)
 * POST /owned-deployments/:id/install           install
 * Mutations require X-Expected-Actor-Id and Idempotency-Key=operationKey.
 * challenge returns {data:{challengeId,expiresAt,maxAttempts}};
 * verify returns {data:{verified:true}}; fence returns {data:fenceReceipt};
 * other mutations return {data:summary}.
 * Errors are {error:{code:ownedDeploymentError,message:string}}.
 * A request never returns a signing key, JWT, SVID or installation bearer.
 */
