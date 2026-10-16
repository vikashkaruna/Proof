import { describe, it, expect } from 'vitest';
import {
  publicReportFixture,
  ids,
  sha,
} from '@axiom/report-kit/test-fixtures/public-control-provenance';
import { assetReportFixture } from '@axiom/report-kit/test-fixtures/public-control-report-v4';
import { BoardReportService } from './board-reports.js';
import { StatutoryReportService } from './statutory-reports.js';
import { evidenceFixture } from '../test/evidence-fixture.js';
import { abortableResult } from '../test/abortable-result.js';
function fixture(kind: 'board' | 'auditor', linked = true, asset = false) {
  const base = evidenceFixture();
  const f = asset ? assetReportFixture(kind) : publicReportFixture(kind);
  base.rows('tenant_users').push({ tenant_id: ids.tenant, user_id: ids.actor, role: 'founder' });
  base.rows('users').push({ id: ids.actor, is_axiom_internal: true });
  const source: Record<string, unknown> = { ...f.source };
  if (!linked) {
    source.schema_version = 1;
    delete source.human_control_review;
  }
  const sourceText = JSON.stringify(source);
  base.rows(kind === 'board' ? 'board_report_requests' : 'statutory_report_requests').push({
    id: ids.request,
    tenant_id: ids.tenant,
    engagement_id: ids.engagement,
    assessment_run_id: ids.run,
    title: f.input.title,
    kind,
    status: 'requested',
    library_version: '0.1.1',
    library_digest: sha(f.scope.controlsText),
    assessment_result_digest: sha(f.scope.resultText),
  });
  const sourceRow = {
    tenant_id: ids.tenant,
    request_id: ids.request,
    source_text: sourceText,
    source_sha256: sha(sourceText),
    controls_sha256: sha(f.scope.controlsText),
    result_sha256: sha(f.scope.resultText),
  };
  base
    .rows(kind === 'board' ? 'board_request_sources' : 'statutory_request_sources')
    .push(sourceRow);
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  base.db.rpc = ((name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    return abortableResult(
      Promise.resolve({
        data: {
          reportId: ids.report,
          requestId: ids.request,
          status: 'draft',
          contentHash: 'a'.repeat(64),
          replayed: false,
        },
        error: null,
      }),
    );
  }) as never;
  return {
    base,
    f,
    sourceRow,
    calls,
    service:
      kind === 'board'
        ? new BoardReportService(base.db, base.db)
        : new StatutoryReportService(base.db, base.db),
  };
}
describe.each(['board', 'auditor'] as const)(
  'frozen %s review document BFF composition',
  (kind) => {
    async function generate(f: ReturnType<typeof fixture>) {
      return f.service instanceof BoardReportService
        ? f.service.generateDraft(ids.tenant, ids.actor, ids.request)
        : f.service.generateAuditorDraft(ids.tenant, ids.actor, ids.request);
    }
    it('composes document4 only from exact immutable source3 asset bindings', async () => {
      const f = fixture(kind, true, true);
      await generate(f);
      expect(f.calls).toHaveLength(1);
      const content = JSON.parse(String(f.calls[0]!.args.p_content_text));
      expect(content.schema_version).toBe(4);
      expect(content.asset_scope.label).toBe('human-declared asset scope');
      expect(content.asset_scope.ownership_verified).toBe(false);
      expect(content.asset_scope.connector_access_granted).toBe(false);
      expect(String(f.calls[0]!.args.p_html_text)).toContain('Human-declared asset scope');
      expect(String(f.calls[0]!.args.p_html_text)).not.toContain('has no retained system');
      expect(f.calls.some((c) => /release|publish|artifact/.test(c.name))).toBe(false);
    });
    it.each(['missing', 'graft', 'downgrade', 'hash'] as const)(
      'refuses source3 %s before any draft write',
      async (change) => {
        const f = fixture(kind, true, true),
          source = JSON.parse(f.sourceRow.source_text),
          human = source.human_control_review;
        if (change === 'missing') {
          const snap = JSON.parse(human.review.snapshot_text);
          delete snap.assetProvenance;
          human.review.snapshot_text = JSON.stringify(snap);
          human.review.snapshot_sha256 = sha(human.review.snapshot_text);
        }
        if (change === 'graft') human.assetProvenance = { ownership_verified: true };
        if (change === 'downgrade') source.schema_version = 2;
        if (change === 'hash') human.review.snapshot_sha256 = 'f'.repeat(64);
        f.sourceRow.source_text = JSON.stringify(source);
        f.sourceRow.source_sha256 = sha(f.sourceRow.source_text);
        await expect(generate(f)).rejects.toThrow();
        expect(f.calls).toHaveLength(0);
      },
    );
    it.each([true, false])(
      'writes versioned deterministic drafts only for the exact frozen source (linked=%s)',
      async (linked) => {
        const f = fixture(kind, linked);
        await generate(f);
        expect(f.calls).toHaveLength(1);
        expect(f.calls[0]!.name).toBe(
          kind === 'board' ? 'record_board_report_draft' : 'record_source_bound_statutory_draft',
        );
        const content = JSON.parse(String(f.calls[0]!.args.p_content_text));
        expect(content.schema_version).toBe(linked ? 3 : 2);
        expect(Boolean(content.public_review_appendix)).toBe(linked);
        expect(content).not.toHaveProperty('signatures.approved_by.user_id');
        if (linked) {
          expect(content.public_review_appendix.evidenceVerified).toBe(false);
          expect(content.public_review_appendix.controls).toHaveLength(46);
          expect(String(f.calls[0]!.args.p_html_text)).toContain('Omitted judgment — Unknown');
        }
        expect(f.calls.some((c) => /publish|release|attach|artifact/.test(c.name))).toBe(false);
      },
    );
    it('refuses duplicate decoded source-version keys before draft persistence', async () => {
      const f = fixture(kind);
      f.sourceRow.source_text = f.sourceRow.source_text.replace(
        '"schema_version":2',
        '"schema_version":1,"schema_version":2',
      );
      f.sourceRow.source_sha256 = sha(f.sourceRow.source_text);
      await expect(generate(f)).rejects.toThrow();
      expect(f.calls).toHaveLength(0);
    });
    it.each(['source', 'manifest', 'tenant', 'offboard'] as const)(
      'refuses %s corruption before any draft persistence',
      async (change) => {
        const f = fixture(kind);
        const source = JSON.parse(f.sourceRow.source_text);
        if (change === 'source') source.human_control_review.review.snapshot_text += ' ';
        if (change === 'manifest') {
          source.human_control_review.catalogue.manifest_text = '{}';
          source.human_control_review.catalogue.manifest_sha256 = sha('{}');
        }
        if (change === 'tenant') source.human_control_review.tenant_id = ids.report;
        if (change === 'offboard') f.base.rows('users')[0]!.is_axiom_internal = false;
        f.sourceRow.source_text = JSON.stringify(source);
        f.sourceRow.source_sha256 = sha(f.sourceRow.source_text);
        await expect(generate(f)).rejects.toThrow();
        expect(f.calls).toHaveLength(0);
      },
    );
  },
);
it.each([3, 4])(
  'published Auditor%s requires retained PDF and cannot fall through the legacy HTML/PDF path',
  async (version) => {
    const f = fixture('auditor');
    const service = f.service as StatutoryReportService;
    f.base.rows('reports').push({
      id: ids.report,
      tenant_id: ids.tenant,
      title: 'Synthetic reviewed output',
      kind: 'auditor',
      status: 'published',
      created_by: ids.actor,
      content_text: JSON.stringify({ schema_version: version, kind: 'auditor_pack' }),
    });
    await expect(service.getReportHtml(ids.tenant, ids.actor, ids.report)).rejects.toThrow(
      'retained_pdf_required',
    );
  },
);
