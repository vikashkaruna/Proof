import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { unzipSync } from 'fflate';
import { publicReportFixture, ids, sha } from './public-control-provenance.test-helper';
import { assetReportFixture } from './public-control-report-v4.test-helper';
import { encodeCoverageFirstSource } from './coverage-first-source';
import { buildPramaanBoardArchive, buildPramaanAuditorArchive } from './pramaan-archive';
import { canonicalJson } from '@axiom/ledger';

describe.each(['board', 'auditor'] as const)('Pramaan source4 %s exact provider bytes', (kind) => {
  it.each([false, true])(
    'validates public source and retains complete policy wrapper (asset=%s)',
    (asset) => {
      const original = asset ? assetReportFixture(kind) : publicReportFixture(kind);
      const frozen = encodeCoverageFirstSource(
        kind,
        original.input.sourceText,
        original.input.sourceSha256,
      );
      const sourceBytes = Buffer.from(frozen.text),
        pdfBytes = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(600)]);
      const input = {
        tenantId: ids.tenant,
        engagementId: ids.engagement,
        reportId: ids.report,
        requestId: ids.request,
        title: original.input.title,
        sourceBytes,
        pdfBytes,
        source: { id: ids.request, versionId: 'exact-source4', sha256: sha(frozen.text) },
        pdf: {
          id: ids.report,
          versionId: 'exact-reviewed5-pdf',
          sha256: createHash('sha256').update(pdfBytes).digest('hex'),
        },
      };
      const build = kind === 'board' ? buildPramaanBoardArchive : buildPramaanAuditorArchive;
      const result = build(input),
        files = unzipSync(result.archive);
      expect(Buffer.from(files['source/assessment.json']!).toString()).toBe(frozen.text);
      expect(Buffer.from(files['source/assessment.json']!).toString()).not.toBe(
        original.input.sourceText,
      );
      expect(result.manifest.source.sha256).toBe(frozen.sha256);
      expect(result.archive).toEqual(build(input).archive);
      expect(() => build({ ...input, tenantId: ids.report })).toThrow();
      for (const change of ['policy', 'nested-hash', 'kind', 'duplicate'] as const) {
        const raw = JSON.parse(frozen.text);
        if (change === 'policy') raw.presentation_policy.metrics = 'published';
        if (change === 'nested-hash') raw.retained_source.sha256 = 'f'.repeat(64);
        if (change === 'kind') raw.report_kind = kind === 'board' ? 'auditor' : 'board';
        let text = canonicalJson(raw);
        if (change === 'duplicate')
          text = text.replace('"schema_version":4', '"schema_version":4,"schema_version":4');
        expect(() =>
          build({
            ...input,
            sourceBytes: Buffer.from(text),
            source: { ...input.source, sha256: sha(text) },
          }),
        ).toThrow();
      }
    },
  );
});
