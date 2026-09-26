/** Exact-version S3 evidence. Object Lock protects a version, not the latest key. */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  GetObjectLockConfigurationCommand,
  GetObjectRetentionCommand,
  GetObjectLegalHoldCommand,
  ListObjectVersionsCommand,
  type ServerSideEncryption,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';

export interface EvidenceReadOptions {
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface SealEvidenceInput {
  bucket: string;
  key: string;
  body: Buffer | Uint8Array | string;
  contentType: string;
  retentionDays: number;
  retainUntil?: string;
  operationId?: string;
  legalHold?: boolean;
  encryption?: ServerSideEncryption;
  tenantId: string;
  engagementId?: string | null;
  collectedByAgent: string;
  metadata?: Record<string, string>;
}
export type RetentionAssurance = 'verified' | 'asserted' | 'unverified';
export interface EvidenceReceiptInput {
  bucket: string;
  key: string;
  versionId: string;
  contentHash: string;
  byteSize: number;
  tenantId: string;
  engagementId?: string | null;
  collectedByAgent: string;
  operationId?: string;
  retainUntil: string;
  legalHold?: boolean;
  encryption?: ServerSideEncryption;
}
export interface SealedEvidence {
  contentHash: string;
  storageUri: string;
  bucket: string;
  key: string;
  byteSize: number;
  retainUntil: string;
  lockMode: 'COMPLIANCE';
  retentionAssurance: 'verified';
  retentionAssuranceReason: string;
  versionId: string;
  encryption: ServerSideEncryption;
  legalHold: boolean;
  readbackAt: string;
}
const DEFAULT_BYTES = 16 * 1024 * 1024;
const HARD_BYTES = 64 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;
function reference(bucket: string, key: string, versionId: string) {
  if (!bucket || !key || !versionId?.trim() || versionId === 'null' || versionId.length > 1024)
    throw new Error('Exact evidence version is required');
  return { Bucket: bucket, Key: key, VersionId: versionId };
}
function boundBytes(value = DEFAULT_BYTES) {
  if (!Number.isSafeInteger(value) || value < 1 || value > HARD_BYTES)
    throw new Error('Invalid evidence byte limit');
  return value;
}
async function budget<T>(
  options: EvidenceReadOptions,
  work: (signal: AbortSignal, maxBytes: number) => Promise<T>,
): Promise<T> {
  const maxBytes = boundBytes(options.maxBytes);
  const timeout = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000)
    throw new Error('Invalid evidence deadline');
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, timeout);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    controller.signal.throwIfAborted();
    return await work(controller.signal, maxBytes);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
async function interruptible<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('Evidence deadline or cancellation'));
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export class EvidenceVault {
  private readonly s3: S3Client;
  private readonly isGcs: boolean;
  constructor(
    region: string,
    endpoint?: string,
    credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string },
  ) {
    const host = endpoint ? new URL(endpoint).hostname : '';
    this.isGcs = host === 'storage.googleapis.com' || host.endsWith('.storage.googleapis.com');
    this.s3 = new S3Client({
      region,
      endpoint,
      forcePathStyle: endpoint !== undefined,
      credentials,
      maxAttempts: 1,
    });
  }

  /** Release provider sockets when an isolated worker or acceptance fixture finishes. */
  close(): void {
    this.s3.destroy();
  }

  async seal(input: SealEvidenceInput, options: EvidenceReadOptions = {}): Promise<SealedEvidence> {
    if (!Number.isSafeInteger(input.retentionDays) || input.retentionDays <= 0)
      throw new Error('retentionDays must be a positive integer');
    const maxBytes = boundBytes(options.maxBytes);
    const size =
      typeof input.body === 'string'
        ? Buffer.byteLength(input.body, 'utf8')
        : input.body.byteLength;
    if (size > maxBytes) throw new Error('Evidence exceeds byte limit');
    const body = Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body);
    const contentHash = createHash('sha256').update(body).digest('hex');
    const retainUntil = input.retainUntil
      ? new Date(input.retainUntil)
      : new Date(Math.ceil((Date.now() + input.retentionDays * 86_400_000) / 1000) * 1000);
    if (!Number.isFinite(retainUntil.getTime()) || retainUntil.getTime() <= Date.now())
      throw new Error('Invalid retention date');
    return budget(options, async (signal, maxBytes) => {
      if (body.length > maxBytes) throw new Error('Evidence exceeds byte limit');
      await this.assertObjectLockEnabled(input.bucket, signal);
      const result = await this.s3.send(
        new PutObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
          Body: body,
          ContentType: input.contentType,
          ContentMD5: createHash('md5').update(body).digest('base64'),
          Metadata: {
            ...Object.fromEntries(
              Object.entries(input.metadata ?? {}).filter(
                ([key]) => !key.toLowerCase().startsWith('axiom-'),
              ),
            ),
            ...(input.operationId ? { 'axiom-operation-id': input.operationId } : {}),
            'axiom-content-sha256': contentHash,
            'axiom-tenant-id': input.tenantId,
            'axiom-engagement-id': input.engagementId ?? '',
            'axiom-collected-by-agent': input.collectedByAgent,
            'axiom-sealed-at': new Date().toISOString(),
            'axiom-retention-assurance': 'unverified',
            'axiom-retention-request': 'COMPLIANCE',
          },
          ServerSideEncryption: input.encryption ?? 'AES256',
          ObjectLockMode: 'COMPLIANCE',
          ObjectLockRetainUntilDate: retainUntil,
          ObjectLockLegalHoldStatus: input.legalHold ? 'ON' : 'OFF',
          ChecksumAlgorithm: 'SHA256',
        }),
        { abortSignal: signal },
      );
      if (!result.VersionId || result.VersionId === 'null')
        throw new Error('Uploaded evidence has no immutable version; seal not verified');
      // Upload may already be durable if verification fails. The caller must
      // retain its ingestion intent and reconcile, never delete as rollback.
      return this.receipt(
        {
          ...input,
          contentHash,
          byteSize: body.length,
          versionId: result.VersionId,
          retainUntil: retainUntil.toISOString(),
        },
        signal,
        maxBytes,
      );
    });
  }

  async retrieve(
    bucket: string,
    key: string,
    versionId: string,
    options: EvidenceReadOptions = {},
  ) {
    const ref = reference(bucket, key, versionId);
    return budget(options, (signal, maxBytes) => this.read(ref, signal, maxBytes));
  }

  private async read(
    ref: { Bucket: string; Key: string; VersionId: string },
    signal: AbortSignal,
    maxBytes: number,
  ) {
    const result = await this.s3.send(new GetObjectCommand(ref), { abortSignal: signal });
    const body = result.Body as (AsyncIterable<Uint8Array> & { destroy?: () => void }) | undefined;
    try {
      if (result.VersionId !== ref.VersionId || result.DeleteMarker)
        throw new Error('Evidence version mismatch');
      if (
        !Number.isSafeInteger(result.ContentLength) ||
        result.ContentLength! < 0 ||
        result.ContentLength! > maxBytes
      )
        throw new Error('Evidence exceeds byte limit or size is unavailable');
      if (!body || !body[Symbol.asyncIterator]) throw new Error('Evidence body unavailable');
      const chunks: Buffer[] = [];
      let length = 0;
      const iterator = body[Symbol.asyncIterator]();
      while (true) {
        const chunk = await interruptible(iterator.next(), signal);
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > maxBytes || length > result.ContentLength!)
          throw new Error('Evidence exceeds byte limit');
        chunks.push(Buffer.from(chunk.value));
      }
      if (length !== result.ContentLength) throw new Error('Evidence size mismatch');
      const bytes = Buffer.concat(chunks, length);
      return {
        body: bytes,
        contentHash: createHash('sha256').update(bytes).digest('hex'),
        metadata: result.Metadata ?? {},
        contentType: result.ContentType,
        retainUntil: result.ObjectLockRetainUntilDate,
        lockMode: result.ObjectLockMode,
        versionId: ref.VersionId,
        encryption: result.ServerSideEncryption,
      };
    } finally {
      body?.destroy?.();
    }
  }

  async verifyIntegrity(
    bucket: string,
    key: string,
    versionId: string,
    expectedHash: string,
    options: EvidenceReadOptions = {},
  ) {
    if (!HASH.test(expectedHash)) throw new Error('Invalid evidence content hash');
    const result = await this.retrieve(bucket, key, versionId, options);
    return { ok: result.contentHash === expectedHash, actualHash: result.contentHash };
  }

  async verifyReceipt(
    input: EvidenceReceiptInput,
    options: EvidenceReadOptions = {},
  ): Promise<SealedEvidence> {
    reference(input.bucket, input.key, input.versionId);
    return budget(options, async (signal, maxBytes) => {
      await this.assertObjectLockEnabled(input.bucket, signal);
      return this.receipt(input, signal, maxBytes);
    });
  }

  private async receipt(
    input: EvidenceReceiptInput,
    signal: AbortSignal,
    maxBytes: number,
  ): Promise<SealedEvidence> {
    const ref = reference(input.bucket, input.key, input.versionId);
    if (
      !HASH.test(input.contentHash) ||
      !Number.isSafeInteger(input.byteSize) ||
      input.byteSize < 0 ||
      input.byteSize > maxBytes
    )
      throw new Error('Invalid evidence receipt');
    const requestedUntil = Date.parse(input.retainUntil);
    if (!Number.isFinite(requestedUntil)) throw new Error('Invalid evidence retention date');
    const readback = await this.s3.send(new GetObjectRetentionCommand(ref), {
      abortSignal: signal,
    });
    const until = readback.Retention?.RetainUntilDate;
    if (
      readback.Retention?.Mode !== 'COMPLIANCE' ||
      !until ||
      !Number.isFinite(until.getTime()) ||
      until.getTime() < requestedUntil ||
      until.getTime() <= Date.now()
    )
      throw new Error('Provider did not confirm required COMPLIANCE retention');
    const hold = await this.s3.send(new GetObjectLegalHoldCommand(ref), { abortSignal: signal });
    const legalHold = hold.LegalHold?.Status === 'ON';
    if (!['ON', 'OFF'].includes(hold.LegalHold?.Status ?? '') || (input.legalHold && !legalHold))
      throw new Error('Provider did not confirm legal hold');
    const object = await this.read(ref, signal, maxBytes);
    if (object.contentHash !== input.contentHash || object.body.length !== input.byteSize)
      throw new Error('Evidence hash or size mismatch');
    const expected = {
      ...(input.operationId ? { 'axiom-operation-id': input.operationId } : {}),
      'axiom-content-sha256': input.contentHash,
      'axiom-tenant-id': input.tenantId,
      'axiom-engagement-id': input.engagementId ?? '',
      'axiom-collected-by-agent': input.collectedByAgent,
    };
    if (Object.entries(expected).some(([key, value]) => object.metadata[key] !== value))
      throw new Error('Evidence metadata mismatch');
    if (object.encryption !== (input.encryption ?? 'AES256'))
      throw new Error('Provider did not confirm evidence encryption');
    return {
      bucket: input.bucket,
      key: input.key,
      versionId: input.versionId,
      storageUri: `s3://${input.bucket}/${input.key}`,
      contentHash: input.contentHash,
      byteSize: input.byteSize,
      retainUntil: until.toISOString(),
      lockMode: 'COMPLIANCE',
      retentionAssurance: 'verified',
      retentionAssuranceReason:
        'Exact-version bytes, metadata, encryption and COMPLIANCE retention verified by provider readback.',
      encryption: object.encryption,
      legalHold,
      readbackAt: new Date().toISOString(),
    };
  }

  /** Recovery only for a server-stored unique ingestion key. No upload or latest-key adoption. */
  async findEvidenceVersion(
    bucket: string,
    key: string,
    expected: {
      tenantId: string;
      contentHash: string;
      byteSize: number;
      operationId: string;
      engagementId?: string | null;
      collectedByAgent: string;
    },
    options: EvidenceReadOptions = {},
  ): Promise<{ versionId: string } | null> {
    if (
      !bucket ||
      !key ||
      !expected.operationId ||
      !HASH.test(expected.contentHash) ||
      !Number.isSafeInteger(expected.byteSize) ||
      expected.byteSize < 0
    )
      throw new Error('Invalid evidence reconciliation');
    return budget(options, async (signal, maxBytes) => {
      const listing = await this.s3.send(
        new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key, MaxKeys: 11 }),
        { abortSignal: signal },
      );
      if (
        listing.IsTruncated ||
        (listing.Versions?.length ?? 0) > 10 ||
        listing.DeleteMarkers?.some((item) => item.Key === key)
      )
        throw new Error('Ambiguous evidence versions');
      const versions = (listing.Versions ?? []).filter((item) => item.Key === key);
      if (versions.length === 0) return null;
      if (versions.length !== 1) throw new Error('Ambiguous evidence versions');
      const ref = reference(bucket, key, versions[0]!.VersionId!);
      const object = await this.s3.send(new HeadObjectCommand(ref), { abortSignal: signal });
      if (
        object.VersionId !== ref.VersionId ||
        object.DeleteMarker ||
        object.ContentLength !== expected.byteSize ||
        expected.byteSize > maxBytes
      )
        throw new Error('Evidence reconciliation mismatch');
      const metadata = {
        'axiom-operation-id': expected.operationId,
        'axiom-tenant-id': expected.tenantId,
        'axiom-content-sha256': expected.contentHash,
        'axiom-engagement-id': expected.engagementId ?? '',
        'axiom-collected-by-agent': expected.collectedByAgent,
      };
      if (Object.entries(metadata).some(([name, value]) => object.Metadata?.[name] !== value))
        throw new Error('Evidence reconciliation mismatch');
      return { versionId: ref.VersionId };
    });
  }

  async presignedAuditUrl(
    bucket: string,
    key: string,
    versionId: string,
    expiresInSeconds = 300,
  ): Promise<string> {
    const ref = reference(bucket, key, versionId);
    if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 900)
      throw new Error('Invalid audit URL lifetime');
    return getSignedUrl(this.s3, new GetObjectCommand(ref), { expiresIn: expiresInSeconds });
  }

  async head(bucket: string, key: string, versionId: string, options: EvidenceReadOptions = {}) {
    const ref = reference(bucket, key, versionId);
    return budget(options, async (signal, maxBytes) => {
      const result = await this.s3.send(new HeadObjectCommand(ref), { abortSignal: signal });
      if (result.VersionId !== versionId || result.DeleteMarker)
        throw new Error('Evidence version mismatch');
      if (
        !Number.isSafeInteger(result.ContentLength) ||
        result.ContentLength! < 0 ||
        result.ContentLength! > maxBytes
      )
        throw new Error('Evidence exceeds byte limit or size is unavailable');
      return result;
    });
  }

  private async assertObjectLockEnabled(bucket: string, signal: AbortSignal) {
    if (this.isGcs)
      throw new Error(
        'GCS sealing requires verified Bucket/Object Retention Lock via a provider adapter',
      );
    const result = await this.s3.send(new GetObjectLockConfigurationCommand({ Bucket: bucket }), {
      abortSignal: signal,
    });
    if (result.ObjectLockConfiguration?.ObjectLockEnabled !== 'Enabled')
      throw new Error('Bucket does not have verified Object Lock enabled');
  }
}

export function contentKey(args: {
  tenantId: string;
  contentHash: string;
  filename?: string;
  engagementId?: string | null;
}): string {
  const path = args.engagementId
    ? `tenants/${args.tenantId}/engagements/${args.engagementId}/evidence/${args.contentHash}`
    : `tenants/${args.tenantId}/evidence/${args.contentHash}`;
  return args.filename ? `${path}/${args.filename}` : path;
}
