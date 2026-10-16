import { createHash } from 'node:crypto';
import { canonicalJson } from '@axiom/ledger';
import {
  buildLibrarySeed,
  PUBLIC_CONTROL_CATALOGUE_V2_MANIFEST_TEXT,
} from '@axiom/control-library';
import {
  PUBLIC_CONTROL_REVIEW_REQUEST_CODEC,
  PUBLIC_CONTROL_REVIEW_SNAPSHOT_CODEC,
} from '@axiom/types';
import { encodePublicEvidencePayloadV2 } from '../connectors/public-evidence-codec-v2.js';

export const reviewIds = {
  tenant: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  engagement: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  check: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  actor: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  operation: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  review: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
};
const hash = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');
export function publicControlReviewSetFixture() {
  const seed = buildLibrarySeed();
  const ids = reviewIds;
  const pages = (['root', 'privacy', 'contact', 'terms', 'consent'] as const).map((page) => ({
    page,
    state: 'examined' as const,
    contentSha256: hash('synthetic page'),
    truncated: false,
    coverageReasons: [],
  }));
  const encoded = encodePublicEvidencePayloadV2({
    version: 2,
    extractorVersion: 'public-static-evidence-1',
    pages,
    candidates: [],
    candidatesTruncated: false,
    scope: 'bounded_public_pages',
    requiresHumanReview: true,
  });
  const questionnaire = {
    libraryVersion: seed.version,
    controls: seed.controls
      .map((c) => ({
        id: c.id,
        title: c.title,
        questions: c.assessment_questions.map(({ id, prompt, type }) => ({ id, prompt, type })),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  const expectedSource = {
    payloadSha256: encoded.payloadSha256,
    catalogueManifestSha256: hash(PUBLIC_CONTROL_CATALOGUE_V2_MANIFEST_TEXT),
    mappingVersion: 'public-evidence-1' as const,
    libraryVersion: '0.1.1' as const,
    questionnaireDigest: hash(canonicalJson(questionnaire)),
  };
  const first = seed.controls.find((c) =>
    c.assessment_questions.some((q) => q.type === 'boolean'),
  )!;
  const question = first.assessment_questions.find((q) => q.type === 'boolean')!;
  const request = {
    version: 1 as const,
    operationKey: ids.operation,
    engagementId: ids.engagement,
    checkId: ids.check,
    expectedEstateId: null,
    expectedPreviousReviewId: null,
    expectedSource,
    answers: {
      [first.id]: {
        [question.id]: {
          answer: null,
          rationale: 'Synthetic review: internal proof remains unavailable.',
          candidateOrdinals: [],
        },
      },
    },
    applicability: {
      sdfSelfAttested: null,
      processesChildren: null,
      processesHealth: null,
      rationale: 'No verified internal applicability evidence in this synthetic review.',
    },
  };
  const snapshot = {
    version: 1,
    tenantId: ids.tenant,
    engagementId: ids.engagement,
    estateId: null,
    checkId: ids.check,
    checkedAt: '2026-10-16T00:00:00.000Z',
    captureReceipt: '500',
    request,
    normalizedAnswers: Object.fromEntries(
      seed.controls.map((c) => [
        c.id,
        Object.fromEntries(
          c.assessment_questions.filter((q) => q.type === 'boolean').map((q) => [q.id, null]),
        ),
      ]),
    ),
    declarationsVerified: false,
    requiresHumanReview: true,
  };
  const row = {
    id: ids.review,
    tenant_id: ids.tenant,
    engagement_id: ids.engagement,
    estate_id: null,
    check_id: ids.check,
    previous_review_id: null,
    actor_id: ids.actor,
    operation_key: ids.operation,
    request_codec: PUBLIC_CONTROL_REVIEW_REQUEST_CODEC,
    request_text: canonicalJson(request),
    request_sha256: hash(canonicalJson(request)),
    snapshot_codec: PUBLIC_CONTROL_REVIEW_SNAPSHOT_CODEC,
    snapshot_text: canonicalJson(snapshot),
    snapshot_sha256: hash(canonicalJson(snapshot)),
    receipt_id: '9223372036854775807',
    created_at: '2026-10-16T00:01:00.000Z',
  };
  const context = {
    tenantId: ids.tenant,
    engagementId: ids.engagement,
    checkId: ids.check,
    checkedAt: snapshot.checkedAt,
    rootContentSha256: pages[0]!.contentSha256,
    codec: encoded.codec,
    payloadText: encoded.payloadText,
    payloadSha256: encoded.payloadSha256,
    pageSources: pages.map(({ page, state, contentSha256 }) => ({
      page,
      state,
      contentSha256,
      requestedUrl: 'https://public.example.org/',
      finalUrl: 'https://public.example.org/',
    })),
    captureReceipt: '500',
    libraryVersion: seed.version,
    library: {
      version: seed.version,
      published_at: new Date(seed.publishedAt).toISOString(),
      published_by: seed.publishedBy,
      change_log: seed.changeLog,
      control_count: 46,
      status: 'published',
    },
    controls: seed.controls,
    estateId: null,
    catalogueManifestSha256: expectedSource.catalogueManifestSha256,
    mappingVersion: expectedSource.mappingVersion,
    questionnaireDigest: expectedSource.questionnaireDigest,
  };
  return { request, row, snapshot, context };
}
