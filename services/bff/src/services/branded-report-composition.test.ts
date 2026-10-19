import { encodeBrandedSource, buildBrandedReport } from '@axiom/report-kit/branded-report';
import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import {
  publicReportFixture,
  ids,
  sha,
} from '@axiom/report-kit/test-fixtures/public-control-provenance';
import { assetReportFixture } from '@axiom/report-kit/test-fixtures/public-control-report-v4';
import { encodeCoverageFirstSource } from '@axiom/report-kit';
import { BoardReportService } from './board-reports.js';
import { StatutoryReportService } from './statutory-reports.js';
import { BoardArtifactService } from './board-artifacts.js';
import { StatutoryArtifactService } from './statutory-artifacts.js';
import { evidenceFixture, config } from '../test/evidence-fixture.js';
import { abortableResult } from '../test/abortable-result.js';
function fixture(kind: 'board' | 'auditor', asset = true) {
  const original = asset ? assetReportFixture(kind) : publicReportFixture(kind);
  const inner = encodeCoverageFirstSource(
    kind,
    original.input.sourceText,
    original.input.sourceSha256,
  );
  const frozen = encodeBrandedSource(kind, inner.text, inner.sha256, 'Synthetic Company');
  const input = { ...original.input, sourceText: frozen.text, sourceSha256: frozen.sha256 };
  const document = buildBrandedReport(input),
    base = evidenceFixture();
  base.rows('tenant_users').push({ tenant_id: ids.tenant, user_id: ids.actor, role: 'founder' });
  base.rows('users').push({ id: ids.actor, is_axiom_internal: true });
  const requests = kind === 'board' ? 'board_report_requests' : 'statutory_report_requests';
  const sources = kind === 'board' ? 'board_request_sources' : 'statutory_request_sources';
  const request = {
    id: ids.request,
    tenant_id: ids.tenant,
    engagement_id: ids.engagement,
    assessment_run_id: ids.run,
    title: input.title,
    kind,
    status: 'requested',
    library_version: '0.1.1',
    library_digest: sha(original.scope.controlsText),
    assessment_result_digest: sha(original.scope.resultText),
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
  base.rows(requests).push(request);
  base.rows(sources).push(source);
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  base.db.rpc = ((name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    return abortableResult(
      Promise.resolve({
        data: name.startsWith('begin_')
          ? { error: 'synthetic_stop_before_provider' }
          : { reportId: ids.report, contentHash: 'a'.repeat(64), replayed: false },
        error: null,
      }),
    );
  }) as never;
  const humanRequestWriter = {
    rpc: vi.fn(() => {
      throw Error('Human request writer cannot record drafts');
    }),
  };
  const board = new BoardReportService(base.db, base.db, humanRequestWriter as never),
    statutory = new StatutoryReportService(base.db, base.db, humanRequestWriter as never);
  const generate = () =>
    kind === 'board'
      ? board.generateDraft(ids.tenant, ids.actor, ids.request)
      : statutory.generateAuditorDraft(ids.tenant, ids.actor, ids.request);
  return { base, input, document, request, source, calls, generate, statutory, humanRequestWriter };
}
function report(f: ReturnType<typeof fixture>, kind: 'board' | 'auditor', status = 'draft') {
  const text = JSON.stringify(f.document);
  const row = {
    id: ids.report,
    tenant_id: ids.tenant,
    engagement_id: ids.engagement,
    kind,
    title: f.input.title,
    status,
    created_by: ids.actor,
    generated_by_agent: kind === 'board' ? 'board-report-builder' : 'statutory-report-builder',
    content_text: text,
    content_sha256: sha(text),
    reviewed_content_hash: sha(text),
    released_archive_hash: null,
  };
  f.base.rows('reports').push(row);
  return row;
}
describe.each(['board', 'auditor'] as const)('branded source6 %s integration', (kind) => {
  it.each([true, false])(
    'builds server-owned doc7 only from exact frozen public source (asset=%s)',
    async (asset) => {
      const f = fixture(kind, asset);
      await f.generate();
      expect(f.calls).toHaveLength(1);
      expect(f.humanRequestWriter.rpc).not.toHaveBeenCalled();
      const content = JSON.parse(String(f.calls[0]!.args.p_content_text));
      expect(content.schema_version).toBe(7);
      expect(content.metrics.state).toBe('withheld');
      expect(content.asset_scope !== null).toBe(asset);
      expect(content.assessment_result_digest).toBe(f.request.assessment_result_digest);
      expect(content.library_digest).toBe(f.request.library_digest);
      for (const k of ['posture_score', 'estimated_exposure_inr', 'score_band'])
        expect(content).not.toHaveProperty(k);
      const html = String(f.calls[0]!.args.p_html_text);
      expect(html).toContain('Scores and financial exposure estimates are withheld');
      expect(html).toContain('Draft for human review');
      expect(html).not.toContain('Human-reviewed document');
      expect(f.calls[0]!.name).toBe(
        kind === 'board' ? 'record_board_report_draft' : 'record_source_bound_statutory_draft',
      );
    },
  );
  it.each(['hash', 'scope', 'policy', 'kind'] as const)(
    'refuses %s before any draft write',
    async (change) => {
      const f = fixture(kind);
      if (change === 'hash') f.source.source_sha256 = 'f'.repeat(64);
      if (change === 'scope') f.request.engagement_id = ids.report;
      if (change === 'policy' || change === 'kind') {
        const raw = JSON.parse(f.source.source_text);
        if (change === 'policy') raw.presentation.revision = 'forged';
        else raw.report_kind = kind === 'board' ? 'auditor' : 'board';
        f.source.source_text = JSON.stringify(raw);
        f.source.source_sha256 = sha(f.source.source_text);
      }
      await expect(f.generate()).rejects.toThrow();
      expect(f.calls).toHaveLength(0);
    },
  );
  it('previews draft from verified retained source, refuses grafts and published unsealed rendering', async () => {
    const f = fixture(kind),
      row = report(f, kind);
    expect(() => f.statutory.validateAndRender(kind, f.document)).toThrow(
      'source_bound_workflow_required',
    );
    const preview = await f.statutory.getReportHtml(ids.tenant, ids.actor, ids.report);
    expect(preview.kind).toBe(kind);
    expect(preview.html).toContain('Draft for human review');
    expect(preview.html).toContain('Omitted judgment — Unknown');
    const exactText = row.content_text;
    row.content_text = exactText.replace(
      '"schema_version":7',
      '"schema_version":7,"schema_version":7',
    );
    row.content_sha256 = sha(row.content_text);
    await expect(
      f.statutory.getReportHtml(ids.tenant, ids.actor, ids.report),
    ).rejects.toMatchObject({ code: 'assessment_source_conflict' });
    row.content_text = exactText;
    row.content_sha256 = sha(exactText);
    f.request.report_id = ids.request;
    await expect(
      f.statutory.getReportHtml(ids.tenant, ids.actor, ids.report),
    ).rejects.toMatchObject({ code: 'assessment_source_conflict' });
    f.request.report_id = ids.report;
    row.status = 'approved';
    await expect(
      f.statutory.getReportHtml(ids.tenant, ids.actor, ids.report),
    ).rejects.toMatchObject({ code: 'assessment_source_conflict' });
    const approvedText = JSON.stringify({
      schema_version: 1,
      report_id: ids.report,
      content_sha256: row.content_sha256,
      decision: 'approved',
      reviewer: { id: ids.actor, display_name: 'Exact approved reviewer' },
      reviewed_at: '2026-10-16T12:00:00Z',
    });
    f.base.rows('report_reviews').push({
      tenant_id: ids.tenant,
      report_id: ids.report,
      review_text: approvedText,
      review_sha256: sha(approvedText),
    });
    const reviewed = await f.statutory.getReportHtml(ids.tenant, ids.actor, ids.report);
    expect(reviewed.html).toContain('Exact approved reviewer');
    expect(reviewed.html).not.toContain('Draft for human review');
    row.status = 'draft';
    row.content_text = JSON.stringify({ ...f.document, posture_score: 100 });
    row.content_sha256 = sha(row.content_text);
    await expect(
      f.statutory.getReportHtml(ids.tenant, ids.actor, ids.report),
    ).rejects.toMatchObject({ code: 'assessment_source_conflict' });
    row.content_text = JSON.stringify(f.document);
    row.content_sha256 = sha(row.content_text);
    row.status = 'published';
    await expect(
      f.statutory.getReportHtml(ids.tenant, ids.actor, ids.report),
    ).rejects.toMatchObject({ code: 'retained_pdf_required' });
  });
  it('uses verified reviewed doc7 renderer and exact v7 manifest identity before provider IO', async () => {
    const f = fixture(kind),
      row = report(f, kind, 'approved');
    const reviewText = JSON.stringify({
      schema_version: 1,
      report_id: ids.report,
      content_sha256: row.content_sha256,
      decision: 'approved',
      reviewer: { id: ids.actor, display_name: 'Synthetic reviewer' },
      reviewed_at: '2026-10-16T12:00:00Z',
    });
    f.base.rows('report_reviews').push({
      id: ids.request,
      tenant_id: ids.tenant,
      report_id: ids.report,
      decision: 'approved',
      content_sha256: row.content_sha256,
      review_text: reviewText,
      review_sha256: sha(reviewText),
      reviewed_at: '2026-10-16T12:00:00Z',
    });
    const body = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(600)]);
    const render = vi.fn().mockResolvedValue({
      pdfBuffer: body,
      sha256: createHash('sha256').update(body).digest('hex'),
      byteLength: body.length,
      renderer: 'chromium',
    });
    const Service = kind === 'board' ? BoardArtifactService : StatutoryArtifactService;
    const service = new Service(
      f.base.db,
      () => ({ vault: f.base.vault, config }),
      render,
      f.base.db,
    );
    await expect(
      service.build(ids.tenant, ids.actor, ids.report, ids.request),
    ).rejects.toMatchObject({ code: 'synthetic_stop_before_provider' });
    expect(render).toHaveBeenCalledOnce();
    expect(render.mock.calls[0]![0]).toContain('Synthetic reviewer');
    expect(render.mock.calls[0]![0]).toContain(
      'Scores and financial exposure estimates are withheld',
    );
    expect(f.calls[0]!.args.p_request).toMatchObject({
      renderer_version: `chromium-${kind}-brand-v7`,
    });
    expect(f.base.vault.seal).not.toHaveBeenCalled();
    f.calls.length = 0;
    render.mockClear();
    row.content_text = JSON.stringify({ ...f.document, metrics: { state: 'published' } });
    row.content_sha256 = sha(row.content_text);
    row.reviewed_content_hash = row.content_sha256;
    await expect(service.build(ids.tenant, ids.actor, ids.report, ids.request)).rejects.toThrow();
    expect(render).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(0);
  });
});
