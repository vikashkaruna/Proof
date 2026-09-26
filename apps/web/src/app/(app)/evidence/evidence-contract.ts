import { z } from 'zod';
import { EvidenceType } from '@axiom/types';
const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)));
export const evidenceRowSchema = z.object({
  id: z.uuid(),
  engagement_id: z.uuid().nullable(),
  content_hash: z.string(),
  filename: z.string().nullable(),
  mime_type: z.string().nullable(),
  byte_size: z.number().nullable(),
  evidence_type: z.string(),
  description: z.string().nullable(),
  collected_by_agent: z.string().nullable(),
  collected_at: timestamp,
  demonstrates_control_ids: z.array(z.string()),
  assurance: z.enum(['legacy_unverified', 'verified_at_ingest']),
  object_version: z
    .object({
      id: z.uuid(),
      provider: z.string(),
      version_id: z.string(),
      lock_mode: z.literal('COMPLIANCE'),
      retain_until: timestamp,
      readback_at: timestamp,
      legal_hold: z.boolean(),
      encryption: z.string(),
    })
    .nullable(),
});
export type EvidenceRow = z.infer<typeof evidenceRowSchema>;
export const operationSchema = z.object({
  operationId: z.uuid(),
  operationKey: z.uuid(),
  status: z.enum(['pending', 'settled']),
  evidenceId: z.uuid().nullable(),
  errorCode: z.string().nullable(),
  createdAt: timestamp,
  retainUntil: timestamp,
});
export type EvidenceOperation = z.infer<typeof operationSchema>;
export const pageMetaSchema = z.object({
  limit: z.number().int(),
  offset: z.number().int(),
  total: z.number().int(),
  hasMore: z.boolean(),
});
export const verificationSchema = z.object({
  evidenceId: z.uuid(),
  integrity: z.literal('verified'),
  retention: z.literal('verified'),
  verifiedAt: timestamp,
  versionId: z.string(),
  retainUntil: timestamp,
  legalHold: z.boolean(),
  encryption: z.string(),
});

export const uploadMetadataSchema = z.object({
  filename: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[^\x00-\x1f\x7f/\\]+$/),
  contentType: z
    .string()
    .max(120)
    .regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/),
  evidenceType: z.enum(EvidenceType),
  description: z.string().trim().min(1).max(2000),
  controlIds: z.array(z.string().min(1).max(80)).max(40),
  engagementId: z.uuid().nullable(),
});
