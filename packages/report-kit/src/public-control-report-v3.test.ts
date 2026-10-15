import { describe, it, expect } from 'vitest';
import { unzipSync } from 'fflate';
import { buildLibrarySeed } from '@axiom/control-library';
import { publicReportFixture, sha, ids } from './public-control-provenance.test-helper';
import { verifyFrozenHumanControlReview } from './public-control-provenance';
import {
  interpretAssessmentReport,
  assessmentReviewRecommendation,
} from './assessment-interpretation';
import { renderReviewedBoardHtml } from './board-source';
import { buildAuditorAssessmentPack, renderReviewedAuditorHtml } from './auditor-source';
import { buildPramaanBoardArchive, buildPramaanAuditorArchive } from './pramaan-archive';
function reviewed(kind: 'board' | 'auditor') {
  const f = publicReportFixture(kind);
  const controls = buildLibrarySeed().controls;
  const result = JSON.parse(f.scope.resultText);
  const interpreted = interpretAssessmentReport(
    result,
    controls,
    sha(f.scope.controlsText),
    f.input.title,
  );
  const content =
    kind === 'auditor'
      ? buildAuditorAssessmentPack(f.input)
      : {
          schema_version: 3,
          kind: 'board_report',
          title: f.input.title,
          tenant_id: ids.tenant,
          engagement_id: ids.engagement,
          assessment_run_id: ids.run,
          source_sha256: f.input.sourceSha256,
          assessment_result_digest: sha(f.scope.resultText),
          library_version: '0.1.1',
          library_digest: sha(f.scope.controlsText),
          generated_at: f.input.generatedAt,
          questionnaire_interpretation: interpreted.interpretation,
          executive_summary: interpreted.summary,
          key_findings: result.findings.map(
            (finding: { control_id: string; score: number; rationale: string }, i: number) => ({
              ...interpreted.findings[i],
              domain: controls[i]!.domain,
              severity: controls[i]!.severity,
              title: controls[i]!.title,
              score: finding.score,
              gap_summary: finding.rationale,
              remediation_recommendation: assessmentReviewRecommendation(
                interpreted.findings[i]!.display_state,
                controls[i]!.remediation_patterns,
              ),
            }),
          ),
          action_plan: [],
          signatures: {
            prepared_by: {
              name: 'Axiom Proof board report builder',
              role: 'Deterministic assessment renderer',
              agent: 'board-report-builder',
            },
            approved_by: null,
          },
          public_review_appendix: verifyFrozenHumanControlReview(f.human, f.scope),
        };
  const documentText = JSON.stringify(content);
  const reviewText = JSON.stringify({
    schema_version: 1,
    report_id: ids.report,
    content_sha256: sha(documentText),
    decision: 'approved',
    reviewer: { id: ids.actor, display_name: 'Synthetic Founder' },
    reviewed_at: '2026-10-16T01:00:00Z',
  });
  return {
    ...f.input,
    documentText,
    documentSha256: sha(documentText),
    reviewText,
    reviewSha256: sha(reviewText),
    reportId: ids.report,
  };
}
function refresh(input: ReturnType<typeof reviewed>) {
  input.documentSha256 = sha(input.documentText);
  const r = JSON.parse(input.reviewText);
  r.content_sha256 = input.documentSha256;
  input.reviewText = JSON.stringify(r);
  input.reviewSha256 = sha(input.reviewText);
}
describe.each(['board', 'auditor'] as const)('versioned %s public-review report', (kind) => {
  const render = kind === 'board' ? renderReviewedBoardHtml : renderReviewedAuditorHtml;
  it('refuses duplicate decoded outer-source keys despite refreshed source/draft/review digests', () => {
    const input = reviewed(kind);
    input.sourceText = input.sourceText.replace(
      '"schema_version":2',
      '"schema_version":1,"schema_version":2',
    );
    input.sourceSha256 = sha(input.sourceText);
    const doc = JSON.parse(input.documentText);
    doc.source_sha256 = input.sourceSha256;
    input.documentText = JSON.stringify(doc);
    refresh(input);
    expect(() => render(input)).toThrow();
  });

  it('renders exact frozen human rationale, Unknowns and partial/demo coverage after genuine draft review', () => {
    const input = reviewed(kind);
    const html = render(input);
    expect(JSON.parse(input.documentText).schema_version).toBe(3);
    expect(html).toContain('Recorded public-source human review');
    expect(html).toContain('Explicit Unknown');
    expect(html).toContain('Omitted judgment — Unknown');
    expect(html).toContain('context demo');
    expect(html).toContain('excerpt_limit');
    expect(html).toContain('Internal evidence and legal review are required');
    expect(html).toContain(
      'This website capture has no retained system or registered connector association and does not verify asset ownership.',
    );
  });
  it.each(['rationale', 'candidate', 'coverage', 'omission', 'verified', 'hash', 'remove'])(
    'refuses a founder-reapproved but forged %s appendix',
    (change) => {
      const input = reviewed(kind);
      const document = JSON.parse(input.documentText);
      const a = document.public_review_appendix;
      if (change === 'rationale')
        a.controls[0].questions[0].rationale = 'Invented verified statement';
      if (change === 'candidate') a.publicCandidates[0].context = 'ordinary_public_content';
      if (change === 'coverage') a.pages[0].coverageReasons = [];
      if (change === 'omission') a.controls[0].questions[0].judgment = 'explicit';
      if (change === 'verified') a.evidenceVerified = true;
      if (change === 'hash') a.reviewSnapshotSha256 = 'f'.repeat(64);
      if (change === 'remove') delete document.public_review_appendix;
      input.documentText = JSON.stringify(document);
      refresh(input);
      expect(() => render(input)).toThrow();
    },
  );
  it('rejects document and source provenance downgrades even when outer hashes/review are refreshed', () => {
    const input = reviewed(kind);
    const d = JSON.parse(input.documentText);
    d.schema_version = 2;
    delete d.public_review_appendix;
    delete d.questionnaire_review;
    input.documentText = JSON.stringify(d);
    refresh(input);
    expect(() => render(input)).toThrow();
    const other = reviewed(kind);
    const source = JSON.parse(other.sourceText);
    source.schema_version = 1;
    other.sourceText = JSON.stringify(source);
    other.sourceSha256 = sha(other.sourceText);
    const doc = JSON.parse(other.documentText);
    doc.source_sha256 = other.sourceSha256;
    other.documentText = JSON.stringify(doc);
    refresh(other);
    expect(() => render(other)).toThrow();
  });
  it('rejects a replaced immutable review, cross-tenant source or packet answer mismatch', () => {
    for (const change of ['review', 'tenant', 'packet']) {
      const input = reviewed(kind);
      const source = JSON.parse(input.sourceText);
      if (change === 'review') source.human_control_review.review.id = ids.report;
      if (change === 'tenant') source.human_control_review.tenant_id = ids.report;
      if (change === 'packet') {
        const result = JSON.parse(source.result_text);
        result.questionnaire_provenance.controls[0].questions[0].declaration = 'caller_affirmed';
        source.result_text = JSON.stringify(result);
        source.result_sha256 = sha(source.result_text);
      }
      input.sourceText = JSON.stringify(source);
      input.sourceSha256 = sha(input.sourceText);
      const doc = JSON.parse(input.documentText);
      doc.source_sha256 = input.sourceSha256;
      input.documentText = JSON.stringify(doc);
      refresh(input);
      expect(() => render(input)).toThrow();
    }
  });
  it('exports exact source2 bytes and refuses a downgraded archive instead of dropping provenance', () => {
    const f = publicReportFixture(kind);
    const sourceBytes = Buffer.from(f.input.sourceText);
    const pdfBytes = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(500, 42)]);
    const build = kind === 'board' ? buildPramaanBoardArchive : buildPramaanAuditorArchive;
    const input = {
      tenantId: ids.tenant,
      engagementId: ids.engagement,
      reportId: ids.report,
      requestId: ids.request,
      title: 'Synthetic public review source',
      source: { id: ids.review, versionId: 'source-version', sha256: sha(f.input.sourceText) },
      pdf: { id: ids.check, versionId: 'pdf-version', sha256: sha(pdfBytes.toString('utf8')) },
      sourceBytes,
      pdfBytes,
    };
    const archive = build(input);
    const files = unzipSync(archive.archive);
    expect(Buffer.from(files['source/assessment.json']!).equals(sourceBytes)).toBe(true);
    const source = JSON.parse(f.input.sourceText);
    source.schema_version = 1;
    const changed = Buffer.from(JSON.stringify(source));
    expect(() =>
      build({
        ...input,
        sourceBytes: changed,
        source: { ...input.source, sha256: sha(changed.toString()) },
      }),
    ).toThrow();
  });
});
