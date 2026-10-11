import { z } from 'zod';
import { vibhaagPublicOutputSchema } from './public-source-agents';
import { publicSourceCursorSchema } from './public-source-reads';
const uuid = z.uuid().transform((value) => value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const receipt = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n);
const page = z.enum(['root', 'privacy', 'contact', 'terms']);
const form = z.number().int().min(1).max(3);
const control = z.number().int().min(1).max(524288);
const justification = z
  .string()
  .refine(
    (value) =>
      value.length >= 1 && value.length <= 4000 && [...value].length <= 2000 && /\S/u.test(value),
  );
const decision = z.enum(['acknowledged', 'disputed']);
export const publicSourceReviewOperationKeySchema = uuid;
export const createPublicSourceReviewSchema = z
  .object({
    engagementId: uuid,
    expectedOutputSha256: digest,
    expectedProjectionSha256: digest,
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('whole_observation') }).strict(),
      z
        .object({
          kind: z.literal('vibhaag_indicator'),
          page,
          formOrdinal: form,
          controlOrdinal: control,
          expectedContentSha256: digest,
        })
        .strict(),
    ]),
    decision,
    justification,
    expectedPreviousReviewId: uuid.nullable(),
  })
  .strict();
export type CreatePublicSourceReview = z.infer<typeof createPublicSourceReviewSchema>;
export const publicSourceReviewSchema = z
  .object({
    review_id: uuid,
    tenant_id: uuid,
    engagement_id: uuid,
    binding_id: uuid,
    observation_id: uuid,
    agent: z.enum(['drishti', 'vibhaag']),
    dispatch_id: uuid,
    run_id: uuid,
    source_observation_id: uuid.nullable(),
    source_observation_sha256: digest.nullable(),
    estate_id: uuid.nullable(),
    check_id: uuid,
    projection_version: z.literal(1),
    root_content_sha256: digest,
    projection_sha256: digest,
    output_sha256: digest,
    source_request_sha256: digest,
    source_creation_receipt: receipt,
    completion_receipt: receipt,
    settlement_receipt: receipt,
    target_kind: z.enum(['whole_observation', 'vibhaag_indicator']),
    page: page.nullable(),
    form_ordinal: form.nullable(),
    control_ordinal: control.nullable(),
    content_sha256: digest.nullable(),
    source_indicator: vibhaagPublicOutputSchema.shape.indicators.element.nullable(),
    decision,
    justification,
    reviewed_by: uuid,
    operation_key: uuid,
    previous_review_id: uuid.nullable(),
    review_receipt: receipt,
    is_current: z.boolean(),
    created_at: publicSourceCursorSchema.shape.created_at,
  })
  .strict()
  .refine(
    (value) =>
      (value.agent === 'drishti'
        ? value.source_observation_id === null && value.source_observation_sha256 === null
        : value.source_observation_id !== null && value.source_observation_sha256 !== null) &&
      value.previous_review_id !== value.review_id &&
      (value.target_kind === 'whole_observation'
        ? value.page === null &&
          value.form_ordinal === null &&
          value.control_ordinal === null &&
          value.content_sha256 === null &&
          value.source_indicator === null
        : value.agent === 'vibhaag' &&
          value.page !== null &&
          value.form_ordinal !== null &&
          value.control_ordinal !== null &&
          value.content_sha256 !== null &&
          value.source_indicator !== null &&
          value.page === value.source_indicator.page &&
          value.form_ordinal === value.source_indicator.form_ordinal &&
          value.control_ordinal === value.source_indicator.control_ordinal &&
          value.content_sha256 === value.source_indicator.content_sha256),
  );
export type PublicSourceReview = z.infer<typeof publicSourceReviewSchema>;
const context = { tenant_id: uuid, engagement_id: uuid, binding_id: uuid, observation_id: uuid };
type ReviewScope = {
  tenant_id: string;
  engagement_id: string;
  binding_id: string;
  observation_id: string;
};
function sameScope(row: ReviewScope, scope: ReviewScope) {
  return (
    row.tenant_id === scope.tenant_id &&
    row.engagement_id === scope.engagement_id &&
    row.binding_id === scope.binding_id &&
    row.observation_id === scope.observation_id
  );
}
export const publicSourceReviewRecordedSqlSchema = z
  .object({
    ...context,
    data: publicSourceReviewSchema,
    created: z.boolean(),
    replayed: z.boolean(),
  })
  .strict()
  .refine(
    (value) =>
      value.created !== value.replayed &&
      (!value.created || value.data.is_current) &&
      sameScope(value.data, value),
  );
export const publicSourceReviewPageSqlSchema = z
  .object({
    ...context,
    data: z.array(publicSourceReviewSchema).max(50),
    limit: z.number().int().min(1).max(50),
    has_more: z.boolean(),
    next_cursor: publicSourceCursorSchema.nullable(),
  })
  .strict()
  .refine((value) => {
    const last = value.data.at(-1);
    return (
      value.data.length <= value.limit &&
      new Set(value.data.map((row) => row.review_id)).size === value.data.length &&
      value.data.every((row) => sameScope(row, value)) &&
      (value.has_more
        ? value.data.length === value.limit &&
          last !== undefined &&
          value.next_cursor !== null &&
          value.next_cursor.id === last.review_id &&
          value.next_cursor.created_at === last.created_at
        : value.next_cursor === null)
    );
  });
export const publicSourceReviewRequestSqlSchema = z
  .object({
    ...context,
    actor_id: uuid,
    operation_key: uuid,
    outcome: z.discriminatedUnion('state', [
      z.object({ state: z.literal('not_found') }).strict(),
      z.object({ state: z.literal('retained'), review: publicSourceReviewSchema }).strict(),
    ]),
  })
  .strict()
  .refine(
    (value) =>
      value.outcome.state === 'not_found' ||
      (sameScope(value.outcome.review, value) &&
        value.outcome.review.reviewed_by === value.actor_id &&
        value.outcome.review.operation_key === value.operation_key),
  );
export const publicSourceReviewRecordedResponseSchema = z
  .object({ data: publicSourceReviewSchema, created: z.boolean(), replayed: z.boolean() })
  .strict()
  .refine((value) => value.created !== value.replayed && (!value.created || value.data.is_current));
export const publicSourceReviewHistoryResponseSchema = z
  .object({
    data: z.array(publicSourceReviewSchema).max(50),
    meta: z
      .object({
        limit: z.number().int().min(1).max(50),
        hasMore: z.boolean(),
        nextCursor: z
          .string()
          .min(1)
          .max(512)
          .regex(/^[A-Za-z0-9_-]+$/)
          .nullable(),
      })
      .strict(),
  })
  .strict();
export const publicSourceReviewReconciliationResponseSchema = z
  .object({ data: publicSourceReviewRequestSqlSchema })
  .strict();
