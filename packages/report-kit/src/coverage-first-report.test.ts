import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@axiom/ledger';
import { parseCatalogueJson } from '@axiom/control-library';
import { ids, publicReportFixture, sha } from './public-control-provenance.test-helper';
import { assetReportFixture } from './public-control-report-v4.test-helper';
import {
  encodeCoverageFirstSource,
  verifyCoverageFirstSource,
  CoverageFirstSourceV4Schema,
  CoverageFirstPolicySchema,
  coverageFirstPolicy,
  parseCoverageFirstJson,
} from './coverage-first-source';
import {
  buildCoverageFirstReport,
  renderCoverageFirstDraft,
  renderReviewedCoverageFirstReport,
  CoverageFirstDocumentV5Schema,
} from './coverage-first-report';
import { z } from 'zod';
import {
  publicControlReviewSetRequestSchema,
  publicControlReviewSetSnapshotSchema,
} from '@axiom/types';
function fixture(kind: 'board' | 'auditor' = 'board', asset = true) {
  const f = asset ? assetReportFixture(kind) : publicReportFixture(kind);
  const envelope = encodeCoverageFirstSource(kind, f.input.sourceText, f.input.sourceSha256);
  const input = { ...f.input, sourceText: envelope.text, sourceSha256: envelope.sha256 };
  const scope = {
    requestId: input.requestId,
    tenantId: input.tenantId,
    engagementId: input.engagementId,
    assessmentRunId: input.assessmentRunId,
  };
  return { f, envelope, input, scope };
}
function reviewed() {
  const f = fixture();
  const documentText = JSON.stringify(buildCoverageFirstReport(f.input));
  const review = {
    schema_version: 1,
    report_id: ids.report,
    content_sha256: sha(documentText),
    decision: 'approved',
    reviewer: { id: ids.actor, display_name: 'Reviewer <script>not markup</script>' },
    reviewed_at: '2026-10-17T00:00:00Z',
  };
  const reviewText = JSON.stringify(review);
  const { generatedAt: _, ...base } = f.input;
  void _;
  return {
    ...f,
    review,
    input: {
      ...base,
      reportId: ids.report,
      documentText,
      documentSha256: sha(documentText),
      reviewText,
      reviewSha256: sha(reviewText),
    },
  };
}
describe('unmounted source4/document5 coverage-first public review', () => {
  for (const kind of ['board', 'auditor'] as const)
    for (const asset of [false, true])
      it(
        kind +
          ' source' +
          (asset ? 3 : 2) +
          ' retains original bytes and produces qualified evidence instead of metrics',
        () => {
          const f = fixture(kind, asset);
          const verified = verifyCoverageFirstSource(f.envelope.text, f.envelope.sha256, f.scope);
          expect(verified.envelope.retained_source.text).toBe(f.f.input.sourceText);
          expect(verified.envelope.retained_source.sha256).toBe(f.f.input.sourceSha256);
          expect(
            encodeCoverageFirstSource(kind, f.f.input.sourceText, f.f.input.sourceSha256),
          ).toEqual(f.envelope);
          const d = buildCoverageFirstReport(f.input);
          expect(d.schema_version).toBe(5);
          expect(d.assessment_result_digest).toBe(f.f.source.result_sha256);
          expect(d.library_digest).toBe(f.f.source.controls_sha256);
          expect(d.kind).toBe(kind === 'board' ? 'board_report' : 'auditor_pack');
          expect(d.controls).toHaveLength(46);
          expect(d.asset_scope !== null).toBe(asset);
          expect(d.metrics).toEqual({ state: 'withheld', compliance_conclusion: 'not_determined' });
          expect(d.summary.omittedUnknown).toBeGreaterThan(0);
          expect(d.summary.explicitUnknown).toBeGreaterThan(0);
          expect(d.coverage.pages.map((p) => p.state)).toEqual([
            'examined',
            'unavailable',
            'unexamined',
          ]);
          expect(
            d.controls.some((c) => c.questions.some((q) => q.citedCandidateOrdinals.includes(1))),
          ).toBe(true);
          const text = JSON.stringify(d);
          for (const claim of [
            'posture_score',
            'estimated_exposure_inr',
            'score_band',
            'risk_points',
          ])
            expect(text).not.toContain(claim);
          const html = renderCoverageFirstDraft({
            ...f.input,
            title: 'Test <script>unsafe</script>',
          });
          expect(html).toContain('Scores and financial exposure estimates are withheld');
          expect(html).toContain('Draft for human review');
          expect(html).toContain('No whole-site crawl');
          expect(html).toContain('Zero forms does not mean a page or privacy notice is missing');
          expect(html).toContain('Omitted judgment — Unknown');
          expect(html).not.toContain('<script>');
          expect(html).not.toContain('Board Draft');
          expect(html.match(/&lt;script&gt;demo privacy statement&lt;\/script&gt;/g)).toHaveLength(
            1,
          );
          expect(html).not.toContain('12345');
          if (asset) expect(html).toContain('Ownership is not verified');
        },
      );
  it('rejects altered policies, omissions, duplicates, unknown fields and raw numeric claim grafts', () => {
    const policy = coverageFirstPolicy();
    for (const patch of [
      { metrics: 'published' },
      { document_version: 4 },
      { evidence_basis: 'all_answers_complete' },
      { reasons: [] },
      { reasons: [policy.reasons[0], policy.reasons[0], policy.reasons[2]] },
      { score: 100 },
    ])
      expect(CoverageFirstPolicySchema.safeParse({ ...policy, ...patch }).success).toBe(false);
    const f = fixture();
    const d = buildCoverageFirstReport(f.input);
    expect(CoverageFirstDocumentV5Schema.safeParse({ ...d, posture_score: 100 }).success).toBe(
      false,
    );
    expect(
      CoverageFirstDocumentV5Schema.safeParse({
        ...d,
        metrics: { ...d.metrics, estimated_exposure_inr: 1 },
      }).success,
    ).toBe(false);
    expect(
      CoverageFirstDocumentV5Schema.safeParse({
        ...d,
        controls: [{ ...d.controls[0], score: 100 }],
      }).success,
    ).toBe(false);
    expect(
      CoverageFirstSourceV4Schema.safeParse({ ...JSON.parse(f.envelope.text), active: true })
        .success,
    ).toBe(false);
    const duplicate = f.envelope.text.replace(
      '"schema_version":4',
      '"schema_version":4,"schema_version":4',
    );
    expect(() => verifyCoverageFirstSource(duplicate, sha(duplicate), f.scope)).toThrow(
      'coverage_source_refused',
    );
  });
  it.each(['tenantId', 'engagementId', 'requestId', 'assessmentRunId'] as const)(
    'refuses changed trusted %s despite internally valid payload',
    (field) => {
      const f = fixture();
      expect(() =>
        verifyCoverageFirstSource(f.envelope.text, f.envelope.sha256, {
          ...f.scope,
          [field]: ids.actor,
        }),
      ).toThrow('coverage_source_refused');
    },
  );
  it('refuses nested hash mismatch, wrong report kind, unsupported old source and source/digest tampering', () => {
    const f = fixture();
    expect(() =>
      encodeCoverageFirstSource('auditor', f.f.input.sourceText, f.f.input.sourceSha256),
    ).toThrow();
    expect(() =>
      encodeCoverageFirstSource('board', f.f.input.sourceText, 'a'.repeat(64)),
    ).toThrow();
    expect(() =>
      encodeCoverageFirstSource('board', '{"schema_version":1}', sha('{"schema_version":1}')),
    ).toThrow();
    const envelope = CoverageFirstSourceV4Schema.parse(JSON.parse(f.envelope.text));
    envelope.retained_source.text += ' ';
    const text = canonicalJson(envelope);
    expect(() => verifyCoverageFirstSource(text, sha(text), f.scope)).toThrow();
    expect(() => verifyCoverageFirstSource(f.envelope.text, 'f'.repeat(64), f.scope)).toThrow();
    expect(() =>
      verifyCoverageFirstSource(
        '{"private-secret":"hidden"}',
        sha('{"private-secret":"hidden"}'),
        f.scope,
      ),
    ).toThrow(/^coverage_source_refused$/);
  });
  it('retains the frozen policy across independent caller copies and refuses a policy upgrade in a new envelope', () => {
    const f = fixture();
    const decoded = verifyCoverageFirstSource(f.envelope.text, f.envelope.sha256, f.scope);
    decoded.envelope.presentation_policy.reasons.reverse();
    expect(
      verifyCoverageFirstSource(f.envelope.text, f.envelope.sha256, f.scope).envelope
        .presentation_policy,
    ).toEqual(coverageFirstPolicy());
    const changed = canonicalJson(decoded.envelope);
    expect(() => verifyCoverageFirstSource(changed, sha(changed), f.scope)).toThrow();
    expect(renderCoverageFirstDraft(f.input)).toBe(renderCoverageFirstDraft(f.input));
  });
  it('requires separate exact content-bound human review and never infers release', () => {
    const f = reviewed();
    const html = renderReviewedCoverageFirstReport(f.input);
    expect(html).toContain('Human-reviewed evidence report');
    expect(html).toContain('Reviewer &lt;script&gt;not markup&lt;/script&gt;');
    expect(html).toContain('does not itself establish artifact release');
    expect(html).not.toContain('Draft for human review');
    expect(html).not.toContain('<script>');
    for (const patch of [
      { content_sha256: 'f'.repeat(64) },
      { report_id: ids.check },
      { decision: 'rejected' },
      { released: true },
    ]) {
      const reviewText = JSON.stringify({ ...f.review, ...patch });
      expect(() =>
        renderReviewedCoverageFirstReport({
          ...f.input,
          reviewText,
          reviewSha256: sha(reviewText),
        }),
      ).toThrow('coverage_review_refused');
    }
    const graft = JSON.stringify({ ...JSON.parse(f.input.documentText), summary: { controls: 0 } });
    expect(() =>
      renderReviewedCoverageFirstReport({
        ...f.input,
        documentText: graft,
        documentSha256: sha(graft),
      }),
    ).toThrow();
    expect(() =>
      renderReviewedCoverageFirstReport({ ...f.input, title: 'Another request' }),
    ).toThrow();
    expect(() =>
      renderReviewedCoverageFirstReport({ ...f.input, documentSha256: 'f'.repeat(64) }),
    ).toThrow();
    expect(() =>
      renderReviewedCoverageFirstReport({ ...f.input, reviewSha256: 'f'.repeat(64) }),
    ).toThrow();
  });
  it('rejects a self-hashed, re-reviewed forged control declaration and malformed scalar title', () => {
    const f = reviewed();
    const document = CoverageFirstDocumentV5Schema.parse(JSON.parse(f.input.documentText));
    document.controls[0]!.questions[0]!.rationale = 'Invented operational proof';
    const documentText = JSON.stringify(document);
    const reviewText = JSON.stringify({ ...f.review, content_sha256: sha(documentText) });
    expect(() =>
      renderReviewedCoverageFirstReport({
        ...f.input,
        documentText,
        documentSha256: sha(documentText),
        reviewText,
        reviewSha256: sha(reviewText),
      }),
    ).toThrow('coverage_review_refused');
    for (const field of ['assessment_result_digest', 'library_digest'] as const) {
      const original = CoverageFirstDocumentV5Schema.parse(JSON.parse(f.input.documentText));
      original[field] = 'f'.repeat(64);
      const documentText = JSON.stringify(original);
      const reviewText = JSON.stringify({ ...f.review, content_sha256: sha(documentText) });
      expect(() =>
        renderReviewedCoverageFirstReport({
          ...f.input,
          documentText,
          documentSha256: sha(documentText),
          reviewText,
          reviewSha256: sha(reviewText),
        }),
      ).toThrow('coverage_review_refused');
    }
    const source = fixture();
    expect(() =>
      buildCoverageFirstReport({ ...source.input, title: String.fromCharCode(0xd800) }),
    ).toThrow('coverage_document_refused');
  });
  it('bounds exact UTF8 bytes and refuses malformed scalar values at every decoded depth', () => {
    expect(parseCoverageFirstJson('{"title":"😀"}', 32)).toEqual({ title: '😀' });
    expect(() => parseCoverageFirstJson('{"title":"😀"}', 12)).toThrow();
    expect(() =>
      parseCoverageFirstJson(JSON.stringify({ items: [String.fromCharCode(0xd800)] }), 100),
    ).toThrow();
    const f = fixture();
    const oversize = {
      ...JSON.parse(f.envelope.text),
      retained_source: {
        ...JSON.parse(f.envelope.text).retained_source,
        text: 'x'.repeat(4 * 1024 * 1024 + 1),
      },
    };
    const text = canonicalJson(oversize);
    expect(() => verifyCoverageFirstSource(text, sha(text), f.scope)).toThrow(
      'coverage_source_refused',
    );
  });
  it('withholds metrics even when every Boolean question has an explicit Yes declaration', () => {
    const f = publicReportFixture();
    const request = publicControlReviewSetRequestSchema.parse(
      parseCatalogueJson(f.human.review.request_text, 4 * 1024 * 1024),
    );
    const snapshot = publicControlReviewSetSnapshotSchema.parse(
      parseCatalogueJson(f.human.review.snapshot_text, 4 * 1024 * 1024),
    );
    for (const [control, questions] of Object.entries(snapshot.normalizedAnswers)) {
      request.answers[control] = {};
      for (const q of Object.keys(questions)) {
        request.answers[control]![q] = {
          answer: true,
          rationale: 'Human declaration without verified internal proof.',
          candidateOrdinals: [],
        };
        questions[q] = true;
      }
    }
    snapshot.request = request;
    f.human.review.request_text = canonicalJson(request);
    f.human.review.request_sha256 = sha(f.human.review.request_text);
    f.human.review.snapshot_text = canonicalJson(snapshot);
    f.human.review.snapshot_sha256 = sha(f.human.review.snapshot_text);
    const worker = z
      .object({ answers: z.record(z.string(), z.record(z.string(), z.boolean().nullable())) })
      .passthrough()
      .parse(parseCatalogueJson(f.human.worker_input.text, 4 * 1024 * 1024));
    worker.answers = snapshot.normalizedAnswers;
    f.human.worker_input.text = canonicalJson(worker);
    f.human.worker_input.sha256 = sha(f.human.worker_input.text);
    const result = z
      .object({
        questionnaire_provenance: z
          .object({
            controls: z.array(
              z
                .object({
                  questions: z.array(z.object({ declaration: z.string() }).passthrough()),
                  caller_affirmed_count: z.number(),
                  unknown_count: z.number(),
                  answer_state: z.string(),
                })
                .passthrough(),
            ),
          })
          .passthrough(),
      })
      .passthrough()
      .parse(parseCatalogueJson(f.source.result_text, 4 * 1024 * 1024));
    for (const c of result.questionnaire_provenance.controls) {
      c.questions.forEach((q) => {
        q.declaration = 'caller_affirmed';
      });
      c.caller_affirmed_count = c.questions.length;
      c.unknown_count = 0;
      c.answer_state = c.questions.length ? 'caller_declared_unverified' : 'not_boolean_assessable';
    }
    f.source.result_text = JSON.stringify(result);
    f.source.result_sha256 = sha(f.source.result_text);
    const text = JSON.stringify(f.source);
    const envelope = encodeCoverageFirstSource('board', text, sha(text));
    const d = buildCoverageFirstReport({
      ...f.input,
      sourceText: envelope.text,
      sourceSha256: envelope.sha256,
    });
    expect(d.summary.humanYesUnverified).toBe(65);
    expect(d.summary.omittedUnknown).toBe(0);
    expect(d.metrics.state).toBe('withheld');
    expect(d.presentation_policy).toEqual(coverageFirstPolicy());
  });
});
