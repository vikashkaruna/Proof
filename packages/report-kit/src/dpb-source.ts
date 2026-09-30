/** A DPB notification review pack derived only from a frozen recorded breach.
 * It is not a filed statutory form or proof that the Board received a notice. */
import { createHash } from 'node:crypto';
import { z } from 'zod';

const uuid = z.uuid();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const timestamp = z.string().datetime({ offset: true });
const maybeTimestamp = timestamp.nullable();
const sourceSchema = z
  .object({
    schema_version: z.literal(1),
    serialization: z.literal('postgres-jsonb-text-v1'),
    kind: z.literal('dpb_breach_source'),
    request_id: uuid,
    tenant_id: uuid,
    captured_at: timestamp,
    breach: z
      .object({
        id: uuid,
        title: z.string().min(1).max(2000),
        description: z.string().min(1).max(20000),
        severity: z.string().min(1).max(100),
        status: z.string().min(1).max(100),
        occurred_at: maybeTimestamp,
        detected_at: timestamp,
        dpb_notification_due_by: timestamp,
        affected_count: z.number().int().nonnegative().nullable(),
        data_categories: z.array(z.string().max(500)).max(100),
        dpb_notified_at: maybeTimestamp,
        dpb_reference: z.string().max(500).nullable(),
        principals_notified_at: maybeTimestamp,
      })
      .strict(),
    notification: z
      .object({
        id: uuid,
        kind: z.literal('dpb'),
        status: z.enum(['reviewed', 'sent']),
        language: z.enum(['en', 'hi']),
        subject: z.string().min(1).max(300),
        body: z.string().min(1).max(20000),
        created_by: uuid,
        created_at: timestamp,
        reviewed_by: uuid,
        reviewed_at: timestamp,
        sent_by: uuid.nullable(),
        sent_at: maybeTimestamp,
        delivery_outcome: z.enum(['delivered', 'failed', 'deferred']).nullable(),
        delivery_attempts: z.number().int().min(0).max(5),
      })
      .strict(),
    limitations: z.tuple([z.string(), z.string(), z.string()]),
  })
  .strict();

export const DpbReviewContentV2Schema = z
  .object({
    schema_version: z.literal(2),
    kind: z.literal('dpb_notification_review_pack'),
    request_id: uuid,
    tenant_id: uuid,
    source_sha256: digest,
    title: z.string().min(1).max(300),
    generated_by: z.literal('dpb-report-builder'),
  })
  .strict();

const reviewSchema = z
  .object({
    schema_version: z.literal(1),
    report_id: uuid,
    content_sha256: digest,
    decision: z.literal('approved'),
    reviewer: z.object({ id: uuid, display_name: z.string().min(1).max(200) }).strict(),
    reviewed_at: timestamp,
  })
  .strict();

export interface ReviewedDpbInput {
  sourceText: string;
  sourceSha256: string;
  documentText: string;
  documentSha256: string;
  reviewText: string;
  reviewSha256: string;
  reportId: string;
  requestId: string;
  tenantId: string;
  title: string;
}

const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
function bounded(text: string, limit: number): unknown {
  if (!text || Buffer.byteLength(text, 'utf8') > limit) throw new Error('DPB source is unbounded');
  return JSON.parse(text) as unknown;
}
function same(actual: unknown, expected: unknown) {
  if (actual !== expected) throw new Error('DPB review pack differs from frozen source');
}
function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
function value(v: string | number | null) {
  return v === null ? 'Not recorded' : escape(String(v));
}

export function buildDpbReviewContent(input: {
  sourceText: string;
  sourceSha256: string;
  requestId: string;
  tenantId: string;
  title: string;
}) {
  if (hash(input.sourceText) !== input.sourceSha256) throw new Error('DPB source hash mismatch');
  const source = sourceSchema.parse(bounded(input.sourceText, 4 * 1024 * 1024));
  same(source.request_id, input.requestId);
  same(source.tenant_id, input.tenantId);
  return DpbReviewContentV2Schema.parse({
    schema_version: 2,
    kind: 'dpb_notification_review_pack',
    request_id: input.requestId,
    tenant_id: input.tenantId,
    source_sha256: input.sourceSha256,
    title: input.title,
    generated_by: 'dpb-report-builder',
  });
}

/** Re-derives all displayed facts from the frozen source and embeds the actual founder review. */
export function renderReviewedDpbHtml(input: ReviewedDpbInput): string {
  if (
    hash(input.sourceText) !== input.sourceSha256 ||
    hash(input.documentText) !== input.documentSha256 ||
    hash(input.reviewText) !== input.reviewSha256
  )
    throw new Error('DPB source or review hash mismatch');
  const source = sourceSchema.parse(bounded(input.sourceText, 4 * 1024 * 1024));
  const content = DpbReviewContentV2Schema.parse(bounded(input.documentText, 65536));
  const review = reviewSchema.parse(bounded(input.reviewText, 256 * 1024));
  same(source.request_id, input.requestId);
  same(source.tenant_id, input.tenantId);
  same(content.request_id, input.requestId);
  same(content.tenant_id, input.tenantId);
  same(content.source_sha256, input.sourceSha256);
  same(content.title, input.title);
  same(review.report_id, input.reportId);
  same(review.content_sha256, input.documentSha256);
  if (
    source.notification.status === 'sent' &&
    (source.notification.delivery_outcome !== 'delivered' ||
      !source.notification.sent_at ||
      !source.notification.sent_by)
  )
    throw new Error('DPB recorded send is inconsistent');
  if (source.notification.reviewed_by === source.notification.created_by)
    throw new Error('DPB notification lacks independent review');
  const b = source.breach;
  const n = source.notification;
  const reviewLine = `${escape(review.reviewer.display_name)} · ${escape(review.reviewed_at)}`;
  const delivery =
    n.status === 'sent'
      ? `Operator recorded delivery on ${escape(n.sent_at!)}; no regulator receipt verified.`
      : 'Reviewed notification; no delivery recorded in this snapshot.';
  return `<!doctype html><html lang="${n.language}"><head><meta charset="utf-8"><title>Recorded DPB notification review pack</title>
<style>body{font:14px/1.55 Arial,sans-serif;color:#1e2a4a;max-width:760px;margin:36px auto;padding:0 22px}
h1{font-size:25px}h2{font-size:17px;border-bottom:1px solid #d9e2e9;padding-bottom:5px;margin-top:27px}
dl{display:grid;grid-template-columns:200px 1fr;gap:8px 14px}dt{font-weight:700}dd{margin:0;overflow-wrap:anywhere}
.notice{background:#edf7f6;border-left:4px solid #0fb5a5;padding:12px 16px}.body{white-space:pre-wrap;overflow-wrap:anywhere}
.small{font-size:12px;color:#526174}footer{border-top:1px solid #d9e2e9;margin-top:34px;padding-top:12px}</style></head><body>
<h1>Recorded DPB notification review pack</h1><p class="notice"><strong>Recorded breach notification review pack.</strong> This is not a filed DPB form, regulator acceptance, forensic verification or legal opinion.</p>
<h2>Recorded breach</h2><dl><dt>Case</dt><dd>${escape(b.title)} (${escape(b.id)})</dd>
<dt>Description</dt><dd class="body">${escape(b.description)}</dd><dt>Severity / status</dt><dd>${escape(b.severity)} / ${escape(b.status)}</dd>
<dt>Occurred</dt><dd>${value(b.occurred_at)}</dd><dt>Detected</dt><dd>${escape(b.detected_at)}</dd>
<dt>Recorded DPB deadline</dt><dd>${escape(b.dpb_notification_due_by)}</dd>
<dt>Affected principals</dt><dd>${value(b.affected_count)}</dd><dt>Data categories</dt><dd>${b.data_categories.length ? b.data_categories.map(escape).join(', ') : 'Not recorded'}</dd>
<dt>DPB reference</dt><dd>${value(b.dpb_reference)}</dd></dl>
<h2>Reviewed notification</h2><dl><dt>Notification</dt><dd>${escape(n.id)}</dd><dt>Subject</dt><dd>${escape(n.subject)}</dd>
<dt>Language</dt><dd>${escape(n.language)}</dd><dt>Prepared</dt><dd>${escape(n.created_at)}</dd>
<dt>Reviewed</dt><dd>${escape(n.reviewed_at)}</dd><dt>Recorded delivery</dt><dd>${escape(delivery)}</dd></dl>
<h2>Notification text</h2><p class="body">${escape(n.body)}</p>
<h2>Review and provenance</h2><p>Founder review: ${reviewLine}</p><p class="small">Frozen source SHA-256: ${escape(input.sourceSha256)}<br>Content SHA-256: ${escape(input.documentSha256)}<br>Source captured: ${escape(source.captured_at)}</p>
<footer class="small">${source.limitations.map(escape).join('<br>')}</footer></body></html>`;
}
