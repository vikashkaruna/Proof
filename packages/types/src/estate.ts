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
