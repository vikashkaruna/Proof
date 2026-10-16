import { z } from 'zod';
const id = z
  .uuid()
  .refine((v) =>
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v),
  );
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const safe = z
  .string()
  .min(1)
  .max(2000)
  .refine((v) => /\S/u.test(v) && !/[\u0000\uD800-\uDFFF]/u.test(v));
const trustDomain = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
  .refine((v) => !v.includes('..') && v.trim() === v);
const servicePrincipal = (path: string) =>
  z
    .string()
    .max(2048)
    .refine((value) => {
      const prefix = 'spiffe://',
        suffix = `/${path}`;
      return (
        value.startsWith(prefix) &&
        value.endsWith(suffix) &&
        trustDomain.safeParse(value.slice(prefix.length, -suffix.length)).success
      );
    });
export const LOCAL_CUSTODY_POLICY_CODEC = 'axiom-local-custody-policy-canonical-json-1' as const;
export const LOCAL_CUSTODY_EVENT_CODEC = 'axiom-local-custody-event-canonical-json-1' as const;
export const LOCAL_CUSTODY_MAX_BYTES = 16384;
export const localCustodyPolicySchema = z
  .object({
    version: z.literal(1),
    policyId: id,
    tenantId: id,
    mode: z.enum(['local_demo', 'operator_managed']),
    nominatedOperatorId: id,
    targetWorkloadId: id,
    // Syntax only; the trusted issuer must separately pin the configured trust domain/principal.
    servicePrincipals: z
      .object({
        producer: servicePrincipal('service/assessment-dispatch-producer'),
        controller: servicePrincipal('controller/assessment'),
      })
      .strict(),
    validity: z
      .object({ kind: z.literal('until_revoked'), reviewDueAt: z.number().int().safe().positive() })
      .strict(),
    actionClass: z.literal('assessment_dispatch_key_custody'),
    keyPolicy: z
      .object({
        primary: z.string().max(500),
        readable: z.array(z.string().max(500)).min(1).max(10),
      })
      .strict(),
    keyPolicySha256: sha,
    deploymentBindingSha256: sha,
    reason: safe,
    acceptedLimitations: z
      .array(
        z.enum([
          'regional_custody_unavailable',
          'hardware_backing_unverified',
          'disaster_recovery_unverified',
          'physical_custody_operator_managed',
        ]),
      )
      .min(1)
      .max(4),
    statutoryComplianceAsserted: z.literal(false),
    ownershipVerified: z.literal(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    const pattern = new RegExp(
      '^axiom-local-dispatch://' + v.tenantId + '/[a-f0-9-]{36}/versions/[1-9][0-9]{0,8}$',
    );
    if (
      !v.keyPolicy.readable.includes(v.keyPolicy.primary) ||
      new Set(v.keyPolicy.readable).size !== v.keyPolicy.readable.length ||
      v.keyPolicy.readable.some(
        (r) => !pattern.test(r) || !id.safeParse(r.split('/')[3]).success,
      ) ||
      new Set(v.acceptedLimitations).size !== v.acceptedLimitations.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Exact tenant-bound distinct local key references and limitations required',
      });
  });
export type LocalCustodyPolicy = z.infer<typeof localCustodyPolicySchema>;
export const localCustodyEventRequestSchema = z
  .object({
    version: z.literal(1),
    operationKey: id,
    transition: z.enum(['request', 'approve', 'activate', 'revoke', 'review']),
    policyText: z.string().max(LOCAL_CUSTODY_MAX_BYTES),
    policySha256: sha,
    previousEventId: id.nullable(),
    nextReviewDueAt: z.number().int().safe().positive().nullable(),
    reason: safe,
    confirmed: z.literal(true),
  })
  .strict()
  .superRefine((v, ctx) => {
    try {
      parseLocalCustodyPolicyText(v.policyText);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Exact retained policy bytes required' });
    }
    if ((v.transition === 'review') !== (v.nextReviewDueAt !== null))
      ctx.addIssue({ code: 'custom', message: 'Only periodic review binds its next reminder' });
    if ((v.transition === 'request') !== (v.previousEventId === null))
      ctx.addIssue({ code: 'custom', message: 'Predecessor required after request' });
  });
export type LocalCustodyEventRequest = z.infer<typeof localCustodyEventRequestSchema>;
export function canonicalLocalCustody(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalLocalCustody).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonicalLocalCustody(v))
        .join(',') +
      '}'
    );
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('Local custody bytes refused');
  return text;
}
export function encodeLocalCustodyPolicy(value: unknown): string {
  const text = canonicalLocalCustody(localCustodyPolicySchema.parse(value));
  if (new TextEncoder().encode(text).byteLength > LOCAL_CUSTODY_MAX_BYTES)
    throw new Error('Local custody bytes refused');
  return text;
}
export function parseLocalCustodyPolicyText(text: string): LocalCustodyPolicy {
  if (new TextEncoder().encode(text).byteLength > LOCAL_CUSTODY_MAX_BYTES)
    throw new Error('Local custody bytes refused');
  const value = localCustodyPolicySchema.parse(JSON.parse(text));
  if (encodeLocalCustodyPolicy(value) !== text)
    throw new Error('Noncanonical local custody policy');
  return value;
}
export function encodeLocalCustodyEvent(value: unknown): string {
  const text = canonicalLocalCustody(localCustodyEventRequestSchema.parse(value));
  if (new TextEncoder().encode(text).byteLength > LOCAL_CUSTODY_MAX_BYTES * 2)
    throw new Error('Local custody bytes refused');
  return text;
}
export const localCustodyEventReceiptSchema = z
  .object({
    state: z.literal('recorded'),
    tenantId: id,
    actorId: id,
    operationKey: id,
    policyId: id,
    transition: z.enum(['request', 'approve', 'activate', 'revoke', 'review']),
    eventId: id,
    activationEpoch: z.number().int().safe().nonnegative(),
    reviewDueAt: z.number().int().safe().positive(),
    previousEventId: id.nullable(),
    requestText: z.string().max(LOCAL_CUSTODY_MAX_BYTES * 2),
    requestSha256: sha,
    policySha256: sha,
    keyPolicySha256: sha,
    receipt: z
      .object({
        id: z
          .string()
          .regex(/^[1-9][0-9]{0,18}$/)
          .refine((v) => BigInt(v) <= 9223372036854775807n),
        entryHash: sha,
      })
      .strict(),
    replayed: z.boolean(),
  })
  .strict();

/** A separate immutable resolution intent; it never replaces the original. */
export const localCustodyCancellationSchema = z
  .object({
    version: z.literal(1),
    operationKey: id,
    originalRequestText: z.string().max(32768),
    reason: safe,
    confirmed: z.literal(true),
  })
  .strict()
  .superRefine((v, ctx) => {
    try {
      const original = localCustodyEventRequestSchema.parse(JSON.parse(v.originalRequestText));
      if (
        encodeLocalCustodyEvent(original) !== v.originalRequestText ||
        original.operationKey === v.operationKey
      )
        throw Error();
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Exact distinct original operation required' });
    }
  });
export type LocalCustodyCancellation = z.infer<typeof localCustodyCancellationSchema>;
export function encodeLocalCustodyCancellation(value: unknown): string {
  const text = canonicalLocalCustody(localCustodyCancellationSchema.parse(value));
  // The complete HTTP envelope is checked separately against the unchanged64KiB limit.
  if (new TextEncoder().encode(text).byteLength > 65000)
    throw Error('Custody cancellation exceeds its bound');
  return text;
}
export const localCustodyCancellationReceiptSchema = z
  .object({
    state: z.literal('cancelled'),
    tenantId: id,
    actorId: id,
    operationKey: id,
    originalOperationKey: id,
    originalRequestText: z.string().max(32768),
    originalRequestSha256: sha,
    cancellationText: z.string().max(65000),
    cancellationSha256: sha,
    cancellationId: id,
    receipt: z
      .object({
        id: z
          .string()
          .regex(/^[1-9][0-9]{0,18}$/)
          .refine((v) => BigInt(v) <= 9223372036854775807n),
        entryHash: sha,
      })
      .strict(),
    replayed: z.boolean(),
  })
  .strict();
