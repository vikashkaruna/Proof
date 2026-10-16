import { describe, it, expect } from 'vitest';
import { unzipSync } from 'fflate';
import { buildLibrarySeed } from '@axiom/control-library';
import { sha, ids } from './public-control-provenance.test-helper';
import { verifyFrozenHumanControlReviewWithAsset } from './public-control-provenance';
import {
  interpretAssessmentReport,
  assessmentReviewRecommendation,
} from './assessment-interpretation';
import { renderReviewedBoardHtml } from './board-source';
import { buildAuditorAssessmentPack, renderReviewedAuditorHtml } from './auditor-source';
import { buildPramaanBoardArchive, buildPramaanAuditorArchive } from './pramaan-archive';
import { assetReportFixture } from './public-control-report-v4.test-helper';
import { canonicalJson } from '@axiom/ledger';
function reviewed(kind: 'board' | 'auditor') {
  const f = assetReportFixture(kind);
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
          schema_version: 4,
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
          ...verifyFrozenHumanControlReviewWithAsset(f.human, f.scope),
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
describe.each(['board', 'auditor'] as const)('source3/doc4 %s asset provenance', (kind) => {
  const render = kind === 'board' ? renderReviewedBoardHtml : renderReviewedAuditorHtml;
  it('renders only frozen human-declared scope and keeps distinct human actors qualified', () => {
    const input = reviewed(kind),
      html = render(input),
      doc = JSON.parse(input.documentText);
    expect(doc.schema_version).toBe(4);
    expect(html).toContain('Human-declared asset scope');
    expect(html).toContain('Declared &lt;system&gt;');
    expect(html).not.toContain('<system>');
    expect(html).toContain('Ownership verified: false');
    expect(html).toContain('Connector access granted: false');
    expect(html).not.toContain('has no retained system');
    expect(html).toContain('Explicit Unknown');
    expect(doc.asset_scope.target.declared_by).not.toBe(doc.asset_scope.association.declared_by);
    expect(doc.asset_scope.target.declared_by).not.toBe(ids.actor);
  });
  it.each(['label', 'system', 'url', 'receipt', 'verified', 'remove', 'downgrade'])(
    'refuses a reapproved forged asset appendix: %s',
    (change) => {
      const input = reviewed(kind),
        doc = JSON.parse(input.documentText);
      if (change === 'label') doc.asset_scope.label = 'Verified asset scope';
      if (change === 'system') doc.asset_scope.system.id = ids.actor;
      if (change === 'url') doc.asset_scope.target.url = 'https://other.test/';
      if (change === 'receipt') doc.asset_scope.association.receipt.entry_hash = 'f'.repeat(64);
      if (change === 'verified') doc.asset_scope.ownership_verified = true;
      if (change === 'remove') delete doc.asset_scope;
      if (change === 'downgrade') {
        doc.schema_version = 3;
        delete doc.asset_scope;
      }
      input.documentText = JSON.stringify(doc);
      refresh(input);
      expect(() => render(input)).toThrow();
    },
  );
  it.each([
    'envelope',
    'requestCodec',
    'snapshotCodec',
    'tenant',
    'targetHash',
    'associationHash',
    'captureReceipt',
    'actor',
    'missing',
    'duplicate',
    'graft',
    'legacySource',
  ])('refuses modified frozen packets even with refreshed outer hashes: %s', (change) => {
    const input = reviewed(kind),
      source = JSON.parse(input.sourceText),
      human = source.human_control_review;
    const snapshot = JSON.parse(human.review.snapshot_text);
    if (change === 'envelope') human.schema_version = 1;
    if (change === 'requestCodec')
      human.review.request_codec = 'axiom-public-control-review-request-canonical-json-1';
    if (change === 'snapshotCodec')
      human.review.snapshot_codec = 'axiom-public-control-review-snapshot-pg-canonical-json-1';
    if (change === 'tenant') snapshot.assetProvenance.tenant_id = ids.actor;
    if (change === 'targetHash') snapshot.assetProvenance.target.snapshot_sha256 = 'f'.repeat(64);
    if (change === 'associationHash')
      snapshot.request.associationRef.associationSha256 = 'f'.repeat(64);
    if (change === 'captureReceipt') snapshot.assetProvenance.association.receipt.id = '11';
    if (change === 'actor') snapshot.assetProvenance.target.actor_id = ids.actor;
    if (change === 'missing') delete snapshot.assetProvenance;
    if (change === 'graft') human.assetProvenance = snapshot.assetProvenance;
    if (change === 'legacySource') source.schema_version = 2;
    human.review.snapshot_text = canonicalJson(snapshot);
    human.review.snapshot_sha256 = sha(human.review.snapshot_text);
    human.review.request_text = canonicalJson(snapshot.request);
    human.review.request_sha256 = sha(human.review.request_text);
    input.sourceText = JSON.stringify(source);
    if (change === 'duplicate')
      input.sourceText = input.sourceText.replace(
        '"schema_version":3',
        '"schema_version":2,"schema_version":3',
      );
    input.sourceSha256 = sha(input.sourceText);
    const doc = JSON.parse(input.documentText);
    doc.source_sha256 = input.sourceSha256;
    input.documentText = JSON.stringify(doc);
    refresh(input);
    expect(() => render(input)).toThrow();
  });
  it('archives exact immutable source3 bytes without consulting current inventory', () => {
    const f = assetReportFixture(kind),
      sourceBytes = Buffer.from(f.input.sourceText),
      pdfBytes = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(500, 42)]);
    const build = kind === 'board' ? buildPramaanBoardArchive : buildPramaanAuditorArchive;
    const result = build({
      tenantId: ids.tenant,
      engagementId: ids.engagement,
      reportId: ids.report,
      requestId: ids.request,
      title: 'Synthetic asset review',
      source: { id: ids.review, versionId: 'source-version', sha256: sha(f.input.sourceText) },
      pdf: { id: ids.check, versionId: 'pdf-version', sha256: sha(pdfBytes.toString()) },
      sourceBytes,
      pdfBytes,
    });
    expect(
      Buffer.from(unzipSync(result.archive)['source/assessment.json']!).equals(sourceBytes),
    ).toBe(true);
  });
});

describe('asset capture timestamp parity without losing microseconds', () => {
  function associationTime(value: string) {
    const f = assetReportFixture(),
      snapshot = JSON.parse(f.human.review.snapshot_text),
      asset = snapshot.assetProvenance;
    const association = JSON.parse(asset.association.snapshot_text);
    association.checkedAt = value;
    asset.association.snapshot_text = canonicalJson(association);
    asset.association.snapshot_sha256 = sha(asset.association.snapshot_text);
    snapshot.request.associationRef.associationSha256 = asset.association.snapshot_sha256;
    f.human.review.request_text = canonicalJson(snapshot.request);
    f.human.review.request_sha256 = sha(f.human.review.request_text);
    f.human.review.snapshot_text = canonicalJson(snapshot);
    f.human.review.snapshot_sha256 = sha(f.human.review.snapshot_text);
    return f;
  }
  it.each(['2026-10-16T00:00:00.000000Z', '2026-10-16T05:30:00.000000+05:30'])(
    'accepts equivalent retained instant %s without rewriting strings/hashes',
    (value) => {
      const f = associationTime(value),
        before = JSON.stringify(f.human);
      expect(
        verifyFrozenHumanControlReviewWithAsset(f.human, f.scope).asset_scope.association
          .checked_at,
      ).toBe(value);
      expect(JSON.stringify(f.human)).toBe(before);
    },
  );
  it.each(['2026-10-16T00:00:00.000001Z', '2026-10-16T05:30:00.000001+05:30'])(
    'refuses a one-microsecond changed instant %s',
    (value) => {
      const f = associationTime(value);
      expect(() => verifyFrozenHumanControlReviewWithAsset(f.human, f.scope)).toThrow();
    },
  );
});
