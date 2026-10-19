import { BRANDED_FONT_LICENSE_V1 } from './branded-font-license-v1';
/** Source6/document7. New requests only; legacy renderers are immutable. */
import { canonicalJson } from '@axiom/ledger';
import { z } from 'zod';
import { BRANDED_ASSETS_V1, BRANDED_ASSET_HASHES_V1 } from './branded-assets-v1';
import {
  coverageFirstHash as hash,
  parseCoverageFirstJson as parseJson,
  verifyCoverageFirstSource,
} from './coverage-first-source';
import {
  buildCoverageFirstReport,
  CoverageFirstDocumentV5Schema,
  renderCoverageFirstDocumentPresentation,
  type CoverageFirstBuildInput,
} from './coverage-first-report';
import {
  buildQuestionnaireEvidenceReport,
  QuestionnaireEvidenceDocumentV6Schema,
  renderQuestionnaireDocumentPresentation,
  verifyQuestionnaireEvidenceSource,
} from './questionnaire-evidence-report';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const limit = 4 * 1024 * 1024;
export const BRANDED_PRESENTATION_V1 = Object.freeze({
  revision: 'axiom-report-brand-1',
  product: 'Axiom Proof',
  company: 'Axiom Minds Private Limited',
  product_url: 'https://axiomproof.ai',
  company_url: 'https://axiomminds.ai',
  workbench_url: 'https://app.axiomproof.ai',
  email: 'hello@axiomminds.ai',
  telephone: '+919757281284',
  font: 'NotoSans-OFL-1.1',
  font_license_sha256: '0dab92d0544f7b233403f14b84a663bdbfa746982eda629e7f4f9ffe1b036feb',
  layout: 'board-A4-portrait-auditor-A4-landscape',
  assets: BRANDED_ASSET_HASHES_V1,
});
const presentation = z
  .unknown()
  .refine(
    (v) => canonicalJson(v) === canonicalJson(BRANDED_PRESENTATION_V1),
    'Unknown presentation revision',
  );
export const BrandedSourceV6Schema = z
  .object({
    schema_version: z.literal(6),
    kind: z.literal('branded_report_source'),
    serialization: z.literal('axiom-branded-report-source-json-1'),
    report_kind: z.enum(['board', 'auditor']),
    organization_name: z.string().min(1).max(300),
    presentation,
    retained_source: z.object({ text: z.string().min(1), sha256: digest }).strict(),
  })
  .strict();
const brandFields = {
  schema_version: z.literal(7),
  source_sha256: digest,
  organization_name: z.string().min(1).max(300),
  underlying_source_sha256: digest,
  presentation,
};
export const BrandedDocumentV7Schema = z.union([
  CoverageFirstDocumentV5Schema.omit({ schema_version: true, source_sha256: true })
    .extend({ ...brandFields, underlying_document_version: z.literal(5) })
    .strict(),
  QuestionnaireEvidenceDocumentV6Schema.omit({ schema_version: true, source_sha256: true })
    .extend({ ...brandFields, underlying_document_version: z.literal(6) })
    .strict(),
]);
export function encodeBrandedSource(
  kind: 'board' | 'auditor',
  sourceText: string,
  sourceSha256: string,
  organizationName: string,
) {
  const inner = parseJson(sourceText, limit) as { schema_version?: unknown; report_kind?: unknown };
  if (
    hash(sourceText) !== sourceSha256 ||
    ![4, 5].includes(Number(inner.schema_version)) ||
    inner.report_kind !== kind
  )
    throw Error('branded_source_refused');
  const text = canonicalJson(
    BrandedSourceV6Schema.parse({
      schema_version: 6,
      kind: 'branded_report_source',
      serialization: 'axiom-branded-report-source-json-1',
      report_kind: kind,
      organization_name: organizationName,
      presentation: BRANDED_PRESENTATION_V1,
      retained_source: { text: sourceText, sha256: sourceSha256 },
    }),
  );
  return { text, sha256: hash(text) };
}
export function verifyBrandedSource(
  sourceText: string,
  sourceSha256: string,
  scope: Pick<
    CoverageFirstBuildInput,
    'tenantId' | 'requestId' | 'engagementId' | 'assessmentRunId'
  >,
) {
  if (hash(sourceText) !== sourceSha256) throw Error('branded_source_refused');
  const envelope = BrandedSourceV6Schema.parse(parseJson(sourceText, limit));
  if (canonicalJson(envelope) !== sourceText) throw Error('branded_source_refused');
  const inner = envelope.retained_source;
  const version = (parseJson(inner.text, limit) as { schema_version?: unknown }).schema_version;
  if (version !== 4 && version !== 5) throw Error('branded_source_refused');
  const exactScope = {
    requestId: scope.requestId,
    tenantId: scope.tenantId,
    engagementId: scope.engagementId,
    assessmentRunId: scope.assessmentRunId,
  };
  const verified =
    version === 4
      ? verifyCoverageFirstSource(inner.text, inner.sha256, exactScope)
      : verifyQuestionnaireEvidenceSource(inner.text, inner.sha256, exactScope);
  if (
    (parseJson(inner.text, limit) as { report_kind?: unknown }).report_kind !== envelope.report_kind
  )
    throw Error('branded_source_refused');
  return { ...verified, envelope, inner, version };
}
export function buildBrandedReport(input: CoverageFirstBuildInput) {
  const { inner, version, envelope } = verifyBrandedSource(
    input.sourceText,
    input.sourceSha256,
    input,
  );
  const underlying = (version === 4 ? buildCoverageFirstReport : buildQuestionnaireEvidenceReport)({
    ...input,
    sourceText: inner.text,
    sourceSha256: inner.sha256,
  });
  return BrandedDocumentV7Schema.parse({
    ...underlying,
    schema_version: 7,
    source_sha256: input.sourceSha256,
    organization_name: envelope.organization_name,
    underlying_source_sha256: inner.sha256,
    underlying_document_version: underlying.schema_version,
    presentation: BRANDED_PRESENTATION_V1,
  });
}
const esc = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
// Exact monochrome official AxiomMark geometry. Decorative branding is not an attestation.

function chrome(
  input: CoverageFirstBuildInput,
  review?: { name: string; actor: string; at: string; hash: string; contentHash: string },
) {
  const { inner, version, envelope } = verifyBrandedSource(
    input.sourceText,
    input.sourceSha256,
    input,
  );
  const underlying = (version === 4 ? buildCoverageFirstReport : buildQuestionnaireEvidenceReport)({
    ...input,
    sourceText: inner.text,
    sourceSha256: inner.sha256,
  });
  const legacy = (
    version === 4
      ? renderCoverageFirstDocumentPresentation
      : renderQuestionnaireDocumentPresentation
  )(
    underlying,
    review ? { displayName: review.name, actorId: review.actor, reviewedAt: review.at } : undefined,
  );
  const body = legacy.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1];
  const oldStyles = [...legacy.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((m) => m[1])
    .join('\n');
  if (!body) throw Error('branded_renderer_refused');
  const logo = `<img width="34" height="34" alt="Axiom Proof" src="data:image/svg+xml;base64,${BRANDED_ASSETS_V1.productLogo}"/>`;
  const company = `<img width="38" height="38" alt="Axiom Minds" src="data:image/png;base64,${BRANDED_ASSETS_V1.companyLogo}"/>`;
  // Native page margin boxes avoid Chromium fragmenting negative fixed offsets.
  const productUri = `data:image/svg+xml;base64,${BRANDED_ASSETS_V1.productLogo}`;
  const companyUri =
    'data:image/svg+xml;base64,' +
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="30" height="30"><image width="30" height="30" xlink:href="data:image/png;base64,${BRANDED_ASSETS_V1.companyLogo}"/></svg>`,
    ).toString('base64');
  const title = esc(input.title);
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><!-- ${esc(BRANDED_FONT_LICENSE_V1)} --><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} | Axiom Proof</title><meta name="author" content="Axiom Minds Private Limited"><meta name="description" content="Source-bound assessment report. Human declarations and evidence limitations are retained."><style>${oldStyles}
@font-face{font-family:AxiomReport;src:url(data:font/ttf;base64,${BRANDED_ASSETS_V1.regularFont}) format('truetype');font-weight:400}
@font-face{font-family:AxiomReport;src:url(data:font/ttf;base64,${BRANDED_ASSETS_V1.boldFont}) format('truetype');font-weight:700}
@page{size:${envelope.report_kind === 'auditor' ? 'A4 landscape' : 'A4 portrait'};margin:28mm 15mm 28mm;@bottom-right{content:"Page " counter(page) " of " counter(pages);font:8pt AxiomReport;color:#2F3542;vertical-align:bottom;padding-bottom:3mm}}
*{box-sizing:border-box}html,body{margin:0;padding:0;background:white;color:#2F3542;font-family:AxiomReport,sans-serif;font-size:10pt;line-height:1.55}body{max-width:none}h1,h2,h3{color:#1E2A4A;break-after:avoid}h1{font-size:24pt}h2{font-size:15pt;border-bottom:2px solid #0FB5A5;padding-bottom:5px}p,li,td,th,code{overflow-wrap:anywhere}table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:8pt}thead{display:table-header-group}tr{break-inside:avoid}th{background:#F4F6F8;color:#1E2A4A}td,th{padding:7px;border:1px solid #d9dee5;vertical-align:top}a{color:#1E2A4A}code{white-space:normal}.brand-header,.brand-footer{display:flex;align-items:center;justify-content:space-between;gap:12px}.brand-header{border-bottom:2px solid #0FB5A5;padding:12px 0}.brand-header .lockup{display:flex;gap:10px;align-items:center}.brand-header strong{font-size:15pt;letter-spacing:1px}.brand-header small,.brand-footer small{display:block;font-size:8pt}.brand-footer{border-top:1px solid #d9dee5;padding:8px 0;font-size:8pt}.brand-company{display:flex;align-items:center;gap:8px}.brand-cover{background:#F4F6F8;padding:20px;margin:20px 0;border-left:4px solid #0FB5A5}.brand-facts{font-size:8pt}.brand-review{border:1px solid #d9dee5;padding:12px;break-inside:avoid}.brand-main{max-width:1100px;margin:auto;padding:0 20px}.brand-state{font-weight:700;color:#1E2A4A}.brand-footer a{white-space:nowrap}
@media print{.brand-main{max-width:none;padding:0}.brand-header,.brand-footer{display:none}.brand-cover{margin-top:0}a{text-decoration:none}}
@media(max-width:600px){.brand-header,.brand-footer{align-items:flex-start;flex-direction:column}.brand-main{padding:0 12px}.brand-cover{padding:12px}h1{font-size:20pt}table{font-size:8pt}td,th{padding:4px}}
@page{@top-left{content:url("${productUri}") " AXIOM PROOF\\A by Axiom Minds";white-space:pre;font:700 10pt AxiomReport;vertical-align:middle;color:#1E2A4A}@top-right{content:"Platform: axiomproof.ai\\A Workbench: app.axiomproof.ai";white-space:pre;font:8pt AxiomReport;color:#2F3542;vertical-align:middle}@bottom-left{content:url("${companyUri}") " Axiom Minds Private Limited\\A Company: axiomminds.ai";white-space:pre;font:7pt AxiomReport;color:#2F3542;vertical-align:middle}@bottom-center{content:"hello@axiomminds.ai\\A +919757281284";white-space:pre;font:7pt AxiomReport;color:#2F3542;vertical-align:middle}}
</style></head><body><main class="brand-main"><header class="brand-header"><div class="lockup">${logo}<div><strong>AXIOM PROOF</strong><small>by Axiom Minds</small></div></div><div><small>Platform: axiomproof.ai</small><small>Workbench: app.axiomproof.ai</small></div></header><section class="brand-cover"><p class="brand-state">${review ? 'Human-reviewed working report — artifact retention and release are separate' : 'Draft — human review pending; not released'}</p><h1>${title}</h1><p>Organization: ${esc(envelope.organization_name)}<br>Organization reference: ${esc(input.tenantId)}</p><p>Assessment: ${esc(input.assessmentRunId)} · Document date: ${esc(input.generatedAt)}</p><p class="brand-facts">Request ${esc(input.requestId)}<br>Source SHA-256 ${esc(input.sourceSha256)}<br>Document JSON SHA-256 ${esc(review?.contentHash ?? hash(JSON.stringify(buildBrandedReport(input))))}<br>Prepared by: Axiom Proof deterministic report renderer. Assessment source: Parikshan (original run receipts).<br>Template axiom-report-brand-1 · Document 7</p></section>${body}<section class="brand-review"><h2>Review and custody</h2>${review ? `<p>Reviewed by ${esc(review.name)} (${esc(review.actor)}) at ${esc(review.at)}.</p><p class="brand-facts">Review SHA-256: ${esc(review.hash)}</p>` : '<p>No human approval has been recorded in this draft.</p>'}<p>Branding does not attest compliance, evidence retention or release. Read the source limitations and the actual retained artifact record.</p></section><footer class="brand-footer"><div class="brand-company">${company}<div><strong>Axiom Minds Private Limited</strong><small>Company: axiomminds.ai</small></div></div><div><small>hello@axiomminds.ai · +919757281284</small><small>Axiom Proof · axiomproof.ai</small></div></footer></main></body></html>`;
}
export function renderBrandedDraft(input: CoverageFirstBuildInput) {
  buildBrandedReport(input);
  return chrome(input);
}
type ReviewedInput = Omit<CoverageFirstBuildInput, 'generatedAt'> & {
  reportId: string;
  documentText: string;
  documentSha256: string;
  reviewText: string;
  reviewSha256: string;
};
export function renderReviewedBrandedReport(input: ReviewedInput) {
  if (
    hash(input.documentText) !== input.documentSha256 ||
    hash(input.reviewText) !== input.reviewSha256
  )
    throw Error('branded_review_refused');
  const document = BrandedDocumentV7Schema.parse(parseJson(input.documentText, limit));
  const buildInput = {
    sourceText: input.sourceText,
    sourceSha256: input.sourceSha256,
    requestId: input.requestId,
    tenantId: input.tenantId,
    engagementId: input.engagementId,
    assessmentRunId: input.assessmentRunId,
    title: input.title,
    generatedAt: document.generated_at,
  };
  if (canonicalJson(document) !== canonicalJson(buildBrandedReport(buildInput)))
    throw Error('branded_review_refused');
  const review = z
    .object({
      schema_version: z.literal(1),
      report_id: z.uuid(),
      content_sha256: digest,
      decision: z.literal('approved'),
      reviewer: z.object({ id: z.uuid(), display_name: z.string().min(1).max(200) }).strict(),
      reviewed_at: z.iso.datetime({ offset: true }),
    })
    .strict()
    .parse(parseJson(input.reviewText, 262144));
  if (review.report_id !== input.reportId || review.content_sha256 !== input.documentSha256)
    throw Error('branded_review_refused');
  return chrome(buildInput, {
    name: review.reviewer.display_name,
    actor: review.reviewer.id,
    at: review.reviewed_at,
    hash: input.reviewSha256,
    contentHash: input.documentSha256,
  });
}
