/** Synthetic immutable packet; no real assessment, website, actor or audit receipt. */
import { createHash } from 'node:crypto';
import { canonicalJson } from '@axiom/ledger';
import {
  buildLibrarySeed,
  PUBLIC_CONTROL_CATALOGUE_V2_MANIFEST_TEXT,
  publicControlCatalogueV2Manifest,
} from '@axiom/control-library';
import {
  PUBLIC_CONTROL_REVIEW_REQUEST_CODEC,
  PUBLIC_CONTROL_REVIEW_SNAPSHOT_CODEC,
} from '@axiom/types';
import type { FrozenHumanControlReview } from './public-control-provenance';
export const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const ids = {
  tenant: '11111111-1111-4111-8111-111111111111',
  engagement: '22222222-2222-4222-8222-222222222222',
  run: '33333333-3333-4333-8333-333333333333',
  request: '44444444-4444-4444-8444-444444444444',
  actor: '55555555-5555-4555-8555-555555555555',
  job: '66666666-6666-4666-8666-666666666666',
  review: '77777777-7777-4777-8777-777777777777',
  operation: '88888888-8888-4888-8888-888888888888',
  check: '99999999-9999-4999-8999-999999999999',
  report: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};
export function publicReportFixture(kind: 'board' | 'auditor' = 'board') {
  const seed = buildLibrarySeed(),
    manifest = publicControlCatalogueV2Manifest();
  const date = '2026-10-16T00:00:00Z';
  const payload = {
    version: 2,
    extractorVersion: 'static-public-2',
    pages: [
      {
        page: 'root',
        state: 'examined',
        contentSha256: 'b'.repeat(64),
        truncated: true,
        coverageReasons: ['excerpt_limit'],
      },
      { page: 'privacy', state: 'unavailable', truncated: false, coverageReasons: [] },
      { page: 'consent', state: 'unexamined', truncated: false, coverageReasons: [] },
    ],
    candidates: [
      {
        ordinal: 1,
        facet: 'privacy_notice',
        kind: 'public_declaration',
        context: 'demo',
        locator: { page: 'root', contentSha256: 'b'.repeat(64), elementOrdinal: 1 },
        excerpt: '<script>demo privacy statement</script>',
        textDisposition: 'redacted_public_text',
        requiresHumanReview: true,
      },
    ],
    candidatesTruncated: false,
    scope: 'bounded_public_pages',
    requiresHumanReview: true,
  };
  const payloadText = canonicalJson(payload);
  const questionnaire = {
    libraryVersion: seed.version,
    controls: seed.controls
      .map((c) => ({
        id: c.id,
        title: c.title,
        questions: c.assessment_questions.map((q) => ({
          id: q.id,
          prompt: q.prompt,
          type: q.type,
        })),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  const target = manifest.controls.find((c) => c.control.id === 'DPDPA-GOV-002')!;
  const q = target.questions.find((q) => q.publicCandidateFacets.includes('privacy_notice'))!;
  const answers: Record<
    string,
    Record<string, { answer: boolean | null; rationale: string; candidateOrdinals: number[] }>
  > = {
    [target.control.id]: {
      [q.questionId]: {
        answer: null,
        rationale: 'Explicit Unknown: a demo statement is not operational proof. <unsafe>',
        candidateOrdinals: [1],
      },
    },
  };
  const request = {
    version: 1,
    operationKey: ids.operation,
    engagementId: ids.engagement,
    checkId: ids.check,
    expectedEstateId: null,
    expectedPreviousReviewId: null,
    expectedSource: {
      payloadSha256: sha(payloadText),
      catalogueManifestSha256: sha(PUBLIC_CONTROL_CATALOGUE_V2_MANIFEST_TEXT),
      mappingVersion: 'public-evidence-1',
      libraryVersion: '0.1.1',
      questionnaireDigest: sha(canonicalJson(questionnaire)),
    },
    answers,
    applicability: {
      sdfSelfAttested: null,
      processesChildren: null,
      processesHealth: null,
      rationale: 'Unknown applicability; internal proof required.',
    },
  };
  const normalizedAnswers = Object.fromEntries(
    seed.controls.map((c) => [
      c.id,
      Object.fromEntries(
        c.assessment_questions
          .filter((q) => q.type === 'boolean')
          .map((q) => [q.id, answers[c.id]?.[q.id]?.answer ?? null]),
      ),
    ]),
  );
  const snapshot = {
    version: 1,
    tenantId: ids.tenant,
    engagementId: ids.engagement,
    estateId: null,
    checkId: ids.check,
    checkedAt: date,
    captureReceipt: '11',
    request,
    normalizedAnswers,
    declarationsVerified: false,
    requiresHumanReview: true,
  };
  const requestText = canonicalJson(request),
    snapshotText = canonicalJson(snapshot),
    controlsText = JSON.stringify(seed.controls);
  const result = {
    library_version: '0.1.1',
    posture_score: 30,
    estimated_exposure_inr: 12345,
    findings: seed.controls.map((c) => ({
      control_id: c.id,
      score: 30,
      risk_points: 1,
      rationale: 'Unknown; public statement is not operational verification.',
    })),
    questionnaire_provenance: {
      version: 1,
      source_library_version: '0.1.1',
      source_library_digest: sha(controlsText),
      estimates: 'provisional',
      review_required: true,
      controls: seed.controls.map((c) => {
        const qs = c.assessment_questions.filter((q) => q.type === 'boolean');
        return {
          control_id: c.id,
          questions: qs.map((q) => ({ question_id: q.id, declaration: 'unknown' })),
          known_boolean_question_count: qs.length,
          caller_affirmed_count: 0,
          caller_denied_count: 0,
          unknown_count: qs.length,
          answer_state: qs.length ? 'unknown' : 'not_boolean_assessable',
          applicability_state: c.sdf_only || c.children_only ? 'unknown' : 'unconditional',
        };
      }),
      applicability: {
        sdf_self_attested: { value: null, provenance: 'unknown' },
        processes_children: { value: null, provenance: 'unknown' },
        processes_health: { value: null, provenance: 'unknown' },
      },
    },
  };
  const resultText = JSON.stringify(result);
  const inputText = canonicalJson({
    tenant_id: ids.tenant,
    engagement_id: ids.engagement,
    library_version: '0.1.1',
    answers: normalizedAnswers,
    sdf_self_attested: null,
    processes_children: null,
    processes_health: null,
  });
  const pageSources = [
    {
      page: 'root',
      requestedUrl: 'https://example.test/',
      finalUrl: 'https://example.test/',
      state: 'examined',
      contentSha256: 'b'.repeat(64),
    },
    {
      page: 'privacy',
      requestedUrl: 'https://example.test/privacy',
      finalUrl: null,
      state: 'unavailable',
      contentSha256: null,
    },
    {
      page: 'consent',
      requestedUrl: null,
      finalUrl: null,
      state: 'unexamined',
      contentSha256: null,
    },
  ];
  const pageSourcesText = JSON.stringify(pageSources, null, 1);
  const human: FrozenHumanControlReview = {
    schema_version: 1,
    kind: 'public_control_review',
    tenant_id: ids.tenant,
    engagement_id: ids.engagement,
    estate_id: null,
    job_id: ids.job,
    assessment_run_id: ids.run,
    requested_by: ids.request,
    worker_input: {
      codec: 'axiom-assessment-input-canonical-json-1',
      text: inputText,
      sha256: sha(inputText),
    },
    requested_receipt: { id: '13', entry_hash: 'a'.repeat(64) },
    review: {
      id: ids.review,
      actor_id: ids.actor,
      operation_key: ids.operation,
      request_codec: PUBLIC_CONTROL_REVIEW_REQUEST_CODEC,
      request_text: requestText,
      request_sha256: sha(requestText),
      snapshot_codec: PUBLIC_CONTROL_REVIEW_SNAPSHOT_CODEC,
      snapshot_text: snapshotText,
      snapshot_sha256: sha(snapshotText),
      receipt: { id: '12', entry_hash: 'a'.repeat(64) },
      created_at: date,
    },
    capture: {
      check_id: ids.check,
      checked_at: date,
      codec: 'axiom-public-evidence-v2-canonical-json-1',
      payload_text: payloadText,
      payload_sha256: sha(payloadText),
      page_sources: pageSources as FrozenHumanControlReview['capture']['page_sources'],
      page_sources_text: pageSourcesText,
      page_sources_sha256: sha(pageSourcesText),
      capture_receipt: { id: '11', entry_hash: 'a'.repeat(64) },
    },
    catalogue: {
      library_version: '0.1.1',
      questionnaire_digest: request.expectedSource.questionnaireDigest,
      mapping_version: 'public-evidence-1',
      manifest_text: PUBLIC_CONTROL_CATALOGUE_V2_MANIFEST_TEXT,
      manifest_sha256: sha(PUBLIC_CONTROL_CATALOGUE_V2_MANIFEST_TEXT),
    },
    declarations_verified: false,
    evidence_verified: false,
    review_required: true,
  };
  const source = {
    schema_version: 2,
    serialization: 'postgres-jsonb-text-v1',
    kind: kind === 'board' ? 'board_source' : 'statutory_source',
    ...(kind === 'auditor' ? { report_kind: 'auditor' } : {}),
    request_id: ids.request,
    tenant_id: ids.tenant,
    engagement_id: ids.engagement,
    assessment_run_id: ids.run,
    library_version: '0.1.1',
    controls_text: controlsText,
    controls_sha256: sha(controlsText),
    result_text: resultText,
    result_sha256: sha(resultText),
    completed_at: date,
    finalized_at: date,
    receipts: {
      started: { id: '14', entry_hash: 'a'.repeat(64) },
      completed: { id: '15', entry_hash: 'a'.repeat(64) },
      finalized: { id: '16', entry_hash: 'a'.repeat(64) },
    },
    limitations: ['Unverified human declarations; public capture only.'],
    human_control_review: human,
  };
  return {
    human,
    source,
    scope: {
      tenantId: ids.tenant,
      engagementId: ids.engagement,
      assessmentRunId: ids.run,
      libraryVersion: '0.1.1',
      controlsText,
      resultText,
    },
    input: {
      sourceText: JSON.stringify(source),
      sourceSha256: sha(JSON.stringify(source)),
      requestId: ids.request,
      tenantId: ids.tenant,
      engagementId: ids.engagement,
      assessmentRunId: ids.run,
      title: 'Synthetic frozen public review',
      generatedAt: date,
    },
  };
}
