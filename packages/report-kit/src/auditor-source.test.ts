import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildAuditorAssessmentPack,
  renderAuditorAssessmentPackHtml,
  renderReviewedAuditorHtml,
} from './auditor-source';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const requestId = '11111111-1111-4111-8111-111111111111';
const tenantId = '22222222-2222-4222-8222-222222222222';
const engagementId = '33333333-3333-4333-8333-333333333333';
const assessmentRunId = '44444444-4444-4444-8444-444444444444';

function fixture() {
  const controls_text = JSON.stringify([
    { id: 'CTL-1', title: '<Control>', domain: 'Access', severity: 'high' },
  ]);
  const result_text = JSON.stringify({
    library_version: 'v1',
    posture_score: 45,
    findings: [{ control_id: 'CTL-1', score: 45, risk_points: 7, rationale: '<unverified gap>' }],
  });
  const sourceText = JSON.stringify({
    schema_version: 1,
    serialization: 'postgres-jsonb-text-v1',
    kind: 'statutory_source',
    report_kind: 'auditor',
    request_id: requestId,
    tenant_id: tenantId,
    engagement_id: engagementId,
    assessment_run_id: assessmentRunId,
    library_version: 'v1',
    controls_text,
    controls_sha256: sha(controls_text),
    result_text,
    result_sha256: sha(result_text),
    finalized_at: '2026-09-30T00:00:00Z',
    receipts: { finalized: { id: '12', entry_hash: 'a'.repeat(64) } },
  });
  return {
    sourceText,
    sourceSha256: sha(sourceText),
    requestId,
    tenantId,
    engagementId,
    assessmentRunId,
    title: 'Review',
    generatedAt: '2026-09-30T01:00:00Z',
  };
}

describe('assessment-derived auditor pack', () => {
  it('preserves every frozen finding while labelling provenance and absent attestation', () => {
    const pack = buildAuditorAssessmentPack(fixture());
    expect(pack.findings).toEqual([
      { control_id: 'CTL-1', score: 45, risk_points: 7, rationale: '<unverified gap>' },
    ]);
    const html = renderAuditorAssessmentPackHtml(pack);
    expect(html).toContain('No independent audit, evidence verification, or auditor attestation');
    expect(html).toContain('&lt;unverified gap&gt;');
    expect(html).not.toContain('<unverified gap>');
  });

  it('never promotes a caller-authored request title into the document classification', () => {
    const pack = buildAuditorAssessmentPack({
      ...fixture(),
      title: '<Regulator acceptance confirmed>',
    });
    const html = renderAuditorAssessmentPackHtml(pack);
    expect(html).toContain('<h1>Assessment-derived auditor review pack</h1>');
    expect(html).toContain('Internal request reference: &lt;Regulator acceptance confirmed&gt;');
    expect(html).not.toContain('<h1><Regulator acceptance confirmed></h1>');
  });

  it('refuses a changed source, substituted run and incomplete finding set', () => {
    const valid = fixture();
    expect(() => buildAuditorAssessmentPack({ ...valid, sourceSha256: 'b'.repeat(64) })).toThrow();
    expect(() => buildAuditorAssessmentPack({ ...valid, assessmentRunId: requestId })).toThrow();
    const changed = JSON.parse(valid.sourceText) as Record<string, unknown>;
    const result = JSON.parse(changed.result_text as string) as Record<string, unknown>;
    result.findings = [];
    changed.result_text = JSON.stringify(result);
    changed.result_sha256 = sha(changed.result_text as string);
    const sourceText = JSON.stringify(changed);
    expect(() =>
      buildAuditorAssessmentPack({ ...valid, sourceText, sourceSha256: sha(sourceText) }),
    ).toThrow();
  });

  it('binds the founder review to the exact derived draft before rendering the released PDF HTML', () => {
    const input = fixture();
    const pack = buildAuditorAssessmentPack(input);
    const documentText = JSON.stringify(pack);
    const reportId = '55555555-5555-4555-8555-555555555555';
    const reviewText = JSON.stringify({
      schema_version: 1,
      report_id: reportId,
      content_sha256: sha(documentText),
      decision: 'approved',
      reviewer: { id: tenantId, display_name: 'Internal Founder' },
      reviewed_at: '2026-09-30T02:00:00Z',
    });
    const reviewed = {
      ...input,
      reportId,
      documentText,
      documentSha256: sha(documentText),
      reviewText,
      reviewSha256: sha(reviewText),
    };
    const html = renderReviewedAuditorHtml(reviewed);
    expect(html).toContain('Approved by Internal Founder');
    expect(html).toContain('does not constitute an auditor attestation');
    const changed = { ...pack, posture_score: 90 };
    const changedText = JSON.stringify(changed);
    expect(() =>
      renderReviewedAuditorHtml({
        ...reviewed,
        documentText: changedText,
        documentSha256: sha(changedText),
      }),
    ).toThrow();
    const invented = JSON.stringify({ ...pack, independent_audit_certified: true });
    expect(() =>
      renderReviewedAuditorHtml({
        ...reviewed,
        documentText: invented,
        documentSha256: sha(invented),
      }),
    ).toThrow();
  });
});
