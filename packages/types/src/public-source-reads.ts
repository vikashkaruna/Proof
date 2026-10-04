import { z } from 'zod';
import { EngagementStatus } from './enums';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const receipt = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n);
const timestamp = z.iso
  .datetime({ offset: true })
  .refine((value) => (value.match(/\.(\d+)/)?.[1]?.length ?? 0) <= 6);
export const publicSourceCursorSchema = z.object({ created_at: timestamp, id: uuid }).strict();
export const publicSourceReadQuerySchema = z
  .object({
    limit: z
      .string()
      .regex(/^[1-9][0-9]?$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(50))
      .default(20),
    cursor: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict();
export const publicSourceRequestKeySchema = z
  .string()
  .min(8)
  .max(256)
  .regex(/^[\x20-\x7e]+$/);
export const publicSourceEngagementChoiceSchema = z
  .object({
    id: uuid,
    tenant_id: uuid,
    title: z.string().min(1).max(8192),
    status: z.enum(EngagementStatus).refine((value) => value !== EngagementStatus.CANCELLED),
    library_version: z.string().min(1).max(200),
    created_at: timestamp,
    estate: z
      .object({ id: uuid, name: z.string().min(1).max(8192) })
      .strict()
      .nullable(),
  })
  .strict();
export const publicSourceObservationMetadataSchema = z
  .object({
    observation_id: uuid,
    dispatch_id: uuid,
    run_id: uuid,
    tenant_id: uuid,
    engagement_id: uuid,
    binding_id: uuid,
    agent: z.enum(['drishti', 'vibhaag']),
    output_sha256: digest,
    completion_receipt: receipt,
    created_at: timestamp,
  })
  .strict();
const page = {
  limit: z.number().int().min(1).max(50),
  has_more: z.boolean(),
  next_cursor: publicSourceCursorSchema.nullable(),
};
export const publicSourceEngagementPageSchema = z
  .object({ tenant_id: uuid, data: z.array(publicSourceEngagementChoiceSchema).max(50), ...page })
  .strict();
export const publicSourceObservationPageSchema = z
  .object({
    tenant_id: uuid,
    engagement_id: uuid,
    binding_id: uuid,
    data: z.array(publicSourceObservationMetadataSchema).max(50),
    ...page,
  })
  .strict();
const run = { run_id: uuid, dispatch_id: uuid };
export const publicSourceRequestStateSchema = z
  .object({
    tenant_id: uuid,
    actor_id: uuid,
    engagement_id: uuid,
    binding_id: uuid,
    agent: z.enum(['drishti', 'vibhaag']),
    correlation_id: uuid,
    outcome: z.discriminatedUnion('state', [
      z.object({ state: z.literal('not_found') }).strict(),
      z
        .object({ state: z.literal('unknown'), run_id: uuid, dispatch_id: uuid.optional() })
        .strict(),
      z.object({ state: z.literal('running'), ...run }).strict(),
      z
        .object({
          state: z.literal('confirmed_failed'),
          ...run,
          settlement_receipt: receipt,
          error_code: z.literal('agent_reported_failure'),
        })
        .strict(),
      z
        .object({
          state: z.literal('completed_without_observation'),
          ...run,
          output_sha256: digest,
          completion_receipt: receipt,
        })
        .strict(),
      z
        .object({
          state: z.literal('retained'),
          observation: publicSourceObservationMetadataSchema,
        })
        .strict(),
    ]),
  })
  .strict()
  .refine(
    (value) =>
      value.outcome.state !== 'retained' ||
      (value.outcome.observation.tenant_id === value.tenant_id &&
        value.outcome.observation.engagement_id === value.engagement_id &&
        value.outcome.observation.binding_id === value.binding_id &&
        value.outcome.observation.agent === value.agent),
  );
export type PublicSourceObservationMetadata = z.infer<typeof publicSourceObservationMetadataSchema>;
export type PublicSourceRequestState = z.infer<typeof publicSourceRequestStateSchema>;

const responseMeta = z
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
  .strict();
export const publicSourceEngagementOptionsResponseSchema = z
  .object({ data: z.array(publicSourceEngagementChoiceSchema).max(50), meta: responseMeta })
  .strict();
export const publicSourceObservationHistoryResponseSchema = z
  .object({ data: z.array(publicSourceObservationMetadataSchema).max(50), meta: responseMeta })
  .strict();
export const publicSourceRequestReconciliationResponseSchema = z
  .object({ data: publicSourceRequestStateSchema })
  .strict();
