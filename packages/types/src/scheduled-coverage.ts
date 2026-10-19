/** Explicit owner delegation for metadata-only scheduled coverage reassessment.
 * Discovery is provenance, never a source of questionnaire/legal declarations. */
import { z } from 'zod';
import { canonicalLocalCustody } from './local-custody-policy';
const uuid = z.uuid().transform((v) => v.toLowerCase());
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.iso.datetime({ offset: true });
const receipt = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((v) => BigInt(v) <= 9223372036854775807n);
const reason = z
  .string()
  .trim()
  .min(20)
  .max(2000)
  .refine((v) => !/[\u0000\uD800-\uDFFF]/u.test(v));
export const coverageCataloguePin = z
  .object({
    libraryVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
    rowsSha256: hash,
    questionnaireDigest: hash,
    manifestSha256: hash,
    selectionOperationKey: uuid.nullable(),
  })
  .strict();
export const coverageAuthorityPin = z
  .object({
    scheduleId: uuid,
    readScopeId: uuid,
    estateId: uuid,
    connectorId: uuid,
    grantId: uuid,
    configurationSha256: hash,
    cadence: z.string().min(1).max(100),
    workloadId: uuid,
    custodyPolicyId: uuid,
    custodyPolicySha256: hash,
    keyPolicySha256: hash,
    custodyActivationEventId: uuid,
    custodyEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    deploymentBindingSha256: hash,
    baselineRunId: uuid,
    baselineResultSha256: hash,
    preflightFireId: uuid,
    preflightDiscoveryRequestId: uuid,
    preflightDiscoveryId: uuid,
    preflightResultSha256: hash,
    catalogue: coverageCataloguePin,
  })
  .strict();
export const coverageScopeRequest = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal('axiom.scheduled-coverage.authority.v1'),
    operationKey: uuid,
    tenantId: uuid,
    ownerId: uuid,
    previousScopeId: uuid.nullable(),
    source: coverageAuthorityPin,
    expiresAt: instant,
    maxFires: z.number().int().min(1).max(24),
    taskScopes: z.tuple([z.literal('control_library.read'), z.literal('findings.write')]),
    declarationPolicy: z.literal('all_business_facts_unknown'),
    discoveryUse: z.literal('technical_provenance_only'),
    reason,
  })
  .strict();
export const coverageScopeRevocation = z
  .object({
    schemaVersion: z.literal(1),
    operationKey: uuid,
    scopeId: uuid,
    requestSha256: hash,
    reason,
  })
  .strict();
export const coverageScopeIntent = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('authorize'), request: coverageScopeRequest }).strict(),
  z.object({ phase: z.literal('revoke'), request: coverageScopeRevocation }).strict(),
]);
export type CoverageScopeIntent = z.infer<typeof coverageScopeIntent>;
export function encodeCoverageScopeIntent(value: CoverageScopeIntent) {
  // The phase is part of both the exact request hash and the MFA domain.
  return canonicalLocalCustody(coverageScopeIntent.parse(value));
}
const operationBinding = {
  tenantId: uuid,
  actorId: uuid,
  phase: z.enum(['authorize', 'revoke']),
  operationKey: uuid,
  requestSha256: hash,
};
export const coverageScopeOperation = z.discriminatedUnion('recorded', [
  z
    .object({
      ...operationBinding,
      recorded: z.literal(false),
      fenced: z.boolean(),
      fenceReceiptId: receipt.nullable(),
      challengeExpiresAt: instant.nullable(),
    })
    .strict()
    .refine((v) => v.fenced === Boolean(v.fenceReceiptId)),
  z
    .object({
      ...operationBinding,
      recorded: z.literal(true),
      scopeId: uuid,
      receiptId: receipt,
      revoked: z.boolean(),
    })
    .strict(),
]);
export const coverageFireReference = z.object({ tenantId: uuid, fireId: uuid }).strict();
export type CoverageFireReference = z.infer<typeof coverageFireReference>;
export const coverageFireOutcome = coverageFireReference
  .extend({
    state: z.enum(['queued', 'handed_off', 'dispatched', 'finalized', 'refused', 'unconfirmed']),
    engagementId: uuid,
    jobId: uuid,
    runId: uuid.nullable(),
    receiptId: receipt.nullable(),
    resultDigest: hash.nullable(),
  })
  .strict()
  .superRefine((v, c) => {
    if (['dispatched', 'finalized'].includes(v.state) && (!v.runId || !v.receiptId))
      c.addIssue({ code: 'custom', message: 'Original dispatched receipt required' });
    if ((v.state === 'finalized') !== Boolean(v.resultDigest))
      c.addIssue({ code: 'custom', message: 'Exact finalized result required' });
  });
export type CoverageFireOutcome = z.infer<typeof coverageFireOutcome>;
/** Private producer assignment: SQL derives every principal, resource and input.
 * It never appears in browser responses or Temporal history. */
export const coverageProducerAssignment = coverageFireReference
  .extend({
    state: z.literal('runnable'),
    ownerId: uuid,
    scopeId: uuid,
    scopeReceiptId: receipt,
    source: coverageAuthorityPin,
    discoveryFireId: uuid,
    discoveryRequestId: uuid,
    discoveryId: uuid,
    discoveryResultSha256: hash,
    discoveryCompletedAt: instant,
    engagementId: uuid,
    jobId: uuid,
    expiresAt: instant,
    inputText: z.string().min(2).max(131072),
    inputSha256: hash,
  })
  .strict();
export const coverageScopeContext = z
  .object({
    tenantId: uuid,
    actorId: uuid,
    checkedAt: instant,
    candidates: z
      .array(
        z
          .object({
            source: coverageAuthorityPin,
            previousScopeId: uuid.nullable(),
            maxExpiresAt: instant,
          })
          .strict(),
      )
      .max(20),
    scopes: z
      .array(
        z
          .object({
            scopeId: uuid,
            requestSha256: hash,
            request: coverageScopeRequest,
            receiptId: receipt,
            active: z.boolean(),
            revoked: z.boolean(),
          })
          .strict(),
      )
      .max(100),
    fires: z.array(coverageFireOutcome).max(100),
  })
  .strict();
/** Safe public projection: contains no internal numerical assessment estimates. */
export const coveragePresentation = z
  .object({
    tenantId: uuid,
    runId: uuid,
    engagementId: uuid,
    fireId: uuid,
    scopeId: uuid,
    scopeReceiptId: receipt,
    discoveryId: uuid,
    discoveryResultSha256: hash,
    basis: z.literal('technical_provenance_only'),
    declarationPolicy: z.literal('all_business_facts_unknown'),
  })
  .strict();
