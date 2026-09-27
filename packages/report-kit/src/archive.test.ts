import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { unzipSync } from 'fflate';
import { buildEvidencePack, readManifestText, readReviewText } from './archive';
import { BRANDING, PACK_LIMITS, ManifestV1Schema } from './schema';
const hash = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
  const body = Buffer.from('Synthetic proof bytes. नमस्ते');
  const manifest = {
    schema_version: 1,
    serialization: 'postgres-jsonb-text-v1',
    kind: 'evidence_pack',
    pack_id: uuid(1),
    tenant_id: uuid(2),
    engagement_id: null,
    library_version: '1.0',
    title: 'Reviewed synthetic pack',
    created_at: '2026-09-27T00:00:00.000Z',
    branding: BRANDING,
    generator: { name: 'evidence-pack-builder', version: '1' },
    members: [
      {
        evidence_id: uuid(3),
        receipt_id: uuid(4),
        version_id: 'exact-v1',
        path: `evidence/${uuid(3)}.bin`,
        content_hash: hash(body),
        byte_size: body.length,
        filename: 'untrusted / display name.txt',
        mime_type: 'text/plain',
        description: 'नमस्ते',
        evidence_type: 'document',
        collected_by_agent: 'human',
        collected_at: '2026-09-26T00:00:00.000Z',
        control_ids: ['C-1'],
        provenance: 'human_submitted',
      },
    ],
    limitations: ['Human-submitted provenance is not independently established.'],
  };
  const manifestText = JSON.stringify(manifest, null, 2);
  const expectedManifestSha256 = hash(manifestText);
  const review = {
    schema_version: 1,
    pack_id: uuid(1),
    manifest_sha256: expectedManifestSha256,
    decision: 'approved',
    reviewer: { id: uuid(5), display_name: 'Actual Fixture Approver' },
    reviewed_at: '2026-09-27T00:01:00.000Z',
  };
  const reviewText = JSON.stringify(review, null, 2);
  return {
    manifest,
    review,
    manifestText,
    expectedManifestSha256,
    reviewText,
    expectedReviewSha256: hash(reviewText),
    members: new Map([[uuid(3), body]]),
  };
}
const verifier = new URL('../python/verify_evidence_pack.py', import.meta.url);
describe('reviewed deterministic archive', () => {
  it('preserves exact DB text, records real attribution, and verifies independently in Python', () => {
    const f = fixture();
    const built = buildEvidencePack(f);
    const entries = unzipSync(built.archive);
    expect(Buffer.from(entries['manifest.json']!).toString()).toBe(f.manifestText);
    expect(Buffer.from(entries['review.json']!).toString()).toBe(f.reviewText);
    expect(Buffer.from(entries['README.txt']!).toString()).toContain('Actual Fixture Approver');
    expect(built.archiveSha256).toBe(hash(built.archive));
    const dir = mkdtempSync(join(tmpdir(), 'axiom-pack-'));
    try {
      const file = join(dir, 'pack.zip');
      writeFileSync(file, built.archive);
      const result = spawnSync(
        'python3',
        [
          fileURLToPath(verifier),
          file,
          '--expected-archive-sha256',
          built.archiveSha256,
          '--expected-manifest-sha256',
          f.expectedManifestSha256,
        ],
        { encoding: 'utf8' },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: 'verified',
        members: 1,
        archive_sha256: built.archiveSha256,
      });
      const changed = Buffer.from(built.archive);
      changed[60] = changed[60]! ^ 1;
      writeFileSync(file, changed);
      expect(
        spawnSync('python3', [
          fileURLToPath(verifier),
          file,
          '--expected-archive-sha256',
          built.archiveSha256,
        ]).status,
      ).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('produces identical bytes under UTC and Asia/Kolkata across repeated construction', () => {
    const f = fixture(),
      old = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const a = buildEvidencePack(f);
      process.env.TZ = 'Asia/Kolkata';
      const b = buildEvidencePack(f);
      expect(a.archive.equals(b.archive)).toBe(true);
      expect(buildEvidencePack(f).archive.equals(b.archive)).toBe(true);
    } finally {
      if (old === undefined) delete process.env.TZ;
      else process.env.TZ = old;
    }
  });
  it('never substitutes another serialization for the stored digest', () => {
    const f = fixture();
    expect(() => buildEvidencePack({ ...f, manifestText: JSON.stringify(f.manifest) })).toThrow(
      'manifest hash',
    );
    expect(readManifestText(f.manifestText).manifestSha256).toBe(hash(f.manifestText));
  });
  it.each([
    'wrong review hash',
    'wrong manifest binding',
    'unnamed approver',
    'wrong pack',
    'predated review',
  ])('rejects %s', (kind) => {
    const f = fixture();
    if (kind === 'wrong review hash') {
      expect(() => buildEvidencePack({ ...f, expectedReviewSha256: '0'.repeat(64) })).toThrow();
      return;
    }
    const r = { ...f.review, reviewer: { ...f.review.reviewer } };
    if (kind === 'wrong manifest binding') r.manifest_sha256 = '0'.repeat(64);
    if (kind === 'unnamed approver') r.reviewer.display_name = ' ';
    if (kind === 'wrong pack') r.pack_id = uuid(6);
    if (kind === 'predated review') r.reviewed_at = '2026-01-01T00:00:00.000Z';
    const text = JSON.stringify(r);
    expect(() =>
      buildEvidencePack({ ...f, reviewText: text, expectedReviewSha256: hash(text) }),
    ).toThrow();
  });
  it.each(['missing', 'extra', 'swapped'])('rejects %s member bytes', (kind) => {
    const f = fixture();
    if (kind === 'missing') f.members.clear();
    if (kind === 'extra') f.members.set(uuid(9), Buffer.from('extra'));
    if (kind === 'swapped') f.members.set(uuid(3), Buffer.from('changed'));
    expect(() => buildEvidencePack(f)).toThrow();
  });
  it.each(['reference', 'sandbox'])('excludes %s collection provenance', (p) => {
    const f = fixture();
    f.manifest.members[0]!.provenance = p;
    expect(() => readManifestText(JSON.stringify(f.manifest))).toThrow();
  });
  it('rejects duplicate JSON keys, unsafe paths, extra provider locations and excessive nesting', () => {
    const f = fixture();
    expect(() =>
      readManifestText(
        f.manifestText.replace('"schema_version": 1', '"schema_version": 1,"schema_version": 1'),
      ),
    ).toThrow('Duplicate');
    expect(() =>
      readReviewText(
        f.reviewText.replace(
          '"decision": "approved"',
          '"decision":"rejected","decision":"approved"',
        ),
      ),
    ).toThrow('Duplicate');
    f.manifest.members[0]!.path = '../escape';
    expect(() => readManifestText(JSON.stringify(f.manifest))).toThrow();
    expect(() =>
      readManifestText(JSON.stringify({ ...fixture().manifest, bucket: 'private' })),
    ).toThrow();
    expect(() => readManifestText('['.repeat(33) + '0' + ']'.repeat(33))).toThrow('depth');
  });
  it('accepts Unicode code points consistently and rejects escaped lone surrogates', () => {
    const f = fixture();
    f.manifest.title = '😀'.repeat(200);
    expect(readManifestText(JSON.stringify(f.manifest)).manifest.title).toBe(f.manifest.title);
    f.manifest.title += '😀';
    expect(() => readManifestText(JSON.stringify(f.manifest))).toThrow();
    f.manifest.title = '\ud800';
    expect(() => readManifestText(JSON.stringify(f.manifest))).toThrow();
    expect(() =>
      readManifestText(
        f.manifestText.replace(
          '"schema_version": 1',
          '"schema_version": 1,"\\u0073chema_version": 1',
        ),
      ),
    ).toThrow('Duplicate');
  });
  it('enforces all member and aggregate bounds before allocation', () => {
    const f = fixture();
    const member = f.manifest.members[0]!;
    expect(
      ManifestV1Schema.safeParse({
        ...f.manifest,
        members: [{ ...member, byte_size: PACK_LIMITS.memberBytes + 1 }],
      }).success,
    ).toBe(false);
    expect(
      ManifestV1Schema.safeParse({
        ...f.manifest,
        members: Array.from({ length: 21 }, (_, i) => ({
          ...member,
          evidence_id: uuid(i + 10),
          receipt_id: uuid(i + 100),
          path: `evidence/${uuid(i + 10)}.bin`,
        })),
      }).success,
    ).toBe(false);
    expect(
      ManifestV1Schema.safeParse({
        ...f.manifest,
        members: Array.from({ length: 7 }, (_, i) => ({
          ...member,
          evidence_id: uuid(i + 10),
          receipt_id: uuid(i + 100),
          path: `evidence/${uuid(i + 10)}.bin`,
          byte_size: PACK_LIMITS.memberBytes,
        })),
      }).success,
    ).toBe(false);
    expect(() => readManifestText(' '.repeat(PACK_LIMITS.metadataBytes + 1))).toThrow();
  });
  it('runs independent malformed ZIP tests with matching outer digests', () => {
    const result = spawnSync(
      'python3',
      [
        '-m',
        'unittest',
        'discover',
        '-s',
        fileURLToPath(new URL('../python', import.meta.url)),
        '-p',
        'test_*.py',
        '-v',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).toContain('OK');
  });
});
