import { z } from 'zod';
import { UserRole, Capability, can } from '@axiom/types';
import { EvidenceError, type EvidenceDatabase, receiptSchema } from './evidence-ingestion.js';

export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const uuid = z
  .string()
  .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, 'Invalid UUID');
const timestamp = z.string().refine((s) => Number.isFinite(Date.parse(s)));
export const reportStatus = z.enum(['draft', 'approved', 'rejected', 'published', 'archived']);
export const reportSchema = z.object({
  id: uuid,
  tenant_id: uuid,
  engagement_id: uuid.nullable(),
  kind: z.string(),
  title: z.string(),
  library_version: z.string(),
  generated_by_agent: z.string(),
  generated_at: timestamp,
  created_by: uuid.nullable(),
  status: reportStatus,
  content: z.unknown(),
  content_text: z.string().nullable(),
  content_sha256: digest.nullable(),
  reviewed_content_hash: digest.nullable(),
  published_at: timestamp.nullable(),
  released_by: uuid.nullable(),
  released_archive_hash: digest.nullable(),
});
export const reviewSchema = z.object({
  id: uuid,
  tenant_id: uuid,
  report_id: uuid,
  decision: z.enum(['approved', 'rejected']),
  content_sha256: digest,
  reviewed_by: uuid,
  reviewer_name: z.string(),
  reviewed_at: timestamp,
  note: z.string().nullable(),
  review_text: z.string(),
  review_sha256: digest,
});
export const packSchema = z.object({
  id: uuid,
  tenant_id: uuid,
  report_id: uuid,
  operation_key: uuid,
  created_by: uuid,
  created_at: timestamp,
  engagement_id: uuid.nullable(),
  library_version: z.string(),
  title: z.string(),
  manifest_text: z.string(),
  manifest_sha256: digest,
  member_count: z.number().int().min(1).max(20),
  total_member_bytes: z
    .number()
    .int()
    .min(1)
    .max(48 * 1024 * 1024),
});
export const buildRequestSchema = z
  .object({
    provider: z.enum(['s3', 's3-compatible']),
    bucket: z.string().min(1),
    object_key: z.string().min(1),
    content_hash: digest,
    byte_size: z
      .number()
      .int()
      .min(1)
      .max(64 * 1024 * 1024),
    manifest_sha256: digest,
    review_sha256: digest,
    retention_policy: z.literal('seven_years'),
    legal_hold: z.literal(false),
  })
  .strict();
export const buildSchema = z.object({
  id: uuid,
  tenant_id: uuid,
  pack_id: uuid,
  operation_key: uuid,
  actor_id: uuid,
  status: z.enum(['pending', 'settled']),
  request: buildRequestSchema,
  retain_until: timestamp,
  correlation_id: uuid,
  last_error_code: z.string().nullable(),
  created_at: timestamp,
  settled_at: timestamp.nullable(),
});
export const archiveSchema = receiptSchema.omit({ evidence_id: true, ingestion_id: true }).extend({
  pack_id: uuid,
  build_id: uuid,
  byte_size: z
    .number()
    .int()
    .min(1)
    .max(64 * 1024 * 1024),
});
export type Pack = z.infer<typeof packSchema>;
export type Build = z.infer<typeof buildSchema>;
export type Archive = z.infer<typeof archiveSchema>;
export type Report = z.infer<typeof reportSchema>;
export type Review = z.infer<typeof reviewSchema>;
export type PackAccess = {
  actorId: string;
  tenantId: string;
  manager: boolean;
  founder: boolean;
  canExport: boolean;
};

export const reportColumns =
  'id,tenant_id,engagement_id,kind,title,library_version,generated_by_agent,generated_at,created_by,status,content,content_text,content_sha256,reviewed_content_hash,published_at,released_by,released_archive_hash';
export function parseRecord<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new EvidenceError('invalid_report_record', 503);
  return result.data;
}
export async function accessFor(
  db: EvidenceDatabase,
  tenantId: string,
  actorId: string,
  signal: AbortSignal = AbortSignal.timeout(15_000),
): Promise<PackAccess> {
  const { data, error } = await db
    .from('tenant_users')
    .select('role')
    .eq('tenant_id', tenantId)
    .eq('user_id', actorId)
    .abortSignal(signal)
    .maybeSingle();
  if (error) throw new EvidenceError('report_storage_unavailable', 503);
  const role = z.object({ role: z.enum(UserRole) }).safeParse(data);
  if (!role.success) throw new EvidenceError('forbidden', 403);
  const manager = ([UserRole.FOUNDER, UserRole.OWNER, UserRole.ADMIN] as UserRole[]).includes(
    role.data.role,
  );
  let founder = false;
  if (role.data.role === UserRole.FOUNDER) {
    const profile = await db
      .from('users')
      .select('is_axiom_internal')
      .eq('id', actorId)
      .abortSignal(signal)
      .maybeSingle();
    if (profile.error) throw new EvidenceError('report_storage_unavailable', 503);
    founder = z.object({ is_axiom_internal: z.literal(true) }).safeParse(profile.data).success;
  }
  return {
    actorId,
    tenantId,
    manager,
    founder,
    canExport: can(Capability.EVIDENCE_EXPORT, { role: role.data.role }),
  };
}
export function canReadReport(access: PackAccess, report: Report) {
  return (
    report.tenant_id === access.tenantId &&
    (report.status === 'published' ||
      access.founder ||
      (access.manager && report.created_by === access.actorId))
  );
}
export function canManagePack(access: PackAccess, pack: Pack) {
  return (
    pack.tenant_id === access.tenantId &&
    (access.founder || (access.manager && pack.created_by === access.actorId))
  );
}
export function publicReview(review: Review | null) {
  return review
    ? {
        id: review.id,
        decision: review.decision,
        reviewerId: review.reviewed_by,
        reviewerName: review.reviewer_name,
        reviewedAt: review.reviewed_at,
        note: review.note,
        contentHash: review.content_sha256,
      }
    : null;
}
export function publicBuild(build: Build | null) {
  return build
    ? {
        id: build.id,
        operationKey: build.operation_key,
        status: build.status,
        errorCode: build.last_error_code,
        createdAt: build.created_at,
        settledAt: build.settled_at,
        retainUntil: build.retain_until,
      }
    : null;
}
export function publicArchive(archive: Archive | null) {
  return archive
    ? {
        id: archive.id,
        versionId: archive.version_id,
        contentHash: archive.content_hash,
        byteSize: archive.byte_size,
        lockMode: archive.lock_mode,
        retainUntil: archive.retain_until,
        readbackAt: archive.readback_at,
        legalHold: archive.legal_hold,
        encryption: archive.encryption,
      }
    : null;
}
export type PackBundle = {
  pack: Pack;
  report: Report;
  review: Review | null;
  build: Build | null;
  archive: Archive | null;
};
export function publicPack(value: PackBundle, detail = true) {
  const { pack, report, review, build, archive } = value;
  return {
    id: pack.id,
    reportId: pack.report_id,
    operationKey: pack.operation_key,
    title: pack.title,
    engagementId: pack.engagement_id,
    libraryVersion: pack.library_version,
    createdAt: pack.created_at,
    createdBy: pack.created_by,
    status: report.status,
    manifestHash: pack.manifest_sha256,
    memberCount: pack.member_count,
    totalMemberBytes: pack.total_member_bytes,
    ...(detail ? { manifestText: pack.manifest_text } : {}),
    review: review
      ? {
          ...publicReview(review),
          ...(detail ? { reviewText: review.review_text, reviewHash: review.review_sha256 } : {}),
        }
      : null,
    build: publicBuild(build),
    archive: publicArchive(archive),
  };
}
export function publicReport(
  report: Report,
  review: Review | null,
  pack: PackBundle | null,
  detail = false,
) {
  return {
    id: report.id,
    kind: report.kind,
    title: report.title,
    engagementId: report.engagement_id,
    libraryVersion: report.library_version,
    status: report.status,
    generatedAt: report.generated_at,
    generatedByAgent: report.generated_by_agent,
    createdBy: report.created_by,
    contentHash: report.content_sha256,
    reviewedContentHash: report.reviewed_content_hash,
    review: publicReview(review),
    publishedAt: report.published_at,
    releasedBy: report.released_by,
    releasedArchiveHash: report.released_archive_hash,
    assurance: report.content_sha256 ? ('digest_bound' as const) : ('legacy_unverified' as const),
    pack: pack
      ? {
          id: pack.pack.id,
          manifestHash: pack.pack.manifest_sha256,
          memberCount: pack.pack.member_count,
          totalMemberBytes: pack.pack.total_member_bytes,
          build: publicBuild(pack.build),
          archive: publicArchive(pack.archive),
        }
      : null,
    ...(detail ? { contentText: report.content_text, content: report.content } : {}),
  };
}
