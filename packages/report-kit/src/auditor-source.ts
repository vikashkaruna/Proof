/** A deterministic assessment-derived auditor review pack. No audit attestation is inferred. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BRANDING } from './schema';

const uuid = z.uuid();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const finding = z
  .object({
    control_id: z.string().min(1).max(100),
    score: z.number().finite().min(0).max(100),
    risk_points: z.number().finite().nonnegative(),
    rationale: z.string().min(1).max(2000),
  })
  .strict();
const control = z.object({
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(300),
  domain: z.string().min(1).max(100),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
});
const sourceSchema = z.object({
  schema_version: z.literal(1),
  serialization: z.literal('postgres-jsonb-text-v1'),
  kind: z.literal('statutory_source'),
  report_kind: z.literal('auditor'),
  request_id: uuid,
  tenant_id: uuid,
  engagement_id: uuid,
  assessment_run_id: uuid,
  library_version: z.string().min(1).max(100),
  controls_text: z.string().min(1),
  controls_sha256: digest,
  result_text: z.string().min(1),
  result_sha256: digest,
  finalized_at: z.string().datetime({ offset: true }),
  receipts: z.object({
    finalized: z.object({ id: z.string().regex(/^[1-9][0-9]*$/), entry_hash: digest }),
  }),
});

export const AuditorAssessmentPackV2Schema = z
  .object({
    schema_version: z.literal(2),
    kind: z.literal('auditor_pack'),
    source_kind: z.literal('finalized_assessment'),
    request_id: uuid,
    tenant_id: uuid,
    engagement_id: uuid,
    assessment_run_id: uuid,
    source_sha256: digest,
    assessment_result_digest: digest,
    library_digest: digest,
    library_version: z.string().min(1).max(100),
    title: z.string().min(1).max(300),
    generated_by: z.literal('statutory-report-builder'),
    generated_at: z.string().datetime({ offset: true }),
    posture_score: z.number().finite().min(0).max(100),
    finalized_at: z.string().datetime({ offset: true }),
    finalized_ledger_receipt: z.string().regex(/^[1-9][0-9]*$/),
    findings: z.array(finding).min(1).max(500),
    controls: z.array(control.strict()).min(1).max(500),
    limitations: z.literal(
      'Assessment-derived findings only. No independent audit, evidence verification, or auditor attestation is represented.',
    ),
  })
  .strict();
export type AuditorAssessmentPackV2 = z.infer<typeof AuditorAssessmentPackV2Schema>;

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const escape = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function parseText(text: string, maxBytes: number): unknown {
  if (!text || Buffer.byteLength(text, 'utf8') > maxBytes)
    throw new Error('Auditor source is missing or unbounded');
  return JSON.parse(text) as unknown;
}

export function buildAuditorAssessmentPack(input: {
  sourceText: string;
  sourceSha256: string;
  requestId: string;
  tenantId: string;
  engagementId: string;
  assessmentRunId: string;
  title: string;
  generatedAt: string;
}): AuditorAssessmentPackV2 {
  if (sha(input.sourceText) !== input.sourceSha256)
    throw new Error('Auditor source digest mismatch');
  const source = sourceSchema.parse(parseText(input.sourceText, 4 * 1024 * 1024));
  if (
    source.request_id !== input.requestId ||
    source.tenant_id !== input.tenantId ||
    source.engagement_id !== input.engagementId ||
    source.assessment_run_id !== input.assessmentRunId
  )
    throw new Error('Auditor source identity mismatch');
  if (
    sha(source.controls_text) !== source.controls_sha256 ||
    sha(source.result_text) !== source.result_sha256
  )
    throw new Error('Auditor packet digest mismatch');
  const controls = z
    .array(control)
    .min(1)
    .max(500)
    .parse(parseText(source.controls_text, 2 * 1024 * 1024));
  const result = z
    .object({
      library_version: z.string().min(1),
      posture_score: z.number().finite().min(0).max(100),
      findings: z.array(finding).min(1).max(500),
    })
    .parse(parseText(source.result_text, 2 * 1024 * 1024));
  if (
    result.library_version !== source.library_version ||
    result.findings.length !== controls.length
  )
    throw new Error('Auditor assessment mismatch');
  const controlsById = new Map(controls.map((item) => [item.id, item]));
  const findingIds = new Set(result.findings.map((item) => item.control_id));
  if (
    controlsById.size !== controls.length ||
    findingIds.size !== controls.length ||
    [...findingIds].some((id) => !controlsById.has(id))
  )
    throw new Error('Auditor assessment is incomplete');
  return AuditorAssessmentPackV2Schema.parse({
    schema_version: 2,
    kind: 'auditor_pack',
    source_kind: 'finalized_assessment',
    request_id: input.requestId,
    tenant_id: input.tenantId,
    engagement_id: input.engagementId,
    assessment_run_id: input.assessmentRunId,
    source_sha256: input.sourceSha256,
    assessment_result_digest: source.result_sha256,
    library_digest: source.controls_sha256,
    library_version: source.library_version,
    title: input.title,
    generated_by: 'statutory-report-builder',
    generated_at: input.generatedAt,
    posture_score: result.posture_score,
    finalized_at: source.finalized_at,
    finalized_ledger_receipt: source.receipts.finalized.id,
    findings: result.findings,
    controls,
    limitations:
      'Assessment-derived findings only. No independent audit, evidence verification, or auditor attestation is represented.',
  });
}

export function renderAuditorAssessmentPackHtml(
  raw: AuditorAssessmentPackV2,
  approval?: { reviewer: string; reviewedAt: string; reviewSha256: string },
): string {
  const pack = AuditorAssessmentPackV2Schema.parse(raw);
  const controls = new Map(pack.controls.map((item) => [item.id, item]));
  const rows = pack.findings
    .map((item) => {
      const controlRow = controls.get(item.control_id);
      if (!controlRow) throw new Error('Auditor control missing');
      return `<tr><td>${escape(item.control_id)}</td><td>${escape(controlRow.title)}</td><td>${escape(controlRow.domain)}</td><td>${escape(controlRow.severity)}</td><td>${item.score}</td><td>${escape(item.rationale)}</td></tr>`;
    })
    .join('');
  const approvalHtml = approval
    ? `<section aria-label="Founder review"><h2>Founder review</h2><p>Approved by ${escape(approval.reviewer)} at ${escape(approval.reviewedAt)}. Review SHA-256: ${escape(approval.reviewSha256)}.</p><p>This approval releases the assessment-derived pack; it does not constitute an auditor attestation.</p></section>`
    : '<p>Private draft. Founder review and retained source/PDF versions are required before release.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Assessment-derived auditor review pack</title><style>@page{size:A4;margin:16mm}body{font:12px/1.5 Arial,sans-serif;color:#1e2a4a}header{border-bottom:3px solid #0fb5a5;padding-bottom:12px}h1{font-size:22px}aside{background:#f1f5f9;border-left:4px solid #d9534f;padding:12px;margin:18px 0}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{border:1px solid #cbd5e1;padding:7px;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#e9eef4}footer{margin-top:20px;font-size:10px;color:#475569}</style></head><body><header><h1>Assessment-derived auditor review pack</h1><div>Internal request reference: ${escape(pack.title)}</div><div>${BRANDING.product} · ${BRANDING.company} · ${BRANDING.company_url}</div><div>Deterministic statutory report builder</div></header><aside>${escape(pack.limitations)}</aside><p>Recorded posture score: <strong>${pack.posture_score}%</strong>. Finalized assessment: ${escape(pack.finalized_at)}. This score is an assessment result, not an independent compliance certification.</p><table><thead><tr><th>Control</th><th>Title</th><th>Domain</th><th>Severity</th><th>Score</th><th>Recorded rationale</th></tr></thead><tbody>${rows}</tbody></table>${approvalHtml}<footer>Run ${escape(pack.assessment_run_id)} · Source SHA-256 ${escape(pack.source_sha256)} · Result SHA-256 ${escape(pack.assessment_result_digest)} · Library SHA-256 ${escape(pack.library_digest)} · Ledger receipt ${escape(pack.finalized_ledger_receipt)}. Exact retained artifact versions are separate release records.</footer></body></html>`;
}

/** Re-derive every data claim from the frozen source before preparing a reviewed PDF. */
export function renderReviewedAuditorHtml(input: {
  sourceText: string;
  sourceSha256: string;
  documentText: string;
  documentSha256: string;
  reviewText: string;
  reviewSha256: string;
  reportId: string;
  requestId: string;
  tenantId: string;
  engagementId: string;
  assessmentRunId: string;
  title: string;
}): string {
  if (
    sha(input.documentText) !== input.documentSha256 ||
    sha(input.reviewText) !== input.reviewSha256
  )
    throw new Error('Auditor document or review digest mismatch');
  const document = AuditorAssessmentPackV2Schema.parse(
    parseText(input.documentText, 5 * 1024 * 1024),
  );
  const expected = buildAuditorAssessmentPack({
    sourceText: input.sourceText,
    sourceSha256: input.sourceSha256,
    requestId: input.requestId,
    tenantId: input.tenantId,
    engagementId: input.engagementId,
    assessmentRunId: input.assessmentRunId,
    title: input.title,
    generatedAt: document.generated_at,
  });
  if (JSON.stringify(document) !== JSON.stringify(expected))
    throw new Error('Auditor document differs from frozen source');
  const review = z
    .object({
      schema_version: z.literal(1),
      report_id: uuid,
      content_sha256: digest,
      decision: z.literal('approved'),
      reviewer: z.object({ id: uuid, display_name: z.string().min(1).max(200) }),
      reviewed_at: z.string().datetime({ offset: true }),
    })
    .parse(parseText(input.reviewText, 256 * 1024));
  if (review.report_id !== input.reportId || review.content_sha256 !== input.documentSha256)
    throw new Error('Auditor review differs from draft');
  return renderAuditorAssessmentPackHtml(document, {
    reviewer: review.reviewer.display_name,
    reviewedAt: review.reviewed_at,
    reviewSha256: input.reviewSha256,
  });
}
