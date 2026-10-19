/** Narrow local synthetic standing-approval delegation; never an execution token. */
import { z } from 'zod';
import { canonicalLocalCustody } from './local-custody-policy.js';
const uuid = z.uuid().transform((v) => v.toLowerCase());
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.iso.datetime({ offset: true });
const receipt = z
  .string()
  .refine((v) => /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n);
const reason = z
  .string()
  .trim()
  .min(20)
  .max(2000)
  .refine((v) => !/[\u0000\uD800-\uDFFF]/u.test(v));
export const STANDING_DELEGATION_PURPOSE = 'axiom.standing-policy-delegation.v1' as const;
export const standingMeasuredSource = z
  .object({
    policyId: uuid,
    policyVersion: z.number().int().positive(),
    policySha256: hash,
    policyExpiresAt: instant,
    planId: uuid,
    planVersion: z.number().int().positive(),
    actionId: uuid,
    contentDigest: hash,
    bindingId: uuid,
    connectorId: uuid,
    engagementId: uuid,
    fixtureId: uuid,
    resourceId: uuid,
    deploymentRequestId: uuid,
    deploymentApprovalId: uuid,
    deploymentExpiresAt: instant,
    environment: z.enum(['local', 'test']),
    engineSha256: hash,
    capabilitySha256: hash,
    snapshotSha256: hash,
    rollbackSha256: hash,
    roundtripSha256: hash,
    dryRunId: uuid,
    dryRunExpiresAt: instant,
    custodyPolicyId: uuid,
    custodyEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    custodyActivationEventId: uuid,
    nominatedOperatorId: uuid,
    planInitiatorId: uuid,
    actionType: z.literal('config.audit_log_enable'),
    desiredEnabled: z.literal(true),
  })
  .strict();
export type StandingMeasuredSource = z.infer<typeof standingMeasuredSource>;
export const standingRevisionRequest = z
  .object({
    schemaVersion: z.literal(1),
    operationKey: uuid,
    tenantId: uuid,
    ownerId: uuid,
    reviewerId: uuid,
    previousRevisionId: uuid.nullable(),
    source: standingMeasuredSource,
    expiresAt: instant,
    maxAuthorizations: z.literal(1),
    mode: z.literal('individual'),
    concurrency: z.literal(1),
    stopOnFailure: z.literal(true),
    reason,
  })
  .strict()
  .superRefine((v, c) => {
    if (v.ownerId === v.reviewerId || v.reviewerId === v.source.planInitiatorId)
      c.addIssue({ code: 'custom', message: 'Distinct current reviewer required' });
  });
export const standingRevisionDecision = z
  .object({
    schemaVersion: z.literal(1),
    operationKey: uuid,
    revisionId: uuid,
    requestSha256: hash,
    reason,
  })
  .strict();
export const standingRevisionIntent = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('request'), request: standingRevisionRequest }).strict(),
  z.object({ phase: z.literal('approve'), request: standingRevisionDecision }).strict(),
  z.object({ phase: z.literal('revoke'), request: standingRevisionDecision }).strict(),
]);
export type StandingRevisionIntent = z.infer<typeof standingRevisionIntent>;
const humanDecision = z.object({ actorId: uuid, challengeId: uuid, receiptId: receipt }).strict();
export const standingPolicyDelegation = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal(STANDING_DELEGATION_PURPOSE),
    tenantId: uuid,
    revisionId: uuid,
    requestSha256: hash,
    request: standingRevisionRequest,
    ownerDecision: humanDecision,
    reviewerDecision: humanDecision,
  })
  .strict()
  .superRefine((v, c) => {
    if (
      v.tenantId !== v.request.tenantId ||
      v.revisionId !== v.request.operationKey ||
      v.ownerDecision.actorId !== v.request.ownerId ||
      v.reviewerDecision.actorId !== v.request.reviewerId ||
      v.ownerDecision.receiptId === v.reviewerDecision.receiptId ||
      v.ownerDecision.challengeId === v.reviewerDecision.challengeId
    )
      c.addIssue({ code: 'custom', message: 'Exact distinct human delegation proof required' });
  });
export type StandingPolicyDelegation = z.infer<typeof standingPolicyDelegation>;
export function encodeStandingRevisionIntent(v: StandingRevisionIntent) {
  return canonicalLocalCustody(standingRevisionIntent.parse(v));
}
export function encodeStandingPolicyDelegation(v: StandingPolicyDelegation) {
  return canonicalLocalCustody(standingPolicyDelegation.parse(v));
}
export const standingRevisionOperation = z.discriminatedUnion('recorded', [
  z
    .object({
      recorded: z.literal(false),
      requestSha256: hash,
      fenced: z.boolean(),
      fenceReceiptId: receipt.nullable(),
      challengeExpiresAt: instant.nullable(),
    })
    .strict()
    .refine((v) => v.fenced === Boolean(v.fenceReceiptId)),
  z
    .object({
      recorded: z.literal(true),
      requestSha256: hash,
      revisionId: uuid,
      state: z.enum(['requested', 'reviewed', 'sealed', 'revoked', 'expired', 'unconfirmed']),
      receiptId: receipt,
    })
    .strict(),
]);
export const standingPolicyContext = z
  .object({
    tenantId: uuid,
    actorId: uuid,
    checkedAt: instant,
    candidates: z
      .array(
        z
          .object({
            policyName: z.string().min(1).max(500),
            ownerId: uuid,
            reviewerId: uuid,
            previousRevisionId: uuid.nullable(),
            source: standingMeasuredSource,
          })
          .strict(),
      )
      .max(20),
    revisions: z
      .array(
        z
          .object({
            revisionId: uuid,
            requestSha256: hash,
            request: standingRevisionRequest,
            state: z.enum([
              'requested',
              'reviewed',
              'sealed',
              'issued',
              'revoked',
              'expired',
              'unconfirmed',
            ]),
            ownerReceiptId: receipt,
            reviewerReceiptId: receipt.nullable(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type StandingPolicyContext = z.infer<typeof standingPolicyContext>;
