/** Unmounted public-source presentation contract. Custody and new-request
 * policy selection must be enforced by a future authenticated SQL writer. */
import { createHash } from 'node:crypto';
import { canonicalJson } from '@axiom/ledger';
import { parseCatalogueJson } from '@axiom/control-library';
import { z } from 'zod';
import { FrozenBoardSourceSchema } from './board-source';
import { FrozenAuditorSourceSchema } from './auditor-source';
import {
  verifyFrozenHumanControlReview,
  verifyFrozenHumanControlReviewWithAsset,
} from './public-control-provenance';

export const COVERAGE_FIRST_MAX_BYTES = 4 * 1024 * 1024;
export const COVERAGE_FIRST_SOURCE_CODEC = 'axiom-coverage-first-source-canonical-json-1';
export const coverageFirstHash = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex');
// JSON syntax permits lone surrogate escapes; PostgreSQL/UTF-8 cannot retain them losslessly.
export function parseCoverageFirstJson(text: string, maxBytes: number): unknown {
  const value = parseCatalogueJson(text, maxBytes),
    pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string' && /[\uD800-\uDFFF]/u.test(item))
      throw Error('coverage_unicode_refused');
    if (item && typeof item === 'object') {
      if (!Array.isArray(item)) for (const key of Object.keys(item)) pending.push(key);
      for (const child of Object.values(item)) pending.push(child);
    }
  }
  return value;
}
const boundedText = z
  .string()
  .min(1)
  .refine((v) => Buffer.byteLength(v, 'utf8') <= COVERAGE_FIRST_MAX_BYTES);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const reasons = [
  'public_website_scope_only',
  'human_declarations_unverified',
  'internal_evidence_not_verified',
] as const;
/** Fixed conservative policy; answering every question never changes eligibility. */
export const CoverageFirstPolicySchema = z
  .object({
    version: z.literal(1),
    document_version: z.literal(5),
    evidence_basis: z.literal('public_website_and_unverified_declarations'),
    metrics: z.literal('withheld'),
    reasons: z.tuple([z.literal(reasons[0]), z.literal(reasons[1]), z.literal(reasons[2])]),
    review_required: z.literal(true),
  })
  .strict();
export function coverageFirstPolicy() {
  return CoverageFirstPolicySchema.parse({
    version: 1,
    document_version: 5,
    evidence_basis: 'public_website_and_unverified_declarations',
    metrics: 'withheld',
    reasons: [...reasons],
    review_required: true,
  });
}
export const CoverageFirstSourceV4Schema = z
  .object({
    schema_version: z.literal(4),
    serialization: z.literal(COVERAGE_FIRST_SOURCE_CODEC),
    kind: z.literal('coverage_first_report_source'),
    report_kind: z.enum(['board', 'auditor']),
    presentation_policy: CoverageFirstPolicySchema,
    retained_source: z
      .object({
        serialization: z.literal('postgres-jsonb-text-v1'),
        schema_version: z.union([z.literal(2), z.literal(3)]),
        text: boundedText,
        sha256: digest,
      })
      .strict(),
  })
  .strict();
export const CoverageFirstScopeSchema = z
  .object({
    requestId: z.uuid(),
    tenantId: z.uuid(),
    engagementId: z.uuid(),
    assessmentRunId: z.uuid(),
  })
  .strict();
export type CoverageFirstScope = z.infer<typeof CoverageFirstScopeSchema>;

function readRetained(value: z.infer<typeof CoverageFirstSourceV4Schema>) {
  const original = value.retained_source;
  if (coverageFirstHash(original.text) !== original.sha256) throw Error('coverage_source_refused');
  const raw = parseCoverageFirstJson(original.text, COVERAGE_FIRST_MAX_BYTES);
  const source =
    value.report_kind === 'board'
      ? FrozenBoardSourceSchema.parse(raw)
      : FrozenAuditorSourceSchema.parse(raw);
  if (source.schema_version === 1 || source.schema_version !== original.schema_version)
    throw Error('coverage_public_source_required');
  if (
    coverageFirstHash(source.controls_text) !== source.controls_sha256 ||
    coverageFirstHash(source.result_text) !== source.result_sha256
  )
    throw Error('coverage_source_refused');
  const scope = {
    tenantId: source.tenant_id,
    engagementId: source.engagement_id,
    assessmentRunId: source.assessment_run_id,
    libraryVersion: source.library_version,
    controlsText: source.controls_text,
    resultText: source.result_text,
  };
  const verified =
    source.schema_version === 3
      ? verifyFrozenHumanControlReviewWithAsset(source.human_control_review, scope)
      : {
          public_review_appendix: verifyFrozenHumanControlReview(
            source.human_control_review,
            scope,
          ),
          asset_scope: null,
        };
  return { source, ...verified };
}
/** Called only for a NEW request by future composition; never upgrades an old request in place. */
export function encodeCoverageFirstSource(
  reportKind: 'board' | 'auditor',
  retainedText: string,
  retainedSha256: string,
) {
  try {
    const raw = parseCoverageFirstJson(retainedText, COVERAGE_FIRST_MAX_BYTES);
    const version = z
      .object({ schema_version: z.union([z.literal(2), z.literal(3)]) })
      .parse(raw).schema_version;
    const value = CoverageFirstSourceV4Schema.parse({
      schema_version: 4,
      serialization: COVERAGE_FIRST_SOURCE_CODEC,
      kind: 'coverage_first_report_source',
      report_kind: reportKind,
      presentation_policy: coverageFirstPolicy(),
      retained_source: {
        serialization: 'postgres-jsonb-text-v1',
        schema_version: version,
        text: retainedText,
        sha256: retainedSha256,
      },
    });
    readRetained(value);
    const text = canonicalJson(value);
    // Reject invalid scalar Unicode as well as over-limit serialization, not just JS string length.
    parseCoverageFirstJson(text, COVERAGE_FIRST_MAX_BYTES);
    return { text, sha256: coverageFirstHash(text) };
  } catch {
    throw Error('coverage_source_refused');
  }
}
/** Pure byte/scope verification; no current inventory, authority or ownership assertion. */
export function verifyCoverageFirstSource(
  text: string,
  sha256: string,
  trustedScope: CoverageFirstScope,
) {
  try {
    const scope = CoverageFirstScopeSchema.parse(trustedScope);
    if (!digest.safeParse(sha256).success || coverageFirstHash(text) !== sha256) throw Error();
    const envelope = CoverageFirstSourceV4Schema.parse(
      parseCoverageFirstJson(text, COVERAGE_FIRST_MAX_BYTES),
    );
    if (canonicalJson(envelope) !== text) throw Error();
    const verified = readRetained(envelope);
    if (
      verified.source.request_id !== scope.requestId ||
      verified.source.tenant_id !== scope.tenantId ||
      verified.source.engagement_id !== scope.engagementId ||
      verified.source.assessment_run_id !== scope.assessmentRunId
    )
      throw Error();
    return { envelope, ...verified };
  } catch {
    throw Error('coverage_source_refused');
  }
}
