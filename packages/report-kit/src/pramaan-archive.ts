/** Exact-version derivative archive for a published board report. */
import { createHash } from 'node:crypto';
import { zipSync, type Zippable } from 'fflate';
import { z } from 'zod';
import { BRANDING } from './branding';

const uuid = z.uuid();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const inputSchema = z.object({
  tenantId: uuid,
  engagementId: uuid,
  reportId: uuid,
  requestId: uuid,
  title: z.string().trim().min(1).max(300),
  source: z.object({ id: uuid, versionId: z.string().min(1).max(1024), sha256: digest }),
  pdf: z.object({ id: uuid, versionId: z.string().min(1).max(1024), sha256: digest }),
});

export type PramaanBoardArchiveInput = z.infer<typeof inputSchema> & {
  sourceBytes: Uint8Array;
  pdfBytes: Uint8Array;
};

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The archive contains the exact source and PDF bytes, plus a bounded claim manifest. */
export function buildPramaanBoardArchive(input: PramaanBoardArchiveInput) {
  const parsed = inputSchema.parse(input);
  if (
    input.sourceBytes.length < 1 ||
    input.sourceBytes.length > 4 * 1024 * 1024 ||
    input.pdfBytes.length < 500 ||
    input.pdfBytes.length > 32 * 1024 * 1024 ||
    sha(input.sourceBytes) !== parsed.source.sha256 ||
    sha(input.pdfBytes) !== parsed.pdf.sha256 ||
    !Buffer.from(input.pdfBytes.subarray(0, 5)).equals(Buffer.from('%PDF-'))
  ) {
    throw new Error('Pramaan source bytes do not match exact provider versions');
  }
  const source = z
    .object({
      schema_version: z.literal(1),
      kind: z.literal('board_source'),
      tenant_id: uuid,
      engagement_id: uuid,
      request_id: uuid,
    })
    .parse(JSON.parse(Buffer.from(input.sourceBytes).toString('utf8')));
  if (
    source.tenant_id !== parsed.tenantId ||
    source.engagement_id !== parsed.engagementId ||
    source.request_id !== parsed.requestId
  )
    throw new Error('Pramaan source belongs to a different tenant, engagement, or board request');
  const manifest = {
    schema_version: 1,
    kind: 'pramaan_board_executive_source_archive',
    title: parsed.title,
    branding: {
      product: BRANDING.product,
      company: BRANDING.company,
      company_url: BRANDING.company_url,
    },
    tenant_id: parsed.tenantId,
    engagement_id: parsed.engagementId,
    source_report_id: parsed.reportId,
    source_request_id: parsed.requestId,
    source_merkle_root: sha(
      Buffer.concat([
        Buffer.from([1]),
        Buffer.from(parsed.source.sha256, 'hex'),
        Buffer.from(parsed.pdf.sha256, 'hex'),
      ]),
    ),
    source: {
      path: 'source/assessment.json',
      ...parsed.source,
      byte_size: input.sourceBytes.length,
    },
    board_pdf: { path: 'source/board-report.pdf', ...parsed.pdf, byte_size: input.pdfBytes.length },
    limitations: [
      'This is a derivative of a published board report, not an auditor attestation or DPB submission.',
      'Source/version identifiers and hashes support verification; they do not assert statutory completeness.',
      'Founder sealing is recorded outside this archive and must be checked against the audit ledger.',
    ],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  const fixed = {
    level: 0 as const,
    // fflate encodes ZIP DOS date fields with local Date getters. Supplying
    // the same local calendar fields yields identical archive bytes in every TZ.
    mtime: new Date(1980, 0, 1),
    os: 3 as const,
    attrs: 0o100644 << 16,
  };
  const files: Zippable = Object.create(null) as Zippable;
  files['manifest.json'] = [manifestBytes, fixed];
  files['source/assessment.json'] = [input.sourceBytes, fixed];
  files['source/board-report.pdf'] = [input.pdfBytes, fixed];
  const archive = Buffer.from(zipSync(files, { level: 0 }));
  if (archive.length > 64 * 1024 * 1024) throw new Error('Pramaan archive exceeds byte limit');
  return {
    manifest,
    manifestSha256: sha(manifestBytes),
    archive,
    archiveSha256: sha(archive),
    byteSize: archive.length,
  };
}
