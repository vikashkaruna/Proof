import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildDpbReviewContent, renderReviewedDpbHtml } from './dpb-source';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const requestId = '11111111-1111-4111-8111-111111111111';
const tenantId = '22222222-2222-4222-8222-222222222222';
const reportId = '33333333-3333-4333-8333-333333333333';
const drafter = '44444444-4444-4444-8444-444444444444';
const notificationReviewer = '55555555-5555-4555-8555-555555555555';
const stamp = '2026-09-30T00:00:00.000Z';
const source = {
  schema_version: 1,
  serialization: 'postgres-jsonb-text-v1',
  kind: 'dpb_breach_source',
  request_id: requestId,
  tenant_id: tenantId,
  captured_at: stamp,
  breach: {
    id: '66666666-6666-4666-8666-666666666666',
    title: '<script>alert(1)</script>',
    description: 'Operator-recorded incident',
    severity: 'high',
    status: 'notifying_dpb',
    occurred_at: null,
    detected_at: stamp,
    dpb_notification_due_by: stamp,
    affected_count: null,
    data_categories: ['contact'],
    dpb_notified_at: null,
    dpb_reference: null,
    principals_notified_at: null,
  },
  notification: {
    id: '77777777-7777-4777-8777-777777777777',
    kind: 'dpb',
    status: 'reviewed',
    language: 'en',
    subject: 'Recorded breach',
    body: 'Recorded facts only',
    created_by: drafter,
    created_at: stamp,
    reviewed_by: notificationReviewer,
    reviewed_at: stamp,
    sent_by: null,
    sent_at: null,
    delivery_outcome: null,
    delivery_attempts: 0,
  },
  limitations: [
    'Human-recorded facts, no independent forensic verification.',
    'No regulator receipt verified.',
    'Review pack, not a filed statutory form.',
  ],
};

function fixture(title = 'DPB notification review') {
  const sourceText = JSON.stringify(source);
  const sourceSha256 = sha(sourceText);
  const content = buildDpbReviewContent({
    sourceText,
    sourceSha256,
    requestId,
    tenantId,
    title,
  });
  const documentText = JSON.stringify(content);
  const documentSha256 = sha(documentText);
  const reviewText = JSON.stringify({
    schema_version: 1,
    report_id: reportId,
    content_sha256: documentSha256,
    decision: 'approved',
    reviewer: { id: notificationReviewer, display_name: 'Founder' },
    reviewed_at: stamp,
  });
  return {
    sourceText,
    sourceSha256,
    documentText,
    documentSha256,
    reviewText,
    reviewSha256: sha(reviewText),
    reportId,
    requestId,
    tenantId,
    title,
  };
}

describe('source-bound DPB review pack', () => {
  it('renders only frozen facts and clearly disclaims filing and receipt', () => {
    const html = renderReviewedDpbHtml(fixture());
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('No regulator receipt verified');
    expect(html).toContain('no delivery recorded');
    expect(html).toContain('Founder');
  });

  it('rejects invented content fields and a substituted source', () => {
    const input = fixture();
    const invented = JSON.stringify({
      ...JSON.parse(input.documentText),
      regulator_accepted: true,
    });
    expect(() =>
      renderReviewedDpbHtml({ ...input, documentText: invented, documentSha256: sha(invented) }),
    ).toThrow();
    expect(() => renderReviewedDpbHtml({ ...input, sourceSha256: '0'.repeat(64) })).toThrow();
  });

  it('refuses self-review and inconsistent recorded delivery', () => {
    const input = fixture();
    const self = JSON.stringify({
      ...source,
      notification: { ...source.notification, reviewed_by: drafter },
    });
    expect(() =>
      renderReviewedDpbHtml({ ...input, sourceText: self, sourceSha256: sha(self) }),
    ).toThrow();
    const sent = JSON.stringify({
      ...source,
      notification: { ...source.notification, status: 'sent' },
    });
    expect(() =>
      renderReviewedDpbHtml({ ...input, sourceText: sent, sourceSha256: sha(sent) }),
    ).toThrow();
  });

  it('keeps caller-authored title claims out of the retained PDF', () => {
    const html = renderReviewedDpbHtml(fixture('Regulator acceptance confirmed'));
    expect(html).toContain('<h1>Recorded DPB notification review pack</h1>');
    expect(html).not.toContain('Regulator acceptance confirmed');
  });
});
