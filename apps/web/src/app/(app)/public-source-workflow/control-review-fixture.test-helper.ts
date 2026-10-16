import { createHash } from 'node:crypto';
import { canonicalJson } from '@axiom/ledger';
import {
  publicControlCatalogueV2Manifest,
  PUBLIC_CONTROL_CATALOGUE_V2_MANIFEST_TEXT,
} from '@axiom/control-library';
import {
  publicControlAssessmentV2Schema,
  publicControlReviewSetRequestSchema,
  PUBLIC_CONTROL_REVIEW_REQUEST_CODEC,
  PUBLIC_CONTROL_REVIEW_SNAPSHOT_CODEC,
  type PublicControlReviewSetRequest,
} from '@axiom/types';
export const ids = {
  tenant: '11111111-1111-4111-8111-111111111111',
  engagement: '22222222-2222-4222-8222-222222222222',
  check: '33333333-3333-4333-8333-333333333333',
  actor: '44444444-4444-4444-8444-444444444444',
  operation: '55555555-5555-4555-8555-555555555555',
  review: '66666666-6666-4666-8666-666666666666',
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function fixture() {
  const manifest = publicControlCatalogueV2Manifest();
  const unknown = { state: 'internal_unknown', candidateOrdinals: [], requiresHumanReview: true };
  const assessment = publicControlAssessmentV2Schema.parse({
    version: 2,
    source: {
      version: 2,
      extractorVersion: 'static-public-2',
      tenantId: ids.tenant,
      engagementId: ids.engagement,
      checkId: ids.check,
      projectionSha256: 'a'.repeat(64),
      assessmentDate: '2026-10-16',
      pages: [
        {
          page: 'root',
          state: 'examined',
          contentSha256: 'b'.repeat(64),
          truncated: false,
          coverageReasons: [],
        },
      ],
      candidates: [],
      candidatesTruncated: false,
      scope: 'bounded_public_pages',
      requiresHumanReview: true,
    },
    catalogue: {
      libraryVersion: manifest.provenance.libraryVersion,
      baseline: manifest.provenance.baseline,
      defaultEffectiveFrom: manifest.provenance.defaultEffectiveFrom,
      perControlEffectiveDates: manifest.provenance.perControlEffectiveDates,
      effectiveStatus: manifest.provenance.effectiveStatus,
      manifestSha256: hash(PUBLIC_CONTROL_CATALOGUE_V2_MANIFEST_TEXT),
      mappingVersion: manifest.mappingVersion,
    },
    controls: manifest.controls.map((c) => ({
      controlId: c.control.id,
      applicability: c.applicability === 'general' ? 'general' : 'conditional_unknown',
      questions: c.questions.map((q) => ({ questionId: q.questionId, evidence: unknown })),
      evidenceRequirements: c.evidenceRequirements.map((r) => ({
        index: r.index,
        evidence: unknown,
        internalVerificationRequired: true,
      })),
      requiresHumanReview: true,
    })),
    requiresHumanReview: true,
  });
  // Strip publication-only provenance fields, which are intentionally not part of the strict assessment schema.
  return { assessment, manifest };
}
export function reviewFixture() {
  const { assessment, manifest } = fixture();
  const expectedSource = {
    payloadSha256: assessment.source.projectionSha256,
    catalogueManifestSha256: assessment.catalogue.manifestSha256,
    mappingVersion: 'public-evidence-1' as const,
    libraryVersion: '0.1.1' as const,
    questionnaireDigest: 'c'.repeat(64),
  };
  const request = publicControlReviewSetRequestSchema.parse({
    version: 1,
    operationKey: ids.operation,
    engagementId: ids.engagement,
    checkId: ids.check,
    expectedEstateId: null,
    expectedPreviousReviewId: null,
    expectedSource,
    answers: {},
    applicability: {
      sdfSelfAttested: null,
      processesChildren: null,
      processesHealth: null,
      rationale: 'Internal applicability remains unverified.',
    },
  });
  function rowFor(input: PublicControlReviewSetRequest = request) {
    const normalizedAnswers = Object.fromEntries(
      manifest.controls.map((c) => [
        c.control.id,
        Object.fromEntries(
          c.control.assessmentQuestions
            .filter((q) => q.type === 'boolean')
            .map((q) => [q.id, input.answers[c.control.id]?.[q.id]?.answer ?? null]),
        ),
      ]),
    );
    const snapshot = {
      version: 1 as const,
      tenantId: ids.tenant,
      engagementId: ids.engagement,
      checkId: ids.check,
      estateId: input.expectedEstateId,
      checkedAt: '2026-10-16T00:00:00.000Z',
      captureReceipt: '42',
      request: input,
      normalizedAnswers,
      declarationsVerified: false as const,
      requiresHumanReview: true as const,
    };
    return {
      id: ids.review,
      tenant_id: ids.tenant,
      engagement_id: ids.engagement,
      check_id: ids.check,
      estate_id: input.expectedEstateId,
      previous_review_id: input.expectedPreviousReviewId,
      actor_id: ids.actor,
      operation_key: input.operationKey,
      request_codec: PUBLIC_CONTROL_REVIEW_REQUEST_CODEC,
      request_text: canonicalJson(input),
      request_sha256: hash(canonicalJson(input)),
      snapshot_codec: PUBLIC_CONTROL_REVIEW_SNAPSHOT_CODEC,
      snapshot_text: canonicalJson(snapshot),
      snapshot_sha256: hash(canonicalJson(snapshot)),
      receipt_id: '43',
      created_at: '2026-10-16T00:01:00.000Z',
      snapshot,
    };
  }
  const head = {
    tenantId: ids.tenant,
    engagementId: ids.engagement,
    checkId: ids.check,
    estateId: null,
    expectedSource,
    review: null,
  };
  const operation = {
    tenantId: ids.tenant,
    actorId: ids.actor,
    requestText: canonicalJson(request),
  };
  return { assessment, manifest, request, row: rowFor(), rowFor, head, operation };
}
