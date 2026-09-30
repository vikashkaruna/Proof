import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { buildPramaanBoardArchive } from './pramaan-archive';

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
