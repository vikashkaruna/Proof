import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { renderReviewedBoardHtml, type ReviewedBoardInput } from './board-source';

const tenantId = '11111111-1111-4111-8111-111111111111';
const engagementId = '22222222-2222-4222-8222-222222222222';
const runId = '33333333-3333-4333-8333-333333333333';
const requestId = '44444444-4444-4444-8444-444444444444';
const reportId = '55555555-5555-4555-8555-555555555555';
const reviewerId = '66666666-6666-4666-8666-666666666666';
const title = 'Quarterly board assessment';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

function fixture(): ReviewedBoardInput {
  const controls = [
    {
      id: 'C-1',
      title: 'Encryption',
      domain: 'Security',
      severity: 'high',
      remediation_patterns: ['Encrypt the storage volume.'],
    },
    {
      id: 'C-2',
      title: 'Retention',
      domain: 'Governance',
      severity: 'low',
      remediation_patterns: [],
    },
  ];
  const result = {
    library_version: 'test-v1',
    posture_score: 60,
    estimated_exposure_inr: 500000,
    findings: [
      { control_id: 'C-1', score: 20, rationale: 'Volume was unencrypted.' },
      { control_id: 'C-2', score: 100, rationale: 'Retention is recorded.' },
    ],
  };
  const controlsText = JSON.stringify(controls);
  const resultText = JSON.stringify(result);
  const sourceText = JSON.stringify({
    schema_version: 1,
    serialization: 'postgres-jsonb-text-v1',
    kind: 'board_source',
    request_id: requestId,
    tenant_id: tenantId,
    engagement_id: engagementId,
    assessment_run_id: runId,
    library_version: 'test-v1',
    controls_text: controlsText,
    controls_sha256: hash(controlsText),
    result_text: resultText,
    result_sha256: hash(resultText),
    finalized_at: '2026-09-30T12:00:00.000Z',
    receipts: {
      started: { id: '1', entry_hash: '1'.repeat(64) },
      completed: { id: '2', entry_hash: '2'.repeat(64) },
      finalized: { id: '3', entry_hash: '3'.repeat(64) },
    },
  });
  const documentText = JSON.stringify({
    schema_version: 1,
    kind: 'board_report',
    title,
    tenant_id: tenantId,
    engagement_id: engagementId,
    assessment_run_id: runId,
    source_sha256: hash(sourceText),
    assessment_result_digest: hash(resultText),
    library_version: 'test-v1',
    library_digest: hash(controlsText),
    generated_at: '2026-09-30T12:01:00.000Z',
    branding: {
      product: 'Axiom Proof',
      company: 'Axiom Minds Private Limited',
      company_url: 'https://axiomminds.ai',
    },
    executive_summary: {
      posture_score: 60,
      total_controls: 2,
      passed_controls: 1,
      failed_controls: 1,
      critical_gaps: 0,
      high_gaps: 1,
      medium_gaps: 0,
      low_gaps: 0,
      estimated_exposure_inr: 500000,
      narrative: `This report summarizes the recorded assessment for ${title}. The computed posture score is 60%. Evidence requirements in the control library do not establish that evidence was collected or independently verified.`,
    },
    key_findings: [
      {
        control_id: 'C-1',
        domain: 'Security',
        severity: 'high',
        title: 'Encryption',
        score: 20,
        gap_summary: 'Volume was unencrypted.',
        remediation_recommendation: 'Encrypt the storage volume.',
      },
      {
        control_id: 'C-2',
        domain: 'Governance',
        severity: 'low',
        title: 'Retention',
        score: 100,
        gap_summary: 'Retention is recorded.',
        remediation_recommendation:
          'No remediation pattern is recorded in the frozen control library.',
      },
    ],
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
  const reviewText = JSON.stringify({
    schema_version: 1,
    report_id: reportId,
    content_sha256: hash(documentText),
    decision: 'approved',
    reviewer: { id: reviewerId, display_name: 'Named Founder' },
    reviewed_at: '2026-09-30T12:02:00.000Z',
  });
  return {
    sourceText,
    sourceSha256: hash(sourceText),
    documentText,
    documentSha256: hash(documentText),
    reviewText,
    reviewSha256: hash(reviewText),
    reportId,
    requestId,
    tenantId,
    engagementId,
    assessmentRunId: runId,
    title,
  };
}

describe('reviewed board source binding', () => {
  it('renders every frozen finding with the actual immutable founder review', () => {
    const input = fixture();
    const html = renderReviewedBoardHtml(input);
    expect(html).toContain('C-1');
    expect(html).toContain('C-2');
    expect(html).toContain('Named Founder');
    expect(html).toContain(input.reviewSha256);
    expect(html).not.toContain('PENDING FOUNDER APPROVAL');
  });

  it('refuses changed metrics even when the caller also changes the document digest', () => {
    const input = fixture();
    const changed = JSON.parse(input.documentText) as Record<string, unknown>;
    const summary = changed.executive_summary as Record<string, unknown>;
    summary.posture_score = 99;
    input.documentText = JSON.stringify(changed);
    input.documentSha256 = hash(input.documentText);
    const review = JSON.parse(input.reviewText) as Record<string, unknown>;
    review.content_sha256 = input.documentSha256;
    input.reviewText = JSON.stringify(review);
    input.reviewSha256 = hash(input.reviewText);
    expect(() => renderReviewedBoardHtml(input)).toThrow('Board document differs');
  });

  it('refuses an incomplete finding register', () => {
    const input = fixture();
    const changed = JSON.parse(input.documentText) as Record<string, unknown>;
    (changed.key_findings as unknown[]).pop();
    input.documentText = JSON.stringify(changed);
    input.documentSha256 = hash(input.documentText);
    const review = JSON.parse(input.reviewText) as Record<string, unknown>;
    review.content_sha256 = input.documentSha256;
    input.reviewText = JSON.stringify(review);
    input.reviewSha256 = hash(input.reviewText);
    expect(() => renderReviewedBoardHtml(input)).toThrow('Board finding register is incomplete');
  });

  it('refuses a changed or unapproved review', () => {
    const input = fixture();
    const review = JSON.parse(input.reviewText) as Record<string, unknown>;
    review.decision = 'rejected';
    input.reviewText = JSON.stringify(review);
    input.reviewSha256 = hash(input.reviewText);
    expect(() => renderReviewedBoardHtml(input)).toThrow();
  });
});

import { boardV2Fixture, packetHash, refreshReview } from './board-v2.fixture';
describe('version 2 source interpretation', () => {
  it('renders 44 unknown and two non-Boolean controls with neutral labels and actual immutable review', () => {
    const input = boardV2Fixture();
    const html = renderReviewedBoardHtml(input);
    for (let i = 1; i <= 46; i++) expect(html).toContain(`C-${i}`);
    expect(html).toContain('Unknown answers or applicability');
    expect(html).toContain('No Boolean assessment questions');
    expect(html).toContain('Provisional Posture Score');
    expect(html).toContain('Synthetic Founder');
    const rows = html.match(/<tr class="finding-row">[\s\S]*?<\/tr>/g)!;
    expect(rows).toHaveLength(46);
    expect(rows.every((row) => row.includes('background-color: #64748B'))).toBe(true);
    expect(html).not.toContain('Critical &amp; High Gaps');
    expect(html).not.toContain('Failed Controls');
    expect(html).not.toContain('Delete');
  });
  it('keeps legacy source generation explicitly provenance unavailable', () => {
    const input = boardV2Fixture(true);
    expect(renderReviewedBoardHtml(input)).toContain('Questionnaire provenance unavailable');
    expect(JSON.parse(input.documentText).executive_summary.provenance_unavailable_controls).toBe(
      46,
    );
  });
  it.each(['summary', 'state', 'recommendation', 'declaration', 'applicability'])(
    'refuses rehashed interpretation tampering: %s',
    (mode) => {
      const input = boardV2Fixture();
      const doc = JSON.parse(input.documentText);
      if (mode === 'applicability') doc.key_findings[0].applicability_state = 'unknown';
      if (mode === 'summary') doc.executive_summary.posture_score = 99;
      if (mode === 'recommendation')
        doc.key_findings[0].remediation_recommendation = 'Delete all personal records immediately.';
      if (mode === 'state') {
        doc.key_findings[0].display_state = 'declared_not_applicable_unverified';
        doc.key_findings[0].applicability_state = 'caller_declared_not_applicable_unverified';
        doc.executive_summary.unknown_controls--;
        doc.executive_summary.not_applicable_controls++;
      }
      if (mode === 'declaration') {
        doc.key_findings[0].answer_state = 'caller_declared_unverified';
        doc.key_findings[0].answer_counts = { known: 2, affirmed: 2, denied: 0, unknown: 0 };
        doc.key_findings[0].display_state = 'provisional_score_band';
        doc.key_findings[0].score_band = 'under_40';
        doc.executive_summary.unknown_controls--;
        doc.executive_summary.provisional_score_bands.under_40++;
      }
      input.documentText = JSON.stringify(doc);
      refreshReview(input);
      expect(() => renderReviewedBoardHtml(input)).toThrow('Board document differs');
    },
  );
  it('refuses V1 downgrade even when source, document and review hashes are internally consistent', () => {
    const input = fixture(),
      v2 = boardV2Fixture();
    const legacySource = JSON.parse(input.sourceText),
      structuredSource = JSON.parse(v2.sourceText);
    const result = JSON.parse(legacySource.result_text);
    result.questionnaire_provenance = JSON.parse(
      structuredSource.result_text,
    ).questionnaire_provenance;
    legacySource.result_text = JSON.stringify(result);
    legacySource.result_sha256 = packetHash(legacySource.result_text);
    input.sourceText = JSON.stringify(legacySource);
    input.sourceSha256 = packetHash(input.sourceText);
    const doc = JSON.parse(input.documentText);
    doc.source_sha256 = input.sourceSha256;
    doc.assessment_result_digest = legacySource.result_sha256;
    input.documentText = JSON.stringify(doc);
    refreshReview(input);
    expect(() => renderReviewedBoardHtml(input)).toThrow('provenance downgrade');
  });
  it('refuses removing metadata from frozen source even after rehashing the full source envelope', () => {
    const input = boardV2Fixture();
    const source = JSON.parse(input.sourceText),
      result = JSON.parse(source.result_text);
    delete result.questionnaire_provenance;
    source.result_text = JSON.stringify(result);
    source.result_sha256 = packetHash(source.result_text);
    input.sourceText = JSON.stringify(source);
    input.sourceSha256 = packetHash(input.sourceText);
    const doc = JSON.parse(input.documentText);
    doc.source_sha256 = input.sourceSha256;
    doc.assessment_result_digest = source.result_sha256;
    input.documentText = JSON.stringify(doc);
    refreshReview(input);
    expect(() => renderReviewedBoardHtml(input)).toThrow('Board document differs');
  });
});
