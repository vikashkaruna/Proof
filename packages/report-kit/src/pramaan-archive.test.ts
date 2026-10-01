import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import {
  buildPramaanAuditorArchive,
  buildPramaanBoardArchive,
  buildPramaanDpbArchive,
  buildPramaanTechnicalArchive,
} from './pramaan-archive';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function fixture() {
  const tenantId = randomUUID();
  const engagementId = randomUUID();
  const reportId = randomUUID();
  const requestId = randomUUID();
  const sourceBytes = Buffer.from(
    JSON.stringify({
      schema_version: 1,
      kind: 'board_source',
      tenant_id: tenantId,
      engagement_id: engagementId,
      request_id: requestId,
    }),
  );
  const pdfBytes = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(500, 42)]);
  return {
    tenantId,
    engagementId,
    reportId,
    requestId,
    title: 'Board closure',
    sourceBytes,
    pdfBytes,
    source: { id: randomUUID(), versionId: 'exact-source-v3', sha256: sha(sourceBytes) },
    pdf: { id: randomUUID(), versionId: 'exact-pdf-v5', sha256: sha(pdfBytes) },
  };
}

describe('Pramaan exact-version board archive', () => {
  it('preserves the exact source and PDF bytes with a bounded, truthful manifest', () => {
    const input = fixture();
    const built = buildPramaanBoardArchive(input);
    const rebuilt = buildPramaanBoardArchive(input);
    expect(built.archiveSha256).toBe(rebuilt.archiveSha256);
    const files = unzipSync(built.archive);
    expect(Buffer.from(files['source/assessment.json']!)).toEqual(input.sourceBytes);
    expect(Buffer.from(files['source/board-report.pdf']!)).toEqual(input.pdfBytes);
    const manifest = JSON.parse(Buffer.from(files['manifest.json']!).toString()) as Record<
      string,
      unknown
    >;
    expect(manifest.kind).toBe('pramaan_board_executive_source_archive');
    expect(JSON.stringify(manifest)).toContain('not an auditor attestation or DPB submission');
    expect(sha(built.archive)).toBe(built.archiveSha256);
  });

  it('rejects mismatched bytes and foreign tenant scope', () => {
    const input = fixture();
    expect(() =>
      buildPramaanBoardArchive({ ...input, pdfBytes: Buffer.from('%PDF-fake') }),
    ).toThrow();
    expect(() => buildPramaanBoardArchive({ ...input, tenantId: randomUUID() })).toThrow();
    const foreignReportBytes = Buffer.from(
      JSON.stringify({
        schema_version: 1,
        kind: 'board_source',
        tenant_id: input.tenantId,
        engagement_id: input.engagementId,
        request_id: randomUUID(),
      }),
    );
    expect(() =>
      buildPramaanBoardArchive({
        ...input,
        sourceBytes: foreignReportBytes,
        source: { ...input.source, sha256: sha(foreignReportBytes) },
      }),
    ).toThrow('different tenant, engagement, or board request');
  });
});

describe('Pramaan released DPB and technical derivatives', () => {
  it('preserves exact recorded-plan source/PDF and refuses a foreign engagement', () => {
    const base = fixture();
    const sourceBytes = Buffer.from(
      JSON.stringify({
        schema_version: 1,
        kind: 'technical_plan_source',
        tenant_id: base.tenantId,
        request_id: base.requestId,
        plan: { engagement_id: base.engagementId },
      }),
    );
    const input = { ...base, sourceBytes, source: { ...base.source, sha256: sha(sourceBytes) } };
    const built = buildPramaanTechnicalArchive(input);
    const files = unzipSync(built.archive);
    expect(Buffer.from(files['source/recorded-plan.json']!)).toEqual(sourceBytes);
    expect(Buffer.from(files['source/technical-review-pack.pdf']!)).toEqual(base.pdfBytes);
    expect(JSON.stringify(built.manifest)).toContain('does not independently certify execution');
    expect(buildPramaanTechnicalArchive(input).archiveSha256).toBe(built.archiveSha256);
    expect(() => buildPramaanTechnicalArchive({ ...input, engagementId: randomUUID() })).toThrow();
  });

  it('keeps the DPB dossier tenant-level and never claims regulator receipt', () => {
    const base = fixture();
    const sourceBytes = Buffer.from(
      JSON.stringify({
        schema_version: 1,
        kind: 'dpb_breach_source',
        tenant_id: base.tenantId,
        request_id: base.requestId,
        breach: { id: randomUUID() },
        notification: { id: randomUUID() },
      }),
    );
    const input = {
      ...base,
      engagementId: null,
      sourceBytes,
      source: { ...base.source, sha256: sha(sourceBytes) },
    };
    const built = buildPramaanDpbArchive(input);
    const files = unzipSync(built.archive);
    expect(Buffer.from(files['source/recorded-breach-notification.json']!)).toEqual(sourceBytes);
    expect(Buffer.from(files['source/dpb-review-pack.pdf']!)).toEqual(base.pdfBytes);
    expect(built.manifest.engagement_id).toBeNull();
    expect(JSON.stringify(built.manifest)).toContain('does not verify regulator receipt');
    expect(() => buildPramaanDpbArchive({ ...input, tenantId: randomUUID() })).toThrow();
    expect(() => buildPramaanDpbArchive({ ...input, sourceBytes: Buffer.from('{}') })).toThrow();
  });
});

describe('Pramaan assessment-derived auditor archive', () => {
  it('keeps exact published source and PDF and labels the assurance limit', () => {
    const board = fixture();
    const sourceBytes = Buffer.from(
      JSON.stringify({
        schema_version: 1,
        kind: 'statutory_source',
        report_kind: 'auditor',
        tenant_id: board.tenantId,
        engagement_id: board.engagementId,
        request_id: board.requestId,
      }),
    );
    const input = { ...board, sourceBytes, source: { ...board.source, sha256: sha(sourceBytes) } };
    const built = buildPramaanAuditorArchive(input);
    expect(buildPramaanAuditorArchive(input).archiveSha256).toBe(built.archiveSha256);
    const files = unzipSync(built.archive);
    expect(Buffer.from(files['source/assessment.json']!)).toEqual(sourceBytes);
    expect(Buffer.from(files['source/auditor-review-pack.pdf']!)).toEqual(board.pdfBytes);
    const manifest = JSON.parse(Buffer.from(files['manifest.json']!).toString()) as Record<
      string,
      unknown
    >;
    expect(manifest.kind).toBe('pramaan_auditor_assurance_source_archive');
    expect(JSON.stringify(manifest)).toContain('not an independent audit');
    expect(() =>
      buildPramaanAuditorArchive({
        ...input,
        reportId: randomUUID(),
        pdfBytes: Buffer.from('%PDF-fake'),
      }),
    ).toThrow();
    expect(() => buildPramaanAuditorArchive({ ...input, tenantId: randomUUID() })).toThrow();
    expect(() => buildPramaanAuditorArchive(board)).toThrow();
  });
});
