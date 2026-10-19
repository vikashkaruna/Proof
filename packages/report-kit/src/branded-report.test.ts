import { encodeQuestionnaireEvidenceSource } from './questionnaire-evidence-report';
import { buildPramaanBoardArchive, buildPramaanAuditorArchive } from './pramaan-archive';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@axiom/ledger';
import { createHash } from 'node:crypto';
import { assetReportFixture } from './public-control-report-v4.test-helper';
import { encodeCoverageFirstSource, coverageFirstHash as hash } from './coverage-first-source';
import { buildCoverageFirstReport, renderCoverageFirstDraft } from './coverage-first-report';
import { BRANDED_ASSETS_V1, BRANDED_ASSET_HASHES_V1 } from './branded-assets-v1';
import {
  BRANDED_PRESENTATION_V1,
  encodeBrandedSource,
  buildBrandedReport,
  renderBrandedDraft,
  renderReviewedBrandedReport,
  verifyBrandedSource,
} from './branded-report';

function fixture(kind: 'board' | 'auditor' = 'board') {
  const f = assetReportFixture(kind);
  const legacy = encodeCoverageFirstSource(kind, f.input.sourceText, f.input.sourceSha256);
  const wrapped = encodeBrandedSource(kind, legacy.text, legacy.sha256, 'Synthetic Company');
  return { legacy, input: { ...f.input, sourceText: wrapped.text, sourceSha256: wrapped.sha256 } };
}
describe('immutable branded report source6/document7', () => {
  it.each(['board', 'auditor'] as const)(
    'preserves the entire %s substantive document and legacy HTML',
    (kind) => {
      const { legacy, input } = fixture(kind);
      const oldInput = { ...input, sourceText: legacy.text, sourceSha256: legacy.sha256 };
      const old = buildCoverageFirstReport(oldInput),
        oldHtml = renderCoverageFirstDraft(oldInput);
      const doc = buildBrandedReport(input);
      const {
        presentation,
        organization_name: _organizationName,
        underlying_source_sha256,
        underlying_document_version,
        ...body
      } = doc;
      expect({
        ...body,
        schema_version: underlying_document_version,
        source_sha256: underlying_source_sha256,
      }).toEqual(old);
      expect(presentation).toEqual(BRANDED_PRESENTATION_V1);
      expect(renderCoverageFirstDraft(oldInput)).toBe(oldHtml);
      expect(doc.metrics).toEqual({ state: 'withheld', compliance_conclusion: 'not_determined' });
    },
  );
  it.each(['board', 'auditor'] as const)(
    'brands questionnaire-only %s without inferring business answers',
    (kind) => {
      const f = assetReportFixture(kind);
      const original = JSON.parse(f.input.sourceText) as Record<string, unknown>;
      delete original.human_control_review;
      original.schema_version = 1;
      const text = JSON.stringify(original);
      const inner = encodeQuestionnaireEvidenceSource(kind, text, hash(text));
      const wrapped = encodeBrandedSource(kind, inner.text, inner.sha256, 'Synthetic Company');
      const input = { ...f.input, sourceText: wrapped.text, sourceSha256: wrapped.sha256 };
      const document = buildBrandedReport(input);
      expect(document.underlying_document_version).toBe(6);
      expect(document.metrics).toEqual({
        state: 'withheld',
        compliance_conclusion: 'not_determined',
      });
      expect(renderBrandedDraft(input)).toContain(
        'Scores, score bands and financial exposure estimates are withheld',
      );
    },
  );
  it.each(['board', 'auditor'] as const)(
    'archives exact outer %s source bytes without rewriting its presentation commitment',
    (kind) => {
      const { input } = fixture(kind);
      const sourceBytes = Buffer.from(input.sourceText);
      // Existing synthetic PDF bytes; this tests archive binding, not renderer/provider success.
      const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(600, 32)]);
      const result = (kind === 'board' ? buildPramaanBoardArchive : buildPramaanAuditorArchive)({
        tenantId: input.tenantId,
        engagementId: input.engagementId,
        requestId: input.requestId,
        reportId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        title: input.title,
        source: {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          versionId: 'synthetic-source-v1',
          sha256: input.sourceSha256,
        },
        pdf: {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          versionId: 'synthetic-pdf-v1',
          sha256: createHash('sha256').update(pdfBytes).digest('hex'),
        },
        sourceBytes,
        pdfBytes,
      });
      const archive = unzipSync(result.archive);
      expect(Buffer.from(archive['source/assessment.json']!).equals(sourceBytes)).toBe(true);
    },
  );
  it('pins actual embedded asset bytes including official product geometry', () => {
    for (const k of Object.keys(BRANDED_ASSETS_V1) as (keyof typeof BRANDED_ASSETS_V1)[]) {
      expect(
        createHash('sha256').update(Buffer.from(BRANDED_ASSETS_V1[k], 'base64')).digest('hex'),
      ).toBe(BRANDED_ASSET_HASHES_V1[k]);
    }
  });
  it('embeds logos/fonts and complete company/platform contacts without external assets or invented authority', () => {
    const { input } = fixture();
    const html = renderBrandedDraft(input);
    for (const value of [
      'Axiom Minds Private Limited',
      'AXIOM PROOF',
      'axiomminds.ai',
      'axiomproof.ai',
      'app.axiomproof.ai',
      'hello@axiomminds.ai',
      '+919757281284',
      'counter(page)',
      'counter(pages)',
      'data:image/png;base64',
      'data:font/ttf;base64',
      'SIL OPEN FONT LICENSE Version 1.1',
      'Copyright 2018 The Noto Project Authors',
    ])
      expect(html).toContain(value);
    expect(html).not.toMatch(/(?:src|href)=["']https?:|url\(["']?https?:|<script|<iframe|<canvas/i);
    expect(html).toContain('human review pending');
    expect(/\bQR\b/.test(html.replace(/base64,[A-Za-z0-9+/=]+/g, ''))).toBe(false);
    expect(Buffer.byteLength(html)).toBeLessThan(5 * 1024 * 1024);
  });
  it.each(['presentation', 'retained_source', 'report_kind', 'schema_version'])(
    'refuses tampered %s even with a recomputed outer hash',
    (key) => {
      const { input } = fixture();
      const source = JSON.parse(input.sourceText) as Record<string, unknown>;
      source[key] = key === 'report_kind' ? 'auditor' : key === 'schema_version' ? 5 : {};
      const text = canonicalJson(source);
      expect(() => verifyBrandedSource(text, hash(text), input)).toThrow();
    },
  );
  it('refuses duplicate keys, noncanonical encoding, unknown fields and foreign scope', () => {
    const { input } = fixture();
    for (const text of [
      input.sourceText.replace('{', '{"schema_version":6,'),
      JSON.stringify(JSON.parse(input.sourceText), null, 2),
      canonicalJson({ ...JSON.parse(input.sourceText), unknown: true }),
    ])
      expect(() => verifyBrandedSource(text, hash(text), input)).toThrow();
    expect(() => buildBrandedReport({ ...input, tenantId: input.engagementId })).toThrow();
  });
  it('binds actual approved review to the new document, never the old inner document or foreign report', () => {
    const { input } = fixture();
    const documentText = JSON.stringify(buildBrandedReport(input));
    const reportId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const review = {
      schema_version: 1,
      report_id: reportId,
      content_sha256: hash(documentText),
      decision: 'approved',
      reviewer: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', display_name: 'Human <reviewer>' },
      reviewed_at: '2026-10-19T00:00:00.000Z',
    };
    const { generatedAt: _generatedAt, ...scope } = input;
    const render = (v: unknown) => {
      const reviewText = JSON.stringify(v);
      return renderReviewedBrandedReport({
        ...scope,
        reportId,
        documentText,
        documentSha256: hash(documentText),
        reviewText,
        reviewSha256: hash(reviewText),
      });
    };
    const html = render(review);
    expect(html).toContain('Human &lt;reviewer&gt;');
    expect(html).toContain('Human-reviewed working report');
    expect(html).not.toContain('Draft for human review');
    expect(() => render({ ...review, content_sha256: 'f'.repeat(64) })).toThrow();
    expect(() => render({ ...review, decision: 'rejected' })).toThrow();
    expect(() => render({ ...review, report_id: review.reviewer.id })).toThrow();
  });
});
