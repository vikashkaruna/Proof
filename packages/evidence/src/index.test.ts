import { afterEach, describe, it, expect, vi } from 'vitest';
import { S3Client, GetObjectRetentionCommand, PutObjectCommand } from '@aws-sdk/client-s3';
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

const input = {
  bucket: 'evidence',
  key: 'key',
  body: 'proof',
  contentType: 'text/plain',
  retentionDays: 1,
  tenantId: 'tenant-a',
  collectedByAgent: 'saakshi',
};
const future = new Date('2099-01-01T00:00:00Z');
afterEach(() => vi.restoreAllMocks());
// Narrow the SDK's callback/promise overloads to the promise form used here.
const sendClient = S3Client.prototype as unknown as { send(command: unknown): Promise<unknown> };

describe('seal verifies the uploaded version', () => {
  function provider(retention: object = { Mode: 'COMPLIANCE', RetainUntilDate: future }) {
    return vi
      .spyOn(sendClient, 'send')
      .mockResolvedValueOnce({ ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } })
      .mockResolvedValueOnce({ VersionId: 'immutable-version' })
      .mockResolvedValueOnce({ Retention: retention });
  }
  it('returns verified only after retention readback for the uploaded version', async () => {
    const send = provider();
    const sealed = await new EvidenceVault('ap-south-1').seal({
      ...input,
      metadata: { 'axiom-tenant-id': 'foreign', 'AXIOM-RETENTION-ASSURANCE': 'verified' },
    });
    expect(sealed).toMatchObject({
      versionId: 'immutable-version',
      lockMode: 'COMPLIANCE',
      retentionAssurance: 'verified',
      retainUntil: future.toISOString(),
    });
    expect(send.mock.calls[2]?.[0]).toBeInstanceOf(GetObjectRetentionCommand);
    expect((send.mock.calls[2]?.[0] as GetObjectRetentionCommand).input).toEqual({
      Bucket: 'evidence',
      Key: 'key',
      VersionId: 'immutable-version',
    });
    const metadata = (send.mock.calls[1]?.[0] as PutObjectCommand).input.Metadata;
    expect(metadata?.['axiom-tenant-id']).toBe('tenant-a');
    expect(metadata?.['axiom-retention-assurance']).toBe('unverified');
    expect(metadata).not.toHaveProperty('AXIOM-RETENTION-ASSURANCE');
  });
  it.each([
    {},
    { Mode: 'GOVERNANCE', RetainUntilDate: future },
    { Mode: 'COMPLIANCE', RetainUntilDate: new Date(0) },
  ])('refuses insufficient retention %j', async (retention) => {
    provider(retention);
    await expect(new EvidenceVault('ap-south-1').seal(input)).rejects.toThrow(
      'COMPLIANCE retention',
    );
  });
  it('does not mistake a missing probe object for bucket lock verification', async () => {
    vi.spyOn(sendClient, 'send').mockRejectedValue({
      name: 'NoSuchKey',
      $metadata: { httpStatusCode: 404 },
    });
    await expect(new EvidenceVault('ap-south-1').seal(input)).rejects.toMatchObject({
      name: 'NoSuchKey',
    });
  });
  it('refuses missing lock configuration before uploading', async () => {
    const send = vi.spyOn(sendClient, 'send').mockResolvedValue({});
    await expect(new EvidenceVault('ap-south-1').seal(input)).rejects.toThrow('Object Lock');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('never fabricates successful evidence after an upload failure', async () => {
    vi.spyOn(sendClient, 'send')
      .mockResolvedValueOnce({ ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } })
      .mockRejectedValueOnce(new Error('upload failed'));
    await expect(new EvidenceVault('ap-south-1').seal(input)).rejects.toThrow('upload failed');
  });
  it('refuses a GCS seal until a provider verifier exists, without uploading', async () => {
    const send = vi.spyOn(sendClient, 'send');
    await expect(
      new EvidenceVault('asia-south1', 'https://storage.googleapis.com').seal(input),
    ).rejects.toThrow('GCS sealing requires');
    expect(send).not.toHaveBeenCalled();
  });
  it('refuses unconfirmed legal hold', async () => {
    provider().mockResolvedValueOnce({ LegalHold: { Status: 'OFF' } });
    await expect(
      new EvidenceVault('ap-south-1').seal({ ...input, legalHold: true }),
    ).rejects.toThrow('legal hold');
  });
  it.each([0, -1, 0.5, Number.NaN])(
    'refuses invalid retention %s before upload',
    async (retentionDays) => {
      const send = vi.spyOn(sendClient, 'send');
      await expect(
        new EvidenceVault('ap-south-1').seal({ ...input, retentionDays }),
      ).rejects.toThrow('positive integer');
      expect(send).not.toHaveBeenCalled();
    },
  );
});
