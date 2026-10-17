import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  buildQuestionnaireEvidenceReport,
  encodeQuestionnaireEvidenceSource,
} from '@axiom/report-kit/questionnaire-evidence-report';
import { sourcePacket } from '@axiom/report-kit/test-fixtures/board-v2';
import { BoardReportService } from './board-reports.js';
import { StatutoryReportService } from './statutory-reports.js';
import { evidenceFixture } from '../test/evidence-fixture.js';
import { abortableResult } from '../test/abortable-result.js';

const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
const ids = {
  tenant: '22222222-2222-4222-8222-222222222222',
  engagement: '33333333-3333-4333-8333-333333333333',
  run: '44444444-4444-4444-8444-444444444444',
  request: '11111111-1111-4111-8111-111111111111',
  report: '55555555-5555-4555-8555-555555555555',
  actor: '66666666-6666-4666-8666-666666666666',
};

function fixture(kind: 'board' | 'auditor') {
  const packet = sourcePacket();
  const controlsText = JSON.stringify(packet.controls);
  const resultText = JSON.stringify(packet.result);
  const retained = JSON.stringify({
    schema_version: 1,
    serialization: 'postgres-jsonb-text-v1',
    kind: kind === 'board' ? 'board_source' : 'statutory_source',
    ...(kind === 'auditor' ? { report_kind: 'auditor' } : {}),
    request_id: ids.request,
    tenant_id: ids.tenant,
    engagement_id: ids.engagement,
    assessment_run_id: ids.run,
    library_version: 'test-v2',
    controls_text: controlsText,
    controls_sha256: sha(controlsText),
    result_text: resultText,
    result_sha256: sha(resultText),
    completed_at: '2026-10-17T05:00:00+00:00',
    finalized_at: '2026-10-17T05:01:00+00:00',
    receipts: {
      started: { id: '1', entry_hash: 'a'.repeat(64) },
      completed: { id: '2', entry_hash: 'b'.repeat(64) },
      finalized: { id: '3', entry_hash: 'c'.repeat(64) },
    },
    limitations: ['Recorded questionnaire computation; no independent evidence verification.'],
  });
  const frozen = encodeQuestionnaireEvidenceSource(kind, retained, sha(retained));
  const base = evidenceFixture();
  base.rows('tenant_users').push({ tenant_id: ids.tenant, user_id: ids.actor, role: 'founder' });
  base.rows('users').push({ id: ids.actor, is_axiom_internal: true });
  const request = {
    id: ids.request,
    tenant_id: ids.tenant,
    engagement_id: ids.engagement,
    assessment_run_id: ids.run,
    title: 'Questionnaire evidence review',
    kind,
    status: 'requested',
    library_version: 'test-v2',
    library_digest: sha(controlsText),
    assessment_result_digest: sha(resultText),
    report_id: ids.report,
  };
  const source = {
    tenant_id: ids.tenant,
    request_id: ids.request,
    source_text: frozen.text,
    source_sha256: frozen.sha256,
    controls_sha256: request.library_digest,
    result_sha256: request.assessment_result_digest,
  };
  base.rows(kind === 'board' ? 'board_report_requests' : 'statutory_report_requests').push(request);
  base.rows(kind === 'board' ? 'board_request_sources' : 'statutory_request_sources').push(source);
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  base.db.rpc = ((name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    return abortableResult(
      Promise.resolve({
        data: { reportId: ids.report, contentHash: 'a'.repeat(64), replayed: false },
        error: null,
      }),
    );
  }) as never;
  const board = new BoardReportService(base.db, base.db);
  const statutory = new StatutoryReportService(base.db, base.db);
  const generate = () =>
    kind === 'board'
      ? board.generateDraft(ids.tenant, ids.actor, ids.request)
      : statutory.generateAuditorDraft(ids.tenant, ids.actor, ids.request);
  return { base, request, source, calls, generate, statutory, frozen };
}

describe.each(['board', 'auditor'] as const)('source5 %s integration', (kind) => {
  it('drafts server-owned document6 with every estimate withheld', async () => {
    const f = fixture(kind);
    await f.generate();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.name).toBe(
      kind === 'board' ? 'record_board_report_draft' : 'record_source_bound_statutory_draft',
    );
    const content = JSON.parse(String(f.calls[0]!.args.p_content_text));
    expect(content.schema_version).toBe(6);
    expect(content.metrics).toEqual({ state: 'withheld', compliance_conclusion: 'not_determined' });
    expect(content).toEqual(
      buildQuestionnaireEvidenceReport({
        requestId: ids.request,
        tenantId: ids.tenant,
        engagementId: ids.engagement,
        assessmentRunId: ids.run,
        title: f.request.title,
        sourceText: f.frozen.text,
        sourceSha256: f.frozen.sha256,
        generatedAt: content.generated_at,
      }),
    );
    for (const k of ['posture_score', 'estimated_exposure_inr', 'executive_summary', 'findings'])
      expect(content).not.toHaveProperty(k);
    const html = String(f.calls[0]!.args.p_html_text);
    expect(html).toContain('Scores, score bands and financial exposure estimates are withheld');
    expect(html).not.toMatch(/123456|posture/i);
  });

  it.each(['hash', 'policy', 'kind'] as const)(
    'refuses %s before any draft write',
    async (change) => {
      const f = fixture(kind);
      if (change === 'hash') f.source.source_sha256 = 'f'.repeat(64);
      else {
        const raw = JSON.parse(f.source.source_text);
        if (change === 'policy') raw.presentation_policy.metrics = 'published';
        else raw.report_kind = kind === 'board' ? 'auditor' : 'board';
        f.source.source_text = JSON.stringify(raw);
        f.source.source_sha256 = sha(f.source.source_text);
      }
      await expect(f.generate()).rejects.toThrow();
      expect(f.calls).toHaveLength(0);
    },
  );

  it('never routes document6 through the legacy renderer', () => {
    const f = fixture(kind);
    expect(() =>
      f.statutory.validateAndRender(kind, { schema_version: 6, kind: 'board_report' }),
    ).toThrow('source_bound_workflow_required');
  });
});
