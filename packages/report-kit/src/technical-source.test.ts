import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildTechnicalRegisterContent, renderReviewedTechnicalHtml } from './technical-source';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const requestId = randomUUID();
const tenantId = randomUUID();
const planId = randomUUID();
const reportId = randomUUID();
const captured = new Date().toISOString();
const source = {
  schema_version: 1,
  serialization: 'postgres-jsonb-text-v1',
  kind: 'technical_plan_source',
  request_id: requestId,
  tenant_id: tenantId,
  captured_at: captured,
  plan: {
    id: planId,
    engagement_id: randomUUID(),
    library_version: '1.0',
    title: 'Recorded <plan>',
    status: 'review',
    version: 1,
    created_at: captured,
    updated_at: captured,
  },
  actions: [
    {
      id: randomUUID(),
      sequence: 1,
      action_type: 'config.mfa_enforce',
      description: '<img src=x onerror=alert(1)>',
      risk_class: 'medium',
      risk_score: 45,
      parameters_sha256: 'a'.repeat(64),
      rollback_definition_sha256: 'b'.repeat(64),
      rollback_validation_recorded: false,
      rollback_validated_at: null,
      approval_status_recorded: 'draft',
      approval: null,
      dry_run: null,
      execution: null,
      rollback_execution: null,
      verification: null,
      reconciliation: null,
    },
  ],
  limitations: [
    'This is a frozen register of recorded plan and action state, not independent execution verification.',
    'A recorded rollback validation flag is not a rollback execution; only linked rollback executions are shown.',
    'References to pre/post state or verification evidence are not Object Lock or closure attestations.',
  ],
};
const sourceText = JSON.stringify(source);
const sourceSha256 = sha(sourceText);
const title = 'Recorded register';
const content = buildTechnicalRegisterContent({
  sourceText,
  sourceSha256,
  requestId,
  tenantId,
  planId,
  title,
});
const documentText = JSON.stringify(content);
const documentSha256 = sha(documentText);
const reviewText = JSON.stringify({
  schema_version: 1,
  report_id: reportId,
  content_sha256: documentSha256,
  decision: 'approved',
  reviewer: { id: randomUUID(), display_name: 'Founder <reviewer>' },
  reviewed_at: captured,
});
const base = {
  sourceText,
  sourceSha256,
  documentText,
  documentSha256,
  reviewText,
  reviewSha256: sha(reviewText),
  reportId,
  requestId,
  tenantId,
  planId,
  title,
};

describe('technical recorded register', () => {
  it('renders only frozen statuses with escaped facts and actual founder review', () => {
    const html = renderReviewedTechnicalHtml(base);
    expect(html).toContain('Not recorded');
    expect(html).toContain('Recorded &lt;plan&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
    expect(html).toContain('Founder &lt;reviewer&gt;');
    expect(html).toContain('not independent execution verification');
  });
  it('rejects forged or changed claims, source and founder review', () => {
    expect(() => renderReviewedTechnicalHtml({ ...base, sourceText: sourceText + ' ' })).toThrow();
    const forged = JSON.stringify({ ...content, independently_verified: true });
    expect(() =>
      renderReviewedTechnicalHtml({ ...base, documentText: forged, documentSha256: sha(forged) }),
    ).toThrow();
    expect(() =>
      renderReviewedTechnicalHtml({
        ...base,
        reviewText: reviewText.replace('approved', 'rejected'),
        reviewSha256: sha(reviewText.replace('approved', 'rejected')),
      }),
    ).toThrow();
    expect(() =>
      buildTechnicalRegisterContent({
        ...base,
        sourceText: JSON.stringify({ ...source, actions: [] }),
        sourceSha256: sha(JSON.stringify({ ...source, actions: [] })),
      }),
    ).toThrow();
  });
  it('shows linked execution, actual rollback, verification and reconciliation separately', () => {
    const linked = structuredClone(source);
    const action = linked.actions[0]!;
    Object.assign(action, {
      approval_status_recorded: 'approved',
      approval: {
        id: randomUUID(),
        status: 'issued',
        approver_id: randomUUID(),
        issued_at: captured,
        expires_at: captured,
        consumed_at: null,
      },
      dry_run: {
        id: randomUUID(),
        status: 'succeeded',
        renderable: true,
        created_at: captured,
        expires_at: captured,
        diff_sha256: 'c'.repeat(64),
      },
      execution: {
        batch_id: randomUUID(),
        batch_status: 'completed',
        content_digest: 'd'.repeat(64),
        started_at: captured,
        finished_at: captured,
        action_status: 'succeeded',
        final_outcome: 'rolled_back',
        executed_at: captured,
        executed_by_agent: 'karya',
        pre_state_ref_recorded: true,
        post_state_ref_recorded: true,
      },
      rollback_execution: {
        id: randomUUID(),
        status: 'succeeded',
        definition_hash: 'b'.repeat(64),
        triggered_by: 'manual',
        finished_at: captured,
      },
      verification: {
        id: randomUUID(),
        outcome: 'failed',
        verified_at: captured,
        evidence_ref_recorded: true,
      },
      reconciliation: {
        id: randomUUID(),
        created_at: captured,
        unexecuted_count: 1,
        parameter_diff_count: 0,
      },
    });
    const text = JSON.stringify(linked);
    const sourceHash = sha(text);
    const document = JSON.stringify(
      buildTechnicalRegisterContent({
        sourceText: text,
        sourceSha256: sourceHash,
        requestId,
        tenantId,
        planId,
        title,
      }),
    );
    const documentHash = sha(document);
    const review = JSON.stringify({
      schema_version: 1,
      report_id: reportId,
      content_sha256: documentHash,
      decision: 'approved',
      reviewer: { id: randomUUID(), display_name: 'Founder' },
      reviewed_at: captured,
    });
    const html = renderReviewedTechnicalHtml({
      ...base,
      sourceText: text,
      sourceSha256: sourceHash,
      documentText: document,
      documentSha256: documentHash,
      reviewText: review,
      reviewSha256: sha(review),
    });
    expect(html).toContain('Final outcome recorded');
    expect(html).toContain('rolled_back');
    expect(html).toContain('Rollback execution status');
    expect(html).toContain('Verification outcome');
    expect(html).toContain('Parameter difference count');
  });
});
