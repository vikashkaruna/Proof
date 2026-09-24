import { z } from 'zod';

export type EstateId = string & { readonly __brand: 'EstateId' };
export type EstateSystemId = string & { readonly __brand: 'EstateSystemId' };
export type EstateScanId = string & { readonly __brand: 'EstateScanId' };

const key = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
const lifecycle = z.enum(['active', 'archived']);
export const EstateSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  slug: key,
  name: z.string().trim().min(1).max(200),
  description: z.string(),
  status: lifecycle,
  createdAt: z.iso.datetime(),
  version: z.number().int().positive().default(1),
});
export type Estate = z.infer<typeof EstateSchema>;
export const EstateSystemSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  estateId: z.uuid(),
  name: z.string().trim().min(1).max(200),
  systemKind: z.enum(['database', 'application', 'storage', 'identity', 'saas', 'other']),
  externalRef: z.string().nullable(),
  description: z.string(),
  status: lifecycle,
  createdAt: z.iso.datetime(),
  version: z.number().int().positive().default(1),
});
export type EstateSystem = z.infer<typeof EstateSystemSchema>;
export const SystemDataCategorySchema = z.object({
  tenantId: z.uuid(),
  systemId: z.uuid(),
  categoryKey: key,
  source: z.enum(['declared', 'observed']),
  createdAt: z.iso.datetime(),
});
export type SystemDataCategory = z.infer<typeof SystemDataCategorySchema>;
export const EstateScanSchema = z
  .object({
    id: z.uuid(),
    tenantId: z.uuid(),
    estateId: z.uuid(),
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
    startedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
    summary: z.record(z.string(), z.unknown()),
    createdAt: z.iso.datetime(),
  })
  .refine((scan) => {
    if (
      scan.completedAt &&
      (!scan.startedAt || Date.parse(scan.completedAt) < Date.parse(scan.startedAt))
    )
      return false;
    if (scan.status === 'queued') return scan.startedAt === null && scan.completedAt === null;
    if (scan.status === 'running') return scan.startedAt !== null && scan.completedAt === null;
    if (scan.status === 'succeeded' || scan.status === 'failed')
      return scan.startedAt !== null && scan.completedAt !== null;
    return true;
  }, 'Scan timestamps must match its status');
export type EstateScan = z.infer<typeof EstateScanSchema>;

export const CreateEstateRequestSchema = z
  .object({
    slug: key,
    name: z.string().trim().min(1).max(200),
    description: z.string().max(4000).default(''),
  })
  .strict();
export const UpdateEstateRequestSchema = CreateEstateRequestSchema.omit({ slug: true })
  .extend({
    status: lifecycle,
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export const CreateEstateSystemRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    systemKind: EstateSystemSchema.shape.systemKind,
    externalRef: z.string().trim().max(500).nullable().default(null),
    description: z.string().max(4000).default(''),
    dataCategories: z
      .array(key)
      .max(100)
      .refine((v) => new Set(v).size === v.length, 'Duplicate categories')
      .default([]),
  })
  .strict();
export const UpdateEstateSystemRequestSchema = CreateEstateSystemRequestSchema.extend({
  status: lifecycle,
  expectedVersion: z.number().int().positive(),
}).strict();
export const AssignEngagementEstateRequestSchema = z
  .object({ estateId: z.uuid(), confirmed: z.literal(true) })
  .strict();

export const PrepareOnboardingProposalSchema = z
  .object({
    estateId: z.uuid(),
    systems: z.array(CreateEstateSystemRequestSchema).min(1).max(100),
  })
  .strict();
export const ReviewOnboardingProposalSchema = z
  .object({
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.enum(['approved', 'rejected']),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
