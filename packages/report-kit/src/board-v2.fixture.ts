/** Synthetic source packet for contract tests; not a domain acceptance receipt. */
import { createHash } from 'node:crypto';
import type { QuestionnaireProvenance } from '@axiom/types';
import {
  interpretAssessmentReport,
  assessmentReviewRecommendation,
} from './assessment-interpretation';
import type { ReviewedBoardInput } from './board-source';
export const packetHash = (text: string) => createHash('sha256').update(text).digest('hex');
export function sourcePacket() {
  const controls = Array.from({ length: 46 }, (_, index) => ({
    id: `C-${index + 1}`,
    title: `Control ${index + 1}`,
    domain: 'Security',
    severity: 'critical' as const,
    library_version: 'test-v2',
    sdf_only: false,
    children_only: false,
    remediation_patterns: ['Verify and correct the configuration.'],
    assessment_questions: Array.from({ length: index < 21 ? 2 : index < 44 ? 1 : 0 }, (_, q) => ({
      id: `Q-${index + 1}-${q}`,
      type: 'boolean',
    })),
  }));
  const controlsText = JSON.stringify(controls);
  const provenance: QuestionnaireProvenance = {
    version: 1,
    source_library_version: 'test-v2',
    source_library_digest: packetHash(controlsText),
    estimates: 'provisional',
    review_required: true,
    controls: controls.map((c) => ({
      control_id: c.id,
      questions: c.assessment_questions.map((q) => ({ question_id: q.id, declaration: 'unknown' })),
      known_boolean_question_count: c.assessment_questions.length,
      caller_affirmed_count: 0,
      caller_denied_count: 0,
      unknown_count: c.assessment_questions.length,
      answer_state: c.assessment_questions.length ? 'unknown' : 'not_boolean_assessable',
      applicability_state: 'unconditional',
    })),
    applicability: {
      sdf_self_attested: { value: null, provenance: 'unknown' },
      processes_children: { value: null, provenance: 'unknown' },
      processes_health: { value: null, provenance: 'unknown' },
    },
  };
  const result = {
    library_version: 'test-v2',
    posture_score: 30,
    estimated_exposure_inr: 123456,
    findings: controls.map((c) => ({
      control_id: c.id,
      score: 30,
      rationale: 'Unanswered questionnaire: supporting evidence required.',
    })),
    questionnaire_provenance: provenance,
  };
  return { controls, result, digest: packetHash(controlsText) };
}
export function boardV2Fixture(legacy = false): ReviewedBoardInput {
  const { controls, result } = sourcePacket();
  const rawResult: Record<string, unknown> = { ...result };
  if (legacy) delete rawResult.questionnaire_provenance;
  const ids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444',
    '55555555-5555-4555-8555-555555555555',
  ];
  const [tenantId, engagementId, assessmentRunId, requestId, reportId] = ids as [
    string,
    string,
    string,
    string,
    string,
  ];
  const title = 'Synthetic unknown questionnaire review';
  const controlsText = JSON.stringify(controls),
    resultText = JSON.stringify(rawResult);
  const sourceText = JSON.stringify({
    schema_version: 1,
    serialization: 'postgres-jsonb-text-v1',
    kind: 'board_source',
    request_id: requestId,
    tenant_id: tenantId,
    engagement_id: engagementId,
    assessment_run_id: assessmentRunId,
    library_version: 'test-v2',
    controls_text: controlsText,
    controls_sha256: packetHash(controlsText),
    result_text: resultText,
    result_sha256: packetHash(resultText),
    finalized_at: '2026-10-01T12:00:00.000Z',
    receipts: {
      started: { id: '1', entry_hash: '1'.repeat(64) },
      completed: { id: '2', entry_hash: '2'.repeat(64) },
      finalized: { id: '3', entry_hash: '3'.repeat(64) },
    },
  });
  const interpreted = interpretAssessmentReport(
    rawResult,
    controls,
    packetHash(controlsText),
    title,
  );
  const documentText = JSON.stringify({
    schema_version: 2,
    kind: 'board_report',
    title,
    tenant_id: tenantId,
    engagement_id: engagementId,
    assessment_run_id: assessmentRunId,
    source_sha256: packetHash(sourceText),
    assessment_result_digest: packetHash(resultText),
    library_version: 'test-v2',
    library_digest: packetHash(controlsText),
    generated_at: '2026-10-01T12:01:00.000Z',
    branding: {
      product: 'Axiom Proof',
      company: 'Axiom Minds Private Limited',
      company_url: 'https://axiomminds.ai',
    },
    questionnaire_interpretation: interpreted.interpretation,
    executive_summary: interpreted.summary,
    key_findings: result.findings.map((f, i) => ({
      ...interpreted.findings[i],
      domain: controls[i]!.domain,
      severity: controls[i]!.severity,
      title: controls[i]!.title,
      score: f.score,
      gap_summary: f.rationale,
      remediation_recommendation: assessmentReviewRecommendation(
        interpreted.findings[i]!.display_state,
        controls[i]!.remediation_patterns,
      ),
    })),
    action_plan: [],
    signatures: {
      prepared_by: {
        name: 'Axiom Proof board report builder',
        role: 'Deterministic assessment renderer',
        agent: 'board-report-builder',
      },
      approved_by: null,
    },
  });
  const input = {
    sourceText,
    sourceSha256: packetHash(sourceText),
    documentText,
    documentSha256: packetHash(documentText),
    reviewText: '',
    reviewSha256: '',
    reportId,
    requestId,
    tenantId,
    engagementId,
    assessmentRunId,
    title,
  };
  refreshReview(input);
  return input;
}
export function refreshReview(input: ReviewedBoardInput) {
  input.documentSha256 = packetHash(input.documentText);
  input.reviewText = JSON.stringify({
    schema_version: 1,
    report_id: input.reportId,
    content_sha256: input.documentSha256,
    decision: 'approved',
    reviewer: { id: '66666666-6666-4666-8666-666666666666', display_name: 'Synthetic Founder' },
    reviewed_at: '2026-10-01T12:02:00.000Z',
  });
  input.reviewSha256 = packetHash(input.reviewText);
}
