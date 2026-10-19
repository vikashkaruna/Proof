/** Explicit human declarations; never observed-transfer or execution authority. */
import { z } from 'zod';
import { canonicalLocalCustody } from './local-custody-policy';
const uuid = z.uuid().refine((v) => v === v.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const text = (max: number) =>
  z
    .string()
    .min(1)
    .refine((v) => Array.from(v).length <= max)
    .refine((v) => v === v.trim() && !/[\u0000\uD800-\uDFFF]/u.test(v));
const instant = z.iso.datetime({ offset: true });
const reason = text(2000).refine((v) => Array.from(v).length >= 20);
export const dataFlowSystemPin = z
  .object({
    systemId: uuid,
    estateId: uuid,
    version: z.number().int().positive(),
    contentSha256: digest,
  })
  .strict();
export const dataFlowParty = z
  .object({
    partyRef: uuid,
    label: text(200),
    role: z.enum(['processor', 'recipient']),
    supersedesPartyRef: uuid.nullable(),
  })
  .strict();
export const dataFlowPartyReference = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('new'), declaration: dataFlowParty }).strict(),
  z.object({ kind: z.literal('existing'), partyRef: uuid, contentSha256: digest }).strict(),
]);
export const dataFlowDestination = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('system'), system: dataFlowSystemPin }).strict(),
  z
    .object({
      kind: z.literal('party'),
      party: dataFlowPartyReference,
      system: dataFlowSystemPin.nullable(),
    })
    .strict(),
  z.object({ kind: z.literal('unknown'), reason: text(2000) }).strict(),
]);
export const dataFlowDeclaration = z
  .object({
    schemaVersion: z.literal(1),
    operationKey: uuid,
    flowId: uuid,
    previousRevisionId: uuid.nullable(),
    origin: dataFlowSystemPin,
    destination: dataFlowDestination,
    purpose: text(2000).nullable(),
    dataCategories: z
      .array(text(80))
      .max(50)
      .refine((v) => new Set(v).size === v.length)
      .nullable(),
    originCountry: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .nullable(),
    destinationCountries: z
      .array(z.string().regex(/^[A-Z]{2}$/))
      .max(50)
      .refine((v) => new Set(v).size === v.length)
      .nullable(),
    crossBorder: z.boolean().nullable(),
    transferSafeguards: text(2000).nullable(),
    sourceRopaId: uuid.nullable(),
    sourceNote: text(2000),
    validUntil: z.iso.datetime(),
    reason,
  })
  .strict();
const decision = z
  .object({
    schemaVersion: z.literal(1),
    operationKey: uuid,
    revisionId: uuid,
    expectedContentSha256: digest,
    reason,
  })
  .strict();
export const dataFlowIntent = z
  .discriminatedUnion('phase', [
    z.object({ phase: z.literal('declare'), request: dataFlowDeclaration }).strict(),
    z.object({ phase: z.literal('approve'), request: decision }).strict(),
    z.object({ phase: z.literal('reject'), request: decision }).strict(),
    z.object({ phase: z.literal('withdraw'), request: decision }).strict(),
  ])
  .superRefine((v, c) => {
    if (new TextEncoder().encode(canonicalLocalCustody(v)).byteLength > 18000)
      c.addIssue({ code: 'custom', message: 'Declaration intent exceeds supported bounds' });
  });
export type DataFlowIntent = z.infer<typeof dataFlowIntent>;
export const encodeDataFlowIntent = (v: DataFlowIntent) =>
  canonicalLocalCustody(dataFlowIntent.parse(v));
const receipt = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((v) => BigInt(v) <= 9223372036854775807n);
const binding = {
  tenantId: uuid,
  actorId: uuid,
  phase: z.enum(['declare', 'approve', 'reject', 'withdraw']),
  operationKey: uuid,
  requestSha256: digest,
};
export const dataFlowOperation = z.discriminatedUnion('recorded', [
  z
    .object({
      ...binding,
      recorded: z.literal(false),
      fenced: z.boolean(),
      fenceReceiptId: receipt.nullable(),
      challengeExpiresAt: instant.nullable(),
    })
    .strict()
    .refine((v) => v.fenced === Boolean(v.fenceReceiptId)),
  z
    .object({
      ...binding,
      recorded: z.literal(true),
      revisionId: uuid,
      receiptId: receipt,
      state: z.enum([
        'proposed',
        'approved',
        'rejected',
        'withdrawn',
        'superseded',
        'expired',
        'stale',
      ]),
    })
    .strict(),
]);
export const dataFlowSource = z
  .object({
    origin: dataFlowSystemPin,
    destination: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('unknown') }).strict(),
      z.object({ kind: z.literal('system'), system: dataFlowSystemPin }).strict(),
      z
        .object({
          kind: z.literal('party'),
          party: z.object({ partyRef: uuid, contentSha256: digest }).strict(),
          system: dataFlowSystemPin.nullable(),
        })
        .strict(),
    ]),
    ropa: z
      .object({ recordId: uuid, receiptId: receipt, payloadSha256: digest })
      .strict()
      .nullable(),
  })
  .strict();
export const dataFlowRevision = z
  .object({
    revisionId: uuid,
    flowId: uuid,
    version: z.number().int().positive(),
    tenantId: uuid,
    preparerId: uuid,
    isHead: z.boolean(),
    request: dataFlowDeclaration,
    requestSha256: digest,
    contentSha256: digest,
    sourceSha256: digest,
    source: dataFlowSource,
    party: dataFlowParty.nullable(),
    state: z.enum([
      'proposed',
      'approved',
      'rejected',
      'withdrawn',
      'superseded',
      'expired',
      'stale',
    ]),
    declarationReceiptId: receipt,
    reviewReceiptId: receipt.nullable(),
    withdrawalReceiptId: receipt.nullable(),
    createdAt: instant,
    reviewedAt: instant.nullable(),
  })
  .strict();
export const dataFlowContext = z
  .object({
    tenantId: uuid,
    actorId: uuid,
    checkedAt: instant,
    canPrepare: z.boolean(),
    canReview: z.boolean(),
    systems: z.array(z.object({ name: text(200), pin: dataFlowSystemPin }).strict()).max(1000),
    parties: z
      .array(z.object({ declaration: dataFlowParty, contentSha256: digest }).strict())
      .max(1000),
    revisions: z.array(dataFlowRevision).max(100),
    historyHasMore: z.boolean(),
  })
  .strict()
  .superRefine((v, c) => {
    for (const ids of [
      v.systems.map((x) => x.pin.systemId),
      v.parties.map((x) => x.declaration.partyRef),
      v.revisions.map((x) => x.revisionId),
    ])
      if (new Set(ids).size !== ids.length)
        c.addIssue({ code: 'custom', message: 'Ambiguous duplicate declaration context' });
    if (v.revisions.some((r) => r.tenantId !== v.tenantId))
      c.addIssue({ code: 'custom', message: 'Foreign declaration revision' });
  });
export type DataFlowContext = z.infer<typeof dataFlowContext>;
/** Trusted deployment configuration only; never source/runtime acceptance. */
export const dataFlowConfiguration = z
  .object({ tenantId: uuid, actorId: uuid, enabled: z.boolean(), metadataOnly: z.literal(true) })
  .strict();
