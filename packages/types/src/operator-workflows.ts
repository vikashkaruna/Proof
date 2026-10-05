import { z } from 'zod';

const uuid = z.uuid().transform((v) => v.toLowerCase());
const databaseText = (value: string) =>
  !value.includes('\u0000') &&
  Array.from(value).every((c) => {
    const code = c.codePointAt(0)!;
    return code < 0xd800 || code > 0xdfff;
  });
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(databaseText, 'Text must contain valid Unicode without null characters');
const nullableText = (max: number) => text(max).nullable();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const strings = z.array(text(200)).max(50).nullable();
export const workflowSourceSchema = z
  .object({ observationId: uuid, outputSha256: digest })
  .strict();
const provenance = {
  engagementId: uuid.nullable(),
  sourceNote: text(2000),
  source: workflowSourceSchema.optional(),
};
export const processingActivityPayloadSchema = z
  .object({
    ...provenance,
    system: text(200),
    purpose: nullableText(2000),
    legalBasis: nullableText(200),
    retentionMonths: z.number().int().min(1).max(1200).nullable(),
    dataCategories: strings,
    dataPrincipals: strings,
    processors: strings,
    recipients: strings,
    destinationCountries: strings,
    transferSafeguards: nullableText(2000),
    dpiaRequired: z.boolean().nullable(),
    region: nullableText(100),
    crossBorder: z.boolean().nullable(),
    securityMeasures: nullableText(2000),
  })
  .strict();
export const deliveryTaskPayloadSchema = z
  .object({
    engagementId: uuid.nullable(),
    taskName: text(200),
    source: text(200),
    durationMinutes: z.number().int().min(0).max(1_000_000),
    repetitions: z.number().int().min(1).max(1_000_000),
    notes: z.string().trim().max(2000).refine(databaseText),
  })
  .strict();
export const policyDocumentPayloadSchema = z
  .object({
    ...provenance,
    title: text(300),
    category: z.enum([
      'data_protection',
      'retention',
      'breach_response',
      'access_control',
      'vendor_management',
      'acceptable_use',
      'privacy_notice',
      'consent_notice',
      'dpa_template',
    ]),
    content: z
      .string()
      .min(1)
      .refine((value) => value.trim().length > 0, 'Draft text must contain meaningful content')
      .max(100_000)
      .refine((v) => new TextEncoder().encode(v).byteLength <= 100_000)
      .refine(databaseText, 'Draft text must contain valid Unicode without null characters'),
    sourceRopaId: uuid.nullable(),
  })
  .strict();
export const policyDecisionPayloadSchema = z
  .object({
    draftId: uuid,
    expectedHash: digest,
    decision: z.enum(['approved', 'rejected']),
    reason: text(2000),
  })
  .strict();
export const workflowKindSchema = z.enum([
  'ropa',
  'delivery_task',
  'policy_draft',
  'policy_review',
]);
export type WorkflowKind = z.infer<typeof workflowKindSchema>;
export const workflowRequestSchema = z.discriminatedUnion('kind', [
  z
    .object({
      operationKey: uuid,
      kind: z.literal('ropa'),
      payload: processingActivityPayloadSchema,
    })
    .strict(),
  z
    .object({
      operationKey: uuid,
      kind: z.literal('delivery_task'),
      payload: deliveryTaskPayloadSchema,
    })
    .strict(),
  z
    .object({
      operationKey: uuid,
      kind: z.literal('policy_draft'),
      payload: policyDocumentPayloadSchema,
    })
    .strict(),
  z
    .object({
      operationKey: uuid,
      kind: z.literal('policy_review'),
      payload: policyDecisionPayloadSchema,
    })
    .strict(),
]);
export type WorkflowRequest = z.infer<typeof workflowRequestSchema>;
const record = {
  id: uuid,
  tenant_id: uuid,
  operation_key: uuid,
  created_by: uuid,
  created_at: z.iso.datetime({ offset: true }),
  content_sha256: digest.nullable(),
  receipt_id: z.string().regex(/^[1-9][0-9]*$/),
};
export const workflowRecordSchema = z.discriminatedUnion('kind', [
  z
    .object({ ...record, kind: z.literal('ropa'), payload: processingActivityPayloadSchema })
    .strict(),
  z
    .object({ ...record, kind: z.literal('delivery_task'), payload: deliveryTaskPayloadSchema })
    .strict(),
  z
    .object({ ...record, kind: z.literal('policy_draft'), payload: policyDocumentPayloadSchema })
    .strict(),
  z
    .object({ ...record, kind: z.literal('policy_review'), payload: policyDecisionPayloadSchema })
    .strict(),
]);
export type WorkflowRecord = z.infer<typeof workflowRecordSchema>;
export const workflowRecordedResponseSchema = z
  .object({ data: workflowRecordSchema, replayed: z.boolean() })
  .strict();
export const workflowPageResponseSchema = z
  .object({
    data: z.array(workflowRecordSchema).max(50),
    meta: z
      .object({
        limit: z.number().int().min(1).max(50),
        offset: z.number().int().min(0),
        hasMore: z.boolean(),
      })
      .strict(),
  })
  .strict();
