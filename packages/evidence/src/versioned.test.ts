import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { EvidenceVault } from './index';

const client = S3Client.prototype as unknown as { send(command: unknown): Promise<unknown> };
const hash = createHash('sha256').update('proof').digest('hex');
const vault = () =>
  new EvidenceVault('ap-south-1', undefined, { accessKeyId: 'test', secretAccessKey: 'test' });
const payload = (extra: object = {}) => ({
  VersionId: 'v1',
  ContentLength: 5,
  Body: Readable.from([Buffer.from('proof')]),
  ...extra,
});
afterEach(() => vi.restoreAllMocks());

describe('exact-version bounded reads', () => {
  it('passes the exact version and hashes actual streamed bytes', async () => {
    const send = vi.spyOn(client, 'send').mockResolvedValue(payload());
    expect(await vault().verifyIntegrity('bucket', 'key', 'v1', hash)).toEqual({
      ok: true,
      actualHash: hash,
    });
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetObjectCommand);
    expect((send.mock.calls[0]?.[0] as GetObjectCommand).input).toEqual({
      Bucket: 'bucket',
      Key: 'key',
      VersionId: 'v1',
    });
  });
  it.each(['', 'null', ' '])(
    'refuses non-version %j before contacting storage',
    async (version) => {
      const send = vi.spyOn(client, 'send');
      await expect(vault().retrieve('bucket', 'key', version)).rejects.toThrow(
        'Exact evidence version',
      );
      await expect(vault().head('bucket', 'key', version)).rejects.toThrow(
        'Exact evidence version',
      );
      await expect(vault().presignedAuditUrl('bucket', 'key', version)).rejects.toThrow(
        'Exact evidence version',
      );
      expect(send).not.toHaveBeenCalled();
    },
  );
  it('rejects a provider answering with another version and closes its body', async () => {
    const body = Readable.from([Buffer.from('proof')]);
    const destroy = vi.spyOn(body, 'destroy');
    vi.spyOn(client, 'send').mockResolvedValue(payload({ VersionId: 'v2', Body: body }));
    await expect(vault().retrieve('bucket', 'key', 'v1')).rejects.toThrow('version mismatch');
    expect(destroy).toHaveBeenCalled();
  });
  it('does not turn a wrong hash into verified integrity', async () => {
    vi.spyOn(client, 'send').mockResolvedValue(payload());
    expect(await vault().verifyIntegrity('bucket', 'key', 'v1', '0'.repeat(64))).toEqual({
      ok: false,
      actualHash: hash,
    });
  });
  it.each([{ ContentLength: 10 }, { ContentLength: undefined }, { ContentLength: 2 }])(
    'bounds reported and streamed byte sizes %j',
    async (extra) => {
      vi.spyOn(client, 'send').mockResolvedValue(payload(extra));
      await expect(vault().retrieve('bucket', 'key', 'v1', { maxBytes: 5 })).rejects.toThrow(
        /byte limit|size/,
      );
    },
  );
  it('refuses a truncated stream', async () => {
    vi.spyOn(client, 'send').mockResolvedValue(payload({ ContentLength: 6 }));
    await expect(vault().retrieve('bucket', 'key', 'v1')).rejects.toThrow('size mismatch');
  });
  it('cancels a stalled body without waiting for another byte', async () => {
    const body = new Readable({ read() {} });
    const destroy = vi.spyOn(body, 'destroy');
    vi.spyOn(client, 'send').mockResolvedValue(payload({ Body: body }));
    await expect(vault().retrieve('bucket', 'key', 'v1', { timeoutMs: 20 })).rejects.toThrow(
      'deadline',
    );
    expect(destroy).toHaveBeenCalled();
  });
  it('refuses pre-cancelled reads without provider access', async () => {
    const controller = new AbortController();
    controller.abort();
    const send = vi.spyOn(client, 'send');
    await expect(
      vault().retrieve('bucket', 'key', 'v1', { signal: controller.signal }),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it('pins head and signed audit URLs to the version', async () => {
    const send = vi.spyOn(client, 'send').mockResolvedValue({ VersionId: 'v1', ContentLength: 5 });
    await vault().head('bucket', 'key', 'v1');
    expect((send.mock.calls[0]?.[0] as HeadObjectCommand).input.VersionId).toBe('v1');
    const url = new URL(await vault().presignedAuditUrl('bucket', 'key', 'v1', 60));
    expect(url.searchParams.get('versionId')).toBe('v1');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
  });
});

describe('durable intent recovery', () => {
  const expected = {
    tenantId: 'tenant',
    operationId: 'operation',
    contentHash: hash,
    byteSize: 5,
    collectedByAgent: 'human',
  };
  const metadata = {
    'axiom-tenant-id': 'tenant',
    'axiom-operation-id': 'operation',
    'axiom-content-sha256': hash,
    'axiom-engagement-id': '',
    'axiom-collected-by-agent': 'human',
  };
  it('finds only a unique exact version bound to the ingestion intent', async () => {
    const send = vi
      .spyOn(client, 'send')
      .mockResolvedValueOnce({ Versions: [{ Key: 'key', VersionId: 'v1' }] })
      .mockResolvedValueOnce({ VersionId: 'v1', ContentLength: 5, Metadata: metadata });
    expect(await vault().findEvidenceVersion('bucket', 'key', expected)).toEqual({
      versionId: 'v1',
    });
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(ListObjectVersionsCommand);
    expect((send.mock.calls[1]?.[0] as HeadObjectCommand).input.VersionId).toBe('v1');
  });
  it.each([
    { IsTruncated: true },
    {
      Versions: [
        { Key: 'key', VersionId: 'v1' },
        { Key: 'key', VersionId: 'v2' },
      ],
    },
    { DeleteMarkers: [{ Key: 'key' }] },
  ])('preserves ambiguity rather than adopting a latest version', async (listing) => {
    vi.spyOn(client, 'send').mockResolvedValue(listing);
    await expect(vault().findEvidenceVersion('bucket', 'key', expected)).rejects.toThrow(
      'Ambiguous',
    );
  });
  it('returns missing without creating another upload', async () => {
    const send = vi.spyOn(client, 'send').mockResolvedValue({ Versions: [] });
    expect(await vault().findEvidenceVersion('bucket', 'key', expected)).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('refuses another operation stored at the expected key', async () => {
    vi.spyOn(client, 'send')
      .mockResolvedValueOnce({ Versions: [{ Key: 'key', VersionId: 'v1' }] })
      .mockResolvedValueOnce({
        VersionId: 'v1',
        ContentLength: 5,
        Metadata: { ...metadata, 'axiom-operation-id': 'foreign' },
      });
    await expect(vault().findEvidenceVersion('bucket', 'key', expected)).rejects.toThrow(
      'reconciliation mismatch',
    );
  });
});
