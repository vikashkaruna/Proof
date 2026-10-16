import { z } from 'zod';
import { AssessmentQuestionnaireSchema } from './assessment-questionnaire';
import { publicControlSourceV2Schema } from './public-control-assessment-v2';

export const PUBLIC_CONTROL_REVIEW_REQUEST_CODEC =
  'axiom-public-control-review-request-canonical-json-1' as const;
export const PUBLIC_CONTROL_REVIEW_MAX_BYTES = 131072;
const uuid = z.uuid().transform((value) => value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const rationale = z
  .string()
  .min(1)
  .refine(
    (value) =>
      [...value].length <= 2000 && /\S/u.test(value) && !/[\u0000\uD800-\uDFFF]/u.test(value),
  );
const identifier = z.string().min(1).max(200);
const judgment = z
  .object({
    answer: z.boolean().nullable(),
    rationale,
    candidateOrdinals: z
      .array(z.number().int().min(1).max(128))
      .max(128)
      .refine((values) => new Set(values).size === values.length),
  })
  .strict();
export const publicControlReviewSetRequestSchema = z
  .object({
    version: z.literal(1),
    operationKey: uuid,
    engagementId: uuid,
    checkId: uuid,
    expectedEstateId: uuid.nullable(),
    expectedPreviousReviewId: uuid.nullable(),
    expectedSource: z
      .object({
        payloadSha256: digest,
        catalogueManifestSha256: digest,
        mappingVersion: z.literal('public-evidence-1'),
        libraryVersion: z.literal('0.1.1'),
        questionnaireDigest: digest,
      })
      .strict(),
    answers: z.record(identifier, z.record(identifier, judgment)),
    applicability: z
      .object({
        sdfSelfAttested: z.boolean().nullable(),
        processesChildren: z.boolean().nullable(),
        processesHealth: z.boolean().nullable(),
        rationale,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      Object.keys(value.answers).length > 46 ||
      Object.values(value.answers).reduce((n, questions) => n + Object.keys(questions).length, 0) >
        5000 ||
      new TextEncoder().encode(JSON.stringify(value)).byteLength > PUBLIC_CONTROL_REVIEW_MAX_BYTES
    )
      ctx.addIssue({ code: 'custom', message: 'Review set exceeds supported bounds' });
  });
export type PublicControlReviewSetRequest = z.infer<typeof publicControlReviewSetRequestSchema>;

/** Structural comparison only. Trusted server custody must authenticate/load the
 * context and verify canonical payload/catalogue bytes independently. */
export function validatePublicControlReviewSet(
  value: unknown,
  trusted: {
    tenantId: string;
    estateId: string | null;
    source: unknown;
    questionnaire: unknown;
    catalogueManifestSha256: string;
  },
) {
  const request = publicControlReviewSetRequestSchema.parse(value);
  const source = publicControlSourceV2Schema.parse(trusted.source);
  const questionnaire = AssessmentQuestionnaireSchema.parse(trusted.questionnaire);
  if (
    source.tenantId !== trusted.tenantId ||
    questionnaire.tenantId !== trusted.tenantId ||
    source.engagementId !== request.engagementId ||
    questionnaire.engagementId !== request.engagementId ||
    source.checkId !== request.checkId ||
    request.expectedEstateId !== trusted.estateId ||
    source.projectionSha256 !== request.expectedSource.payloadSha256 ||
    questionnaire.libraryVersion !== request.expectedSource.libraryVersion ||
    questionnaire.questionnaireDigest !== request.expectedSource.questionnaireDigest ||
    request.expectedSource.catalogueManifestSha256 !== trusted.catalogueManifestSha256
  )
    throw new Error('public_control_review_context_refused');
  const controls = new Map(questionnaire.controls.map((control) => [control.id, control]));
  const candidates = new Set(source.candidates.map((candidate) => candidate.ordinal));
  const answers: Record<string, Record<string, boolean | null>> = {};
  for (const control of questionnaire.controls)
    answers[control.id] = Object.fromEntries(
      control.questions
        .filter((question) => question.type === 'boolean')
        .map((question) => [question.id, null]),
    );
  for (const [controlId, questions] of Object.entries(request.answers)) {
    const control = controls.get(controlId);
    if (!control) throw new Error('public_control_review_question_refused');
    for (const [questionId, entry] of Object.entries(questions)) {
      if (
        !control.questions.some(
          (question) => question.id === questionId && question.type === 'boolean',
        ) ||
        entry.candidateOrdinals.some((ordinal) => !candidates.has(ordinal))
      )
        throw new Error('public_control_review_question_refused');
      answers[controlId]![questionId] = entry.answer;
    }
  }
  return {
    request,
    answers,
    declarationsVerified: false as const,
    requiresHumanReview: true as const,
  };
}

function canonicalReviewJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalReviewJson).join(',') + ']';
  if (typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ':' +
            canonicalReviewJson((value as Record<string, unknown>)[key]),
        )
        .join(',') +
      '}'
    );
  throw new Error('public_control_review_request_refused');
}
/** Exact canonical UTF8 request codec. Equality rejects decoded duplicate keys,
 * alternative escapes, whitespace and unknown keys; parsing confers no authority. */
export function parsePublicControlReviewSetRequestText(text: string) {
  try {
    if (new TextEncoder().encode(text).byteLength > PUBLIC_CONTROL_REVIEW_MAX_BYTES)
      throw new Error();
    const value: unknown = JSON.parse(text);
    const parsed = publicControlReviewSetRequestSchema.parse(value);
    if (canonicalReviewJson(parsed) !== text) throw new Error();
    return parsed;
  } catch {
    throw new Error('public_control_review_request_refused');
  }
}

export const PUBLIC_CONTROL_REVIEW_SNAPSHOT_CODEC =
  'axiom-public-control-review-snapshot-pg-canonical-json-1' as const;
const receipt = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
export const publicControlReviewSetSnapshotSchema = z
  .object({
    version: z.literal(1),
    tenantId: uuid,
    engagementId: uuid,
    estateId: uuid.nullable(),
    checkId: uuid,
    checkedAt: z.iso.datetime({ offset: true }),
    captureReceipt: receipt,
    request: publicControlReviewSetRequestSchema,
    normalizedAnswers: z.record(identifier, z.record(identifier, z.boolean().nullable())),
    declarationsVerified: z.literal(false),
    requiresHumanReview: z.literal(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.engagementId !== value.request.engagementId ||
      value.checkId !== value.request.checkId ||
      value.estateId !== value.request.expectedEstateId ||
      Object.keys(value.normalizedAnswers).length !== 46
    )
      ctx.addIssue({ code: 'custom', message: 'Review snapshot context refused' });
    for (const [control, questions] of Object.entries(value.request.answers))
      for (const [question, judgment] of Object.entries(questions)) {
        if (value.normalizedAnswers[control]?.[question] !== judgment.answer)
          ctx.addIssue({ code: 'custom', message: 'Review declaration projection refused' });
      }
    // Missing judgments must stay unknown, even if a packet contains plausible
    // boolean values. Source-question membership remains a trusted SQL check.
    for (const [control, questions] of Object.entries(value.normalizedAnswers))
      for (const [question, answer] of Object.entries(questions)) {
        if (!Object.hasOwn(value.request.answers[control] ?? {}, question) && answer !== null)
          ctx.addIssue({ code: 'custom', message: 'Unreviewed declaration inferred' });
      }
  });
export const publicControlReviewSetRowSchema = z
  .object({
    id: uuid,
    tenant_id: uuid,
    engagement_id: uuid,
    estate_id: uuid.nullable(),
    check_id: uuid,
    previous_review_id: uuid.nullable(),
    actor_id: uuid,
    operation_key: uuid,
    request_codec: z.literal(PUBLIC_CONTROL_REVIEW_REQUEST_CODEC),
    request_text: z.string().min(2).max(PUBLIC_CONTROL_REVIEW_MAX_BYTES),
    request_sha256: digest,
    snapshot_codec: z.literal(PUBLIC_CONTROL_REVIEW_SNAPSHOT_CODEC),
    snapshot_text: z.string().min(2).max(524288),
    snapshot_sha256: digest,
    receipt_id: receipt,
    created_at: z.iso.datetime({ offset: true }),
  })
  .strict();
export const recordedPublicControlReviewSetSchema = z
  .object({ data: publicControlReviewSetRowSchema, replayed: z.boolean() })
  .strict();
export const readPublicControlReviewSetSchema = z
  .object({
    data: publicControlReviewSetRowSchema,
    isCurrent: z.boolean(),
    contextCurrent: z.boolean(),
  })
  .strict();
export type PublicControlReviewSetSnapshot = z.infer<typeof publicControlReviewSetSnapshotSchema>;
export type PublicControlReviewSetRow = z.infer<typeof publicControlReviewSetRowSchema>;
export const publicControlReviewCancellationRowSchema = z
  .object({
    id: uuid,
    tenant_id: uuid,
    actor_id: uuid,
    engagement_id: uuid,
    check_id: uuid,
    operation_key: uuid,
    request_codec: z.literal(PUBLIC_CONTROL_REVIEW_REQUEST_CODEC),
    request_text: z.string().min(2).max(PUBLIC_CONTROL_REVIEW_MAX_BYTES),
    request_sha256: digest,
    reason: rationale,
    cancellation_codec: z.literal('axiom-public-control-review-cancellation-pg-canonical-json-1'),
    cancellation_text: z.string().min(2).max(16384),
    cancellation_sha256: digest,
    receipt_id: receipt,
    created_at: z.iso.datetime({ offset: true }),
  })
  .strict();
export const cancelPublicControlReviewOperationRequestSchema = z
  .object({ request: publicControlReviewSetRequestSchema, reason: rationale })
  .strict();
export const readPublicControlReviewOperationSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('recorded'),
      data: publicControlReviewSetRowSchema,
      isCurrent: z.boolean(),
      contextCurrent: z.boolean(),
    })
    .strict(),
  z
    .object({ state: z.literal('cancelled'), data: publicControlReviewCancellationRowSchema })
    .strict(),
  z.object({ state: z.literal('not_found') }).strict(),
]);
export const publicControlReviewCancellationSnapshotSchema = z
  .object({
    version: z.literal(1),
    tenantId: uuid,
    actorId: uuid,
    engagementId: uuid,
    checkId: uuid,
    operationKey: uuid,
    requestSha256: digest,
    reason: rationale,
  })
  .strict();

// Additive asset-linked review contract. Existing v1 builders/parsers intentionally
// remain separate: absence of an association never upgrades a historical review.
export const PUBLIC_CONTROL_REVIEW_REQUEST_CODEC_V2 =
  'axiom-public-control-review-request-canonical-json-2' as const;
export const PUBLIC_CONTROL_REVIEW_SNAPSHOT_CODEC_V2 =
  'axiom-public-control-review-snapshot-pg-canonical-json-2' as const;
export const publicControlReviewAssociationRefSchema = z
  .object({
    associationId: uuid,
    associationSha256: digest,
    targetId: uuid,
    targetSha256: digest,
    associationReceipt: z.object({ id: receipt, entryHash: digest }).strict(),
  })
  .strict();
export const publicControlReviewSetRequestV2Schema = z
  .object({
    ...publicControlReviewSetRequestSchema.shape,
    version: z.literal(2),
    expectedEstateId: uuid,
    associationRef: publicControlReviewAssociationRefSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      Object.keys(value.answers).length > 46 ||
      Object.values(value.answers).reduce((n, q) => n + Object.keys(q).length, 0) > 5000 ||
      new TextEncoder().encode(JSON.stringify(value)).byteLength > PUBLIC_CONTROL_REVIEW_MAX_BYTES
    )
      ctx.addIssue({ code: 'custom', message: 'Review set exceeds supported bounds' });
  });
export const publicControlReviewSetAnyRequestSchema = z.discriminatedUnion('version', [
  publicControlReviewSetRequestSchema,
  publicControlReviewSetRequestV2Schema,
]);
export type PublicControlReviewSetRequestV2 = z.infer<typeof publicControlReviewSetRequestV2Schema>;
export function parsePublicControlReviewSetAnyRequestText(text: string) {
  try {
    if (new TextEncoder().encode(text).byteLength > PUBLIC_CONTROL_REVIEW_MAX_BYTES) throw Error();
    const parsed = publicControlReviewSetAnyRequestSchema.parse(JSON.parse(text));
    if (canonicalReviewJson(parsed) !== text) throw Error();
    return parsed;
  } catch {
    throw Error('public_control_review_request_refused');
  }
}
const assetReceipt = z.object({ id: receipt, entry_hash: digest }).strict();
const assetText = z
  .string()
  .min(2)
  .refine((s) => new TextEncoder().encode(s).byteLength <= 16384);
const assetBundle = z
  .object({
    actor_id: uuid,
    operation_key: uuid,
    request_codec: z.literal('axiom-public-website-asset-request-canonical-json-1'),
    request_text: assetText,
    request_sha256: digest,
    snapshot_codec: z.literal('axiom-public-website-asset-snapshot-canonical-json-1'),
    snapshot_text: assetText,
    snapshot_sha256: digest,
    receipt: assetReceipt,
  })
  .strict();
export const publicControlReviewAssetProvenanceSchema = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal('public_website_asset_binding'),
    tenant_id: uuid,
    estate_id: uuid,
    system_id: uuid,
    target: assetBundle,
    association: assetBundle,
    ownership_verified: z.literal(false),
    connector_access_granted: z.literal(false),
    review_required: z.literal(true),
  })
  .strict();
export const publicControlReviewSetSnapshotV2Schema = z
  .object({
    ...publicControlReviewSetSnapshotSchema.shape,
    version: z.literal(2),
    estateId: uuid,
    request: publicControlReviewSetRequestV2Schema,
    assetProvenance: publicControlReviewAssetProvenanceSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const legacy = { ...value, version: 1, request: { ...value.request, version: 1 } };
    const { assetProvenance: _asset, ...snapshot } = legacy;
    const { associationRef: _ref, ...request } = snapshot.request;
    if (!publicControlReviewSetSnapshotSchema.safeParse({ ...snapshot, request }).success)
      ctx.addIssue({ code: 'custom', message: 'Review declaration projection refused' });
    if (
      value.tenantId !== value.assetProvenance.tenant_id ||
      value.estateId !== value.assetProvenance.estate_id
    )
      ctx.addIssue({ code: 'custom', message: 'Review asset scope refused' });
  });
export const publicControlReviewSetAnySnapshotSchema = z.discriminatedUnion('version', [
  publicControlReviewSetSnapshotSchema,
  publicControlReviewSetSnapshotV2Schema,
]);
export const publicControlReviewSetAnyRowSchema = publicControlReviewSetRowSchema
  .extend({
    request_codec: z.enum([
      PUBLIC_CONTROL_REVIEW_REQUEST_CODEC,
      PUBLIC_CONTROL_REVIEW_REQUEST_CODEC_V2,
    ]),
    snapshot_codec: z.enum([
      PUBLIC_CONTROL_REVIEW_SNAPSHOT_CODEC,
      PUBLIC_CONTROL_REVIEW_SNAPSHOT_CODEC_V2,
    ]),
  })
  .superRefine((row, ctx) => {
    if (
      (row.request_codec === PUBLIC_CONTROL_REVIEW_REQUEST_CODEC_V2) !==
      (row.snapshot_codec === PUBLIC_CONTROL_REVIEW_SNAPSHOT_CODEC_V2)
    )
      ctx.addIssue({ code: 'custom', message: 'Review codec pairing refused' });
  });
export const publicControlReviewAnyCancellationRowSchema =
  publicControlReviewCancellationRowSchema.extend({
    request_codec: z.enum([
      PUBLIC_CONTROL_REVIEW_REQUEST_CODEC,
      PUBLIC_CONTROL_REVIEW_REQUEST_CODEC_V2,
    ]),
  });
export const cancelPublicControlReviewAnyOperationRequestSchema =
  cancelPublicControlReviewOperationRequestSchema.extend({
    request: publicControlReviewSetAnyRequestSchema,
  });
export const recordedPublicControlReviewAnySetSchema = recordedPublicControlReviewSetSchema.extend({
  data: publicControlReviewSetAnyRowSchema,
});
export const readPublicControlReviewAnySetSchema = readPublicControlReviewSetSchema.extend({
  data: publicControlReviewSetAnyRowSchema,
});
export const readPublicControlReviewAnyOperationSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('recorded'),
      data: publicControlReviewSetAnyRowSchema,
      isCurrent: z.boolean(),
      contextCurrent: z.boolean(),
    })
    .strict(),
  z
    .object({ state: z.literal('cancelled'), data: publicControlReviewAnyCancellationRowSchema })
    .strict(),
  z.object({ state: z.literal('not_found') }).strict(),
]);
