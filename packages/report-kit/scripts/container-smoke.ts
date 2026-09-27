/** Synthetic, offline runtime asset/ZIP smoke. Never calls BFF, DB or storage. */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildEvidencePack } from '../src/archive';
import { BRANDING, PACK_LIMITS } from '../src/schema';
const output = process.argv[2];
if (!output) throw new Error('Expected synthetic output directory');
const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const maximum = process.argv.includes('--max-size');
const bodies = new Map(
  Array.from(
    { length: maximum ? 6 : 1 },
    (_, i) =>
      [
        uuid(i + 10),
        maximum
          ? Buffer.alloc(PACK_LIMITS.memberBytes, i + 1)
          : Buffer.from('Synthetic offline container packaging test. नमस्ते'),
      ] as const,
  ),
);
const manifestText = JSON.stringify(
  {
    schema_version: 1,
    serialization: 'postgres-jsonb-text-v1',
    kind: 'evidence_pack',
    pack_id: uuid(1),
    tenant_id: uuid(2),
    engagement_id: null,
    library_version: 'synthetic',
    title: 'Synthetic runtime asset check',
    created_at: '2026-09-27T00:00:00.000Z',
    branding: BRANDING,
    generator: { name: 'evidence-pack-builder', version: '1' },
    members: Array.from(bodies, ([id, bytes], i) => ({
      evidence_id: id,
      receipt_id: uuid(i + 100),
      version_id: 'synthetic-v1',
      path: `evidence/${id}.bin`,
      content_hash: sha(bytes),
      byte_size: bytes.length,
      filename: 'synthetic.txt',
      mime_type: 'text/plain',
      description: null,
      evidence_type: 'document',
      collected_by_agent: 'human',
      collected_at: '2026-09-26T00:00:00.000Z',
      control_ids: [],
      provenance: 'human_submitted',
    })),
    limitations: ['Synthetic test fixture; no real approval, storage receipt or source claim.'],
  },
  null,
  2,
);
const expectedManifestSha256 = sha(manifestText);
const reviewText = JSON.stringify(
  {
    schema_version: 1,
    pack_id: uuid(1),
    manifest_sha256: expectedManifestSha256,
    decision: 'approved',
    reviewer: { id: uuid(5), display_name: 'Named Synthetic Approver' },
    reviewed_at: '2026-09-27T00:01:00.000Z',
  },
  null,
  2,
);
const result = buildEvidencePack({
  manifestText,
  expectedManifestSha256,
  reviewText,
  expectedReviewSha256: sha(reviewText),
  members: bodies,
});
writeFileSync(join(output, 'synthetic-pack.zip'), result.archive);
writeFileSync(
  join(output, 'synthetic-receipt.json'),
  JSON.stringify({
    archiveSha256: result.archiveSha256,
    manifestSha256: expectedManifestSha256,
    byteSize: result.byteSize,
  }),
);
console.log(JSON.stringify({ status: 'synthetic_archive_built', byteSize: result.byteSize }));
