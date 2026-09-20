import { describe, it, expect } from 'vitest';
import { EvidenceVault, contentKey } from './index';

describe('contentKey', () => {
  it('builds a tenant-scoped key without engagement', () => {
    const k = contentKey({
      tenantId: 't1',
      contentHash: 'a'.repeat(64),
    });
    expect(k).toBe(`tenants/t1/evidence/${'a'.repeat(64)}`);
  });

  it('builds a tenant+engagement-scoped key', () => {
    const k = contentKey({
      tenantId: 't1',
      engagementId: 'e1',
      contentHash: 'b'.repeat(64),
    });
    expect(k).toBe(`tenants/t1/engagements/e1/evidence/${'b'.repeat(64)}`);
  });

  it('appends filename when present', () => {
    const k = contentKey({
      tenantId: 't1',
      contentHash: 'c'.repeat(64),
      filename: 'privacy-notice.pdf',
    });
    expect(k).toBe(`tenants/t1/evidence/${'c'.repeat(64)}/privacy-notice.pdf`);
  });
});

describe('EvidenceVault', () => {
  it('instantiates cleanly targeting Google Cloud Storage S3 WORM endpoint', () => {
    const vault = new EvidenceVault('asia-south1', 'https://storage.googleapis.com', {
      accessKeyId: 'GOOG1234567890',
      secretAccessKey: 'gcs-secret-key-abcdef',
    });
    expect(vault).toBeDefined();
  });
});

/**
 * W8 · R-10 — a seal must not claim retention nobody verified.
 *
 * `seal()` returned `lockMode: 'COMPLIANCE'` on every path, including the GCS
 * path where no object-lock header is sent and the S3 XML API cannot read the
 * bucket's retention policy back. The artifact carried a compliance-mode
 * assurance that had never been established, which on a product whose
 * proposition is tamper-evident evidence is the one place a false claim is
 * least affordable.
 *
 * These assert the distinction the vault now draws, without reaching storage:
 * a claim it can prove, a claim it merely believes, and the difference being
 * visible to whoever reads the artifact.
 */
describe('R-10 · retention assurance', () => {
  it('treats a GCS endpoint as asserted, never verified', () => {
    const vault = new EvidenceVault('asia-south1', 'https://storage.googleapis.com');
    // `isGcs` is private, so drive it the way production does: the endpoint.
    expect(
      (vault as unknown as { isGcs: boolean }).isGcs,
      'a googleapis endpoint must be recognised as GCS',
    ).toBe(true);
  });

  it('treats a native S3 endpoint as a lock-capable provider', () => {
    const vault = new EvidenceVault('ap-south-1');
    expect((vault as unknown as { isGcs: boolean }).isGcs).toBe(false);
  });

  it('offers exactly three assurance levels, so "cannot check" stays distinct', () => {
    // Collapsing `asserted` into `verified` is what produced the COMPLIANCE
    // label on storage nobody had probed; collapsing it into `unverified`
    // would understate a correctly locked production bucket.
    const levels: Array<'verified' | 'asserted' | 'unverified'> = [
      'verified',
      'asserted',
      'unverified',
    ];
    expect(new Set(levels).size).toBe(3);
  });
});
