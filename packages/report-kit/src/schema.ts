/** Browser-safe pack contracts. No storage credentials, provider paths or Node imports. */
import { z } from 'zod';
export const PACK_LIMITS = Object.freeze({
  members: 20,
  memberBytes: 8 * 1024 * 1024,
  aggregateBytes: 48 * 1024 * 1024,
  archiveBytes: 64 * 1024 * 1024,
  metadataBytes: 256 * 1024,
  entries: 24,
});
const uuid = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const timestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v);
const text = (max: number) =>
  z
    .string()
    .min(1)
    .refine((v) => Array.from(v).length <= max)
    .refine((v) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v))
    // Unicode mode matches lone UTF-16 surrogates while allowing valid astral pairs.
    .refine((v) => !/[\ud800-\udfff]/u.test(v));
export const BRANDING = Object.freeze({
  product: 'Axiom Proof',
  company: 'Axiom Minds Private Limited',
  company_url: 'https://axiomminds.ai',
});
export const MANIFEST_BRANDING = BRANDING;
// Match Unicode code-point order (Postgres UTF8 COLLATE "C" / Python), not UTF-16 units.
function compareText(a: string, b: string) {
  const left = Array.from(a),
    right = Array.from(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const diff = left[i]!.codePointAt(0)! - right[i]!.codePointAt(0)!;
    if (diff) return diff;
  }
  return left.length - right.length;
}
const memberSchema = z
  .object({
    evidence_id: uuid,
    receipt_id: uuid,
    version_id: text(1024).refine((v) => v.trim().length > 0 && v !== 'null'),
    path: z.string(),
    content_hash: hash,
    byte_size: z.number().int().min(1).max(PACK_LIMITS.memberBytes),
    filename: text(160).nullable(),
    mime_type: text(200).nullable(),
    description: text(2000).nullable(),
    evidence_type: z.enum([
      'document',
      'config',
      'screenshot',
      'log',
      'attestation',
      'interview',
      'inventory',
      'report',
    ]),
    collected_by_agent: text(100),
    collected_at: timestamp,
    control_ids: z.array(text(100)).max(40),
    provenance: z.enum(['human_submitted', 'unknown', 'production', 'reference', 'sandbox']),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.path !== `evidence/${v.evidence_id}.bin`)
      ctx.addIssue({ code: 'custom', message: 'Unsafe evidence path' });
    if (v.control_ids.some((id, i) => i > 0 && compareText(id, v.control_ids[i - 1]!) <= 0))
      ctx.addIssue({ code: 'custom', message: 'Controls must be unique and sorted' });
    if (v.provenance === 'reference' || v.provenance === 'sandbox')
      ctx.addIssue({
        code: 'custom',
        message: 'Reference and sandbox evidence are excluded from released packs',
      });
  });
export const ManifestV1Schema = z
  .object({
    schema_version: z.literal(1),
    serialization: z.literal('postgres-jsonb-text-v1'),
    kind: z.literal('evidence_pack'),
    pack_id: uuid,
    tenant_id: uuid,
    engagement_id: uuid.nullable(),
    library_version: text(200),
    title: text(200),
    created_at: timestamp,
    branding: z
      .object({
        product: z.literal(BRANDING.product),
        company: z.literal(BRANDING.company),
        company_url: z.literal(BRANDING.company_url),
      })
      .strict(),
    generator: z
      .object({ name: z.literal('evidence-pack-builder'), version: z.literal('1') })
      .strict(),
    members: z.array(memberSchema).min(1).max(PACK_LIMITS.members),
    limitations: z.array(text(2000)).min(1).max(20),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.members.reduce((n, m) => n + m.byte_size, 0) > PACK_LIMITS.aggregateBytes)
      ctx.addIssue({ code: 'custom', message: 'Aggregate evidence byte limit exceeded' });
    if (v.members.some((m, i) => i > 0 && m.evidence_id <= v.members[i - 1]!.evidence_id))
      ctx.addIssue({ code: 'custom', message: 'Members must be unique and sorted' });
    if (new Set(v.members.map((m) => m.receipt_id)).size !== v.members.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate evidence receipt' });
  });
export type ManifestV1 = z.infer<typeof ManifestV1Schema>;
export const ReviewV1Schema = z
  .object({
    schema_version: z.literal(1),
    pack_id: uuid,
    manifest_sha256: hash,
    decision: z.literal('approved'),
    reviewer: z
      .object({ id: uuid, display_name: text(200).refine((v) => v.trim().length > 0) })
      .strict(),
    reviewed_at: timestamp,
  })
  .strict();
export type ReviewV1 = z.infer<typeof ReviewV1Schema>;
