import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@axiom/ledger';
import { PUBLIC_COVERAGE_PAGES, publicCoverageClarificationSnapshotSchema } from '@axiom/types';
import { assetReportFixture } from './public-control-report-v4.test-helper';
import { publicReportFixture, ids } from './public-control-provenance.test-helper';
import { encodeCoverageFirstSource, coverageFirstHash as hash } from './coverage-first-source';
import { encodeBrandedSource, buildBrandedReport, renderBrandedDraft } from './branded-report';
import { encodeQuestionnaireEvidenceSource } from './questionnaire-evidence-report';
import {
  buildClarifiedReport,
  ClarifiedDocumentV8Schema,
  renderClarifiedDraft,
  renderReviewedClarifiedReport,
  verifyClarifiedSource,
} from './clarified-report';

/** Synthetic packets and ledger IDs only; no real owner, site or approval is created. */
function fixture(kind: 'board' | 'auditor' = 'board', svg = false) {
  const f = svg ? publicReportFixture(kind) : assetReportFixture(kind);
  if (svg) {
    const payload = JSON.parse(f.human.capture.payload_text);
    payload.pages[0].coverageReasons = ['unsupported_foreign_markup'];
    f.human.capture.payload_text = canonicalJson(payload);
    f.human.capture.payload_sha256 = hash(f.human.capture.payload_text);
    const request = JSON.parse(f.human.review.request_text);
    request.expectedSource.payloadSha256 = f.human.capture.payload_sha256;
    const snapshot = JSON.parse(f.human.review.snapshot_text);
    snapshot.request = request;
    f.human.review.request_text = canonicalJson(request);
    f.human.review.request_sha256 = hash(f.human.review.request_text);
    f.human.review.snapshot_text = canonicalJson(snapshot);
    f.human.review.snapshot_sha256 = hash(f.human.review.snapshot_text);
    f.input.sourceText = JSON.stringify(f.source);
    f.input.sourceSha256 = hash(f.input.sourceText);
  }
  const publicSource = encodeCoverageFirstSource(kind, f.input.sourceText, f.input.sourceSha256);
  const base = encodeBrandedSource(
    kind,
    publicSource.text,
    publicSource.sha256,
    'Synthetic Company',
  );
  const capture = JSON.parse(f.human.capture.payload_text);
  const snapshot = publicCoverageClarificationSnapshotSchema.parse({
    version: 1,
    disposition: 'owner_declarations_unverified',
    tenantId: f.input.tenantId,
    actorId: ids.actor,
    revisionId: '10000000-0000-4000-8000-000000000001',
    previousRevisionId: null,
    recordedAt: '2026-10-21T00:00:00Z',
    request: {
      version: 1,
      operationKey: '10000000-0000-4000-8000-000000000002',
      engagementId: f.input.engagementId,
      checkId: f.human.capture.check_id,
      payloadSha256: f.human.capture.payload_sha256,
      expectedPreviousRevisionId: null,
      clarifications: PUBLIC_COVERAGE_PAGES.map((page) => {
        const saved = capture.pages.find((item: { page: string }) => item.page === page);
        return {
          page,
          sourceState: saved?.state ?? 'unexamined',
          sourceTruncated: saved?.truncated ?? false,
          reasonCategory: 'needs_investigation',
          reason: `The owner requests a follow-up examination of ${page}; this is an unverified explanation.`,
          proposedPublicUrl: page === 'privacy' ? 'https://example.org/privacy' : null,
        };
      }),
    },
  });
  const source = (owner = snapshot) => {
    const snapshot_text = canonicalJson(owner);
    const value = {
      schema_version: 8,
      kind: 'clarified_report_source',
      serialization: 'axiom-clarified-report-source-json-1',
      report_kind: kind,
      retained_source: base,
      owner_clarification: {
        snapshot_text,
        snapshot_sha256: hash(snapshot_text),
        receipt_id: '31',
      },
    };
    const text = canonicalJson(value);
    return { text, sha256: hash(text) };
  };
  const outer = source();
  const input = { ...f.input, sourceText: outer.text, sourceSha256: outer.sha256 };
  return { f, base, snapshot, source, input };
}

function reviewed(input: ReturnType<typeof fixture>['input']) {
  const documentText = JSON.stringify(buildClarifiedReport(input));
  const review = {
    schema_version: 1,
    report_id: ids.report,
    content_sha256: hash(documentText),
    decision: 'approved',
    reviewer: { id: ids.actor, display_name: 'Human <reviewer>' },
    reviewed_at: '2026-10-21T01:00:00Z',
  };
  const { generatedAt: _generatedAt, ...scope } = input;
  function render(value: unknown = review) {
    const reviewText = JSON.stringify(value);
    return renderReviewedClarifiedReport({
      ...scope,
      reportId: ids.report,
      documentText,
      documentSha256: hash(documentText),
      reviewText,
      reviewSha256: hash(reviewText),
    });
  }
  return { documentText, review, render };
}

describe('clarified report source8/document8', () => {
  it.each(['board', 'auditor'] as const)(
    'keeps maximum-length %s owner explanations outside compact table columns without changing source/document bytes',
    (kind) => {
      const f = fixture(kind);
      const reason = 'UNBROKEN'.repeat(250);
      const owner = {
        ...f.snapshot,
        request: {
          ...f.snapshot.request,
          clarifications: f.snapshot.request.clarifications.map((item) => ({ ...item, reason })),
        },
      };
      const source = f.source(owner);
      const input = { ...f.input, sourceText: source.text, sourceSha256: source.sha256 };
      const documentText = JSON.stringify(buildClarifiedReport(input));
      const html = renderClarifiedDraft(input);
      const summary = html.match(/<table class="owner-coverage-summary">([\s\S]*?)<\/table>/)?.[1];
      expect(summary).toBeDefined();
      expect(summary).not.toContain(reason);
      expect(summary?.match(/<tr>/g)).toHaveLength(6);
      expect(html.match(/<section class="owner-coverage-note"/g)).toHaveLength(5);
      expect(html.match(/<p class="owner-coverage-reason">/g)).toHaveLength(5);
      expect(html).toContain(`<p class="owner-coverage-reason">${reason}</p>`);
      expect(html).toContain('.owner-coverage-note{width:100%');
      expect(html).toContain('orphans:3;widows:3;overflow-wrap:anywhere;word-break:normal');
      expect(html).toContain('Proposed follow-up address (not examined by this declaration)');
      expect(JSON.stringify(buildClarifiedReport(input))).toBe(documentText);
      expect(hash(input.sourceText)).toBe(input.sourceSha256);
      expect(html).toContain(hash(documentText));
    },
  );

  it.each(['board', 'auditor'] as const)(
    'preserves every underlying %s value and existing renderer bytes',
    (kind) => {
      const { input, base, snapshot } = fixture(kind);
      const baseInput = { ...input, sourceText: base.text, sourceSha256: base.sha256 };
      const oldHtml = renderBrandedDraft(baseInput);
      const document = buildClarifiedReport(input);
      const {
        branded_source_sha256,
        owner_coverage_clarification,
        owner_clarification_sha256,
        owner_clarification_receipt,
        ...rest
      } = document;
      expect({ ...rest, schema_version: 7, source_sha256: branded_source_sha256 }).toEqual(
        buildBrandedReport(baseInput),
      );
      expect(owner_coverage_clarification).toEqual(snapshot);
      expect(owner_clarification_sha256).toBe(hash(canonicalJson(snapshot)));
      expect(owner_clarification_receipt).toBe('31');
      expect(document.metrics).toEqual({
        state: 'withheld',
        compliance_conclusion: 'not_determined',
      });
      expect(renderBrandedDraft(baseInput)).toBe(oldHtml);
    },
  );

  it('explains SVG exclusions and missing historical contact/terms without changing examination states', () => {
    const { input } = fixture('board', true);
    const verified = verifyClarifiedSource(input.sourceText, input.sourceSha256, input);
    expect(verified.pages?.find((page) => page.page === 'root')).toMatchObject({
      state: 'examined',
      truncated: true,
    });
    expect(verified.pages?.find((page) => page.page === 'contact')).toMatchObject({
      state: 'unexamined',
      presentInCapture: false,
    });
    const html = renderClarifiedDraft(input);
    for (const text of [
      'SVG or other foreign markup was excluded from text extraction',
      'Contact and grievance channels',
      'Unexamined — this page kind is not present in the retained capture',
      'Owner declarations are unverified',
      'Proposed follow-up address (not examined by this declaration)',
      'audit receipt 31',
      'Document 8',
      'Axiom Minds Private Limited',
      'axiomminds.ai',
      'axiomproof.ai',
      'hello@axiomminds.ai',
      '+919757281284',
      'counter(page)',
      'counter(pages)',
      'data:font/ttf;base64',
    ])
      expect(html).toContain(text);
    expect(html).toContain(input.sourceSha256);
    expect(html).not.toMatch(/(?:src|href)=["']https?:|url\(["']?https?:|<script|<iframe/i);
  });

  it.each([
    'tenant',
    'engagement',
    'capture',
    'payload',
    'lineage',
    'missing_page',
    'wrong_state',
    'wrong_partial',
    'duplicate_page',
  ])('refuses %s even after recomputing owner and outer hashes', (change) => {
    const f = fixture();
    const owner = structuredClone(f.snapshot);
    if (change === 'tenant') owner.tenantId = ids.actor;
    if (change === 'engagement') owner.request.engagementId = ids.actor;
    if (change === 'capture') owner.request.checkId = ids.actor;
    if (change === 'payload') owner.request.payloadSha256 = 'f'.repeat(64);
    if (change === 'lineage') owner.previousRevisionId = ids.actor;
    if (change === 'missing_page')
      owner.request.clarifications = owner.request.clarifications.filter(
        (page) => page.page !== 'contact',
      );
    if (change === 'wrong_state') owner.request.clarifications[1]!.sourceState = 'examined';
    if (change === 'wrong_partial') owner.request.clarifications[0]!.sourceTruncated = false;
    if (change === 'duplicate_page') owner.request.clarifications[1]!.page = 'root';
    const outer = f.source(owner);
    expect(() => verifyClarifiedSource(outer.text, outer.sha256, f.input)).toThrow(
      'clarified_source_refused',
    );
  });

  it('refuses missing mandatory owner snapshots, wrong receipts, unknown fields and noncanonical outer bytes', () => {
    const f = fixture();
    const value = JSON.parse(f.input.sourceText);
    const mutations = [
      { ...value, owner_clarification: null },
      { ...value, owner_clarification: { ...value.owner_clarification, receipt_id: ids.actor } },
      {
        ...value,
        owner_clarification: { ...value.owner_clarification, snapshot_sha256: 'f'.repeat(64) },
      },
      { ...value, schema_version: 6 },
      { ...value, unexpected: true },
    ];
    for (const modified of mutations) {
      const text = canonicalJson(modified);
      expect(() => verifyClarifiedSource(text, hash(text), f.input)).toThrow();
    }
    const text = JSON.stringify(value, null, 2);
    expect(() => verifyClarifiedSource(text, hash(text), f.input)).toThrow();
  });

  it('renders only a real approval of the exact new document, never an older branded approval', () => {
    const f = fixture();
    const { render, review } = reviewed(f.input);
    const html = render();
    expect(html).toContain('Human &lt;reviewer&gt;');
    expect(html).toContain('Human-reviewed working report');
    expect(html).toContain('Human-reviewed evidence report');
    expect(html).not.toContain('Draft for human review');
    expect(html).toContain('Review is bound to this exact document 8');
    const oldDocument = buildBrandedReport({
      ...f.input,
      sourceText: f.base.text,
      sourceSha256: f.base.sha256,
    });
    expect(() => render({ ...review, content_sha256: hash(JSON.stringify(oldDocument)) })).toThrow(
      'clarified_review_refused',
    );
    expect(() => render({ ...review, decision: 'rejected' })).toThrow();
    expect(() => render({ ...review, report_id: ids.actor })).toThrow();
  });

  it('keeps a previously frozen request valid after a later owner revision exists', () => {
    const f = fixture();
    const oldDocument = buildClarifiedReport(f.input);
    const oldHtml = renderClarifiedDraft(f.input);
    const later = structuredClone(f.snapshot);
    later.revisionId = '10000000-0000-4000-8000-000000000003';
    later.previousRevisionId = f.snapshot.revisionId;
    later.request.expectedPreviousRevisionId = f.snapshot.revisionId;
    later.request.operationKey = '10000000-0000-4000-8000-000000000004';
    later.request.clarifications[1]!.reason =
      'A later owner explanation needs further examination and remains unverified.';
    const newSource = f.source(later);
    expect(
      buildClarifiedReport({
        ...f.input,
        sourceText: newSource.text,
        sourceSha256: newSource.sha256,
      }).owner_coverage_clarification?.revisionId,
    ).toBe(later.revisionId);
    expect(buildClarifiedReport(f.input)).toEqual(oldDocument);
    expect(renderClarifiedDraft(f.input)).toBe(oldHtml);
  });

  it.each(['board', 'auditor'] as const)(
    'supports questionnaire-only %s without implying website examination',
    (kind) => {
      const f = assetReportFixture(kind);
      const original = JSON.parse(f.input.sourceText);
      delete original.human_control_review;
      original.schema_version = 1;
      const raw = JSON.stringify(original);
      const questionnaire = encodeQuestionnaireEvidenceSource(kind, raw, hash(raw));
      const base = encodeBrandedSource(
        kind,
        questionnaire.text,
        questionnaire.sha256,
        'Synthetic Company',
      );
      const text = canonicalJson({
        schema_version: 8,
        kind: 'clarified_report_source',
        serialization: 'axiom-clarified-report-source-json-1',
        report_kind: kind,
        retained_source: base,
        owner_clarification: null,
      });
      const input = { ...f.input, sourceText: text, sourceSha256: hash(text) };
      const document = buildClarifiedReport(input);
      expect(document.underlying_document_version).toBe(6);
      expect(document.owner_coverage_clarification).toBeNull();
      expect(ClarifiedDocumentV8Schema.parse(document)).toEqual(document);
      expect(renderClarifiedDraft(input)).toContain('has no retained public-website capture');
    },
  );
});
