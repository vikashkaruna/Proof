import { z } from 'zod';
import { PUBLIC_COVERAGE_PAGES, publicCoverageClarificationSnapshotSchema } from '@axiom/types';
// Immutable V1 display pins only; no font bytes or Node-only renderer imports.
export const PREVIEW_BRANDED_PRESENTATION_V1 = Object.freeze({
  revision: 'axiom-report-brand-1',
  product: 'Axiom Proof',
  company: 'Axiom Minds Private Limited',
  product_url: 'https://axiomproof.ai',
  company_url: 'https://axiomminds.ai',
  workbench_url: 'https://app.axiomproof.ai',
  email: 'hello@axiomminds.ai',
  telephone: '+919757281284',
  font: 'NotoSans-OFL-1.1',
  font_license_sha256: '0dab92d0544f7b233403f14b84a663bdbfa746982eda629e7f4f9ffe1b036feb',
  layout: 'board-A4-portrait-auditor-A4-landscape',
  assets: {
    companyLogo: 'cdd05a59f55db13ffbd5586274b27705140069a53b265c563e9ec8313aacc9e8',
    regularFont: 'b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5',
    boldFont: 'c976e4b1b99edc88775377fcc21692ca4bfa46b6d6ca6522bfda505b28ff9d6a',
    productLogo: '1e4e5e6ef8a959f6a8b095f19d2575a81958dcb842adc3efe747cf821165206d',
  },
});
function matchesPinnedObject(value: unknown, expected: Record<string, unknown>): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = value as Record<string, unknown>;
  return (
    Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, pinned]) =>
      pinned && typeof pinned === 'object' && !Array.isArray(pinned)
        ? matchesPinnedObject(actual[key], pinned as Record<string, unknown>)
        : actual[key] === pinned,
    )
  );
}
const branded = z.object({
  schema_version: z.literal(7),
  underlying_document_version: z.union([z.literal(5), z.literal(6)]),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  underlying_source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  organization_name: z.string().min(1).max(300),
  presentation: z
    .unknown()
    .refine((value) => matchesPinnedObject(value, PREVIEW_BRANDED_PRESENTATION_V1)),
});
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const clarified = branded.extend({
  schema_version: z.literal(8),
  branded_source_sha256: digest,
  tenant_id: z.uuid(),
  engagement_id: z.uuid(),
  owner_coverage_clarification: publicCoverageClarificationSnapshotSchema.nullable(),
  owner_clarification_sha256: digest.nullable(),
  owner_clarification_receipt: z
    .string()
    .max(40)
    .regex(/^[1-9][0-9]*$/)
    .nullable(),
});
const publicCoverage = z.object({
  coverage: z.object({
    pages: z
      .array(
        z.object({
          page: z.enum(PUBLIC_COVERAGE_PAGES),
          state: z.enum(['examined', 'unavailable', 'unexamined']),
          truncated: z.boolean(),
        }),
      )
      .max(5),
  }),
  provenance: z.object({ capturePayloadSha256: digest }),
});
function validateClarified(value: unknown) {
  const doc = clarified.parse(value);
  const snapshot = doc.owner_coverage_clarification;
  if (
    (snapshot === null) !== (doc.owner_clarification_sha256 === null) ||
    (snapshot === null) !== (doc.owner_clarification_receipt === null)
  )
    throw Error('Unsupported report preview');
  if (doc.underlying_document_version === 6) {
    if (snapshot) throw Error('Unsupported report preview');
    return doc;
  }
  const publicDoc = publicCoverage.parse(value);
  const pages = publicDoc.coverage.pages;
  if (new Set(pages.map((p) => p.page)).size !== pages.length)
    throw Error('Unsupported report preview');
  const incomplete = PUBLIC_COVERAGE_PAGES.map(
    (page) => pages.find((p) => p.page === page) ?? { page, state: 'unexamined', truncated: false },
  ).filter((p) => p.state !== 'examined' || p.truncated);
  if (incomplete.length && !snapshot) throw Error('Unsupported report preview');
  if (
    snapshot &&
    (snapshot.tenantId !== doc.tenant_id ||
      snapshot.request.engagementId !== doc.engagement_id ||
      snapshot.request.payloadSha256 !== publicDoc.provenance.capturePayloadSha256 ||
      snapshot.request.expectedPreviousRevisionId !== snapshot.previousRevisionId ||
      snapshot.request.clarifications.length !== incomplete.length ||
      incomplete.some(
        (p) =>
          !snapshot.request.clarifications.some(
            (item) =>
              item.page === p.page &&
              item.sourceState === p.state &&
              item.sourceTruncated === p.truncated,
          ),
      ))
  )
    throw Error('Unsupported report preview');
  return doc;
}
/** Display-only adaptation. Source/review/hash authority remains at authenticated
 * BFF HTML/PDF endpoints. Legacy projections retain their exact schema gates. */
export function reportPreviewVersion(
  value: unknown,
  underlying: 5 | 6,
  digestBound: boolean,
): unknown {
  if (
    !value ||
    typeof value !== 'object' ||
    !('schema_version' in value) ||
    (value.schema_version !== 7 && value.schema_version !== 8)
  )
    return value;
  const parsed = value.schema_version === 8 ? validateClarified(value) : branded.parse(value);
  if (!digestBound || parsed.underlying_document_version !== underlying)
    throw Error('Unsupported report preview');
  return { ...value, schema_version: underlying };
}
