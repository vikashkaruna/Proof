/**
 * Evidence Vault — S3 client with Object Lock (WORM) Compliance mode.
 *
 * The evidence vault is the product's trust claim. Per Doc 04 §6.2 and
 * Doc 05 §5, this is plain S3 API (no AWS-proprietary conveniences) so
 * the bucket can use compatible S3/MinIO providers. GCS sealing requires a separate verified lock adapter.
 *
 * Object Lock with Compliance mode retention means:
 *   - Object cannot be deleted by ANY user, including root, until retention
 *     period expires
 *   - Object cannot be overwritten
 *   - Retention period itself cannot be shortened
 *
 * Combined with content-addressed storage (the canonical key is the
 * SHA-256 of the content), this is the substrate of "verifiable proof".
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  GetObjectLockConfigurationCommand,
  GetObjectRetentionCommand,
  GetObjectLegalHoldCommand,
  type ObjectLockLegalHold,
  type ObjectLockMode,
  type ServerSideEncryption,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';

export interface SealEvidenceInput {
  bucket: string;
  key: string;
  body: Buffer | Uint8Array | string;
  contentType: string;
  /** Compliance-mode retention duration in days. Cannot be shortened after sealing. */
  retentionDays: number;
  /** Optional legal hold (separate from retention; can be removed by authorised user). */
  legalHold?: boolean;
  /** Server-side encryption. AES-256 is the default. */
  encryption?: ServerSideEncryption;
  /** Tenant ID encoded in object metadata for cross-bucket policies. */
  tenantId: string;
  /** Engagement ID for the engagement-scoped evidence, or null for tenant-global. */
  engagementId?: string | null;
  /** Agent that collected the evidence. */
  collectedByAgent: string;
  /** Free-form metadata. */
  metadata?: Record<string, string>;
}

/**
 * How far a retention claim has been established. See `SealedEvidence`.
 *
 * Deliberately three values rather than a boolean: "we checked and it holds"
 * and "we cannot check from here" are different facts, and collapsing them is
 * what produced a COMPLIANCE label on storage nobody had probed.
 */
export type RetentionAssurance = 'verified' | 'asserted' | 'unverified';

export interface SealedEvidence {
  /** SHA-256 of the content — the canonical identifier. */
  contentHash: string;
  /** The S3 object key (or composed URI for portability). */
  storageUri: string;
  /** The storage URI prefix. */
  bucket: string;
  key: string;
  /** Byte size of the sealed content. */
  byteSize: number;
  /** When the object becomes eligible for deletion (retention end). */
  retainUntil: string;
  /**
   * The object-lock mode actually applied.
   *
   * This used to be the literal 'COMPLIANCE' on every path, including the GCS
   * path where no lock header is sent and nothing is probed (R-10). A sealed
   * artifact asserting compliance-mode retention nobody verified is a false
   * assurance printed on the evidence itself, which is the one place a
   * compliance product cannot afford one.
   */
  lockMode: ObjectLockMode | 'NONE';
  /**
   * How far the retention claim has actually been established (R-10).
   *
   *   `verified`  provider readback confirms retention on the uploaded version
   *   `asserted`  a configuration claim, retained for historical records
   *   `unverified` no provider proof (including metadata written before readback)
   *
   * New seal() results are returned only after verification. Unsupported GCS
   * verification fails closed; endpoint detection is never evidence of a lock.
   *
   * Anything short of `verified` must not be presented to an auditor as WORM
   * evidence without naming which of these it is.
   */
  retentionAssurance: RetentionAssurance;
  /** Why the assurance is what it is, in words an auditor can read. */
  retentionAssuranceReason: string;
  /** Version ID (S3 returns this; for true immutability we use the content hash). */
  versionId: string | undefined;
  /** Server-side encryption applied. */
  encryption: ServerSideEncryption;
}

export class EvidenceVault {
  private readonly s3: S3Client;
  private readonly isGcs: boolean;

  constructor(
    private readonly region: string,
    private readonly endpoint?: string,
    credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string },
  ) {
    this.isGcs = Boolean(endpoint && endpoint.includes('storage.googleapis.com'));
    this.s3 = new S3Client({
      region,
      endpoint,
      forcePathStyle: endpoint !== undefined, // MinIO / R2 / GCS
      credentials,
    });
  }

  /**
   * Seal an artifact. Once sealed, it is WORM — cannot be deleted or
   * overwritten for the retention period.
   */
  async seal(input: SealEvidenceInput): Promise<SealedEvidence> {
    const body = Buffer.isBuffer(input.body)
      ? input.body
      : typeof input.body === 'string'
        ? Buffer.from(input.body, 'utf-8')
        : Buffer.from(input.body);

    const contentHash = createHash('sha256').update(body).digest('hex');

    if (!Number.isSafeInteger(input.retentionDays) || input.retentionDays <= 0) {
      throw new Error('retentionDays must be a positive integer');
    }
    // Fail before upload if the provider cannot establish the required lock.
    await this.assertObjectLockEnabled(input.bucket);
    const retainUntilDate = new Date(
      Math.ceil((Date.now() + input.retentionDays * 86_400_000) / 1000) * 1000,
    );
    if (!Number.isFinite(retainUntilDate.getTime())) throw new Error('Invalid retention date');

    const legalHold: ObjectLockLegalHold = {
      Status: input.legalHold ? 'ON' : 'OFF',
    };

    const putParams: PutObjectCommandInput = {
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
        'axiom-content-sha256': contentHash,
        'axiom-tenant-id': input.tenantId,
        'axiom-engagement-id': input.engagementId ?? '',
        'axiom-collected-by-agent': input.collectedByAgent,
        'axiom-sealed-at': new Date().toISOString(),
        // Upload metadata precedes readback and cannot claim its result.
        'axiom-retention-assurance': 'unverified',
        'axiom-retention-request': 'COMPLIANCE',
      },
      ServerSideEncryption: input.encryption ?? 'AES256',
    };

    // For native AWS S3, specify ObjectLock headers.
    // For Google Cloud Storage as S3 WORM storage, immutability is enforced at the bucket level
    // via GCS Bucket Lock (Retention Policy) without unsupported AWS-specific request headers.
    if (!this.isGcs) {
      putParams.ObjectLockMode = 'COMPLIANCE';
      putParams.ObjectLockRetainUntilDate = retainUntilDate;
      putParams.ObjectLockLegalHoldStatus = legalHold.Status;
      putParams.ChecksumAlgorithm = 'SHA256';
    }

    const cmd = new PutObjectCommand(putParams);

    const result = await this.s3.send(cmd);
    if (!result.VersionId || result.VersionId === 'null') {
      throw new Error('Uploaded evidence has no immutable version; seal not verified');
    }
    const objectRef = { Bucket: input.bucket, Key: input.key, VersionId: result.VersionId };
    const readback = await this.s3.send(new GetObjectRetentionCommand(objectRef));
    const retention = readback.Retention;
    if (
      retention?.Mode !== 'COMPLIANCE' ||
      !retention.RetainUntilDate ||
      !Number.isFinite(retention.RetainUntilDate.getTime()) ||
      retention.RetainUntilDate.getTime() < retainUntilDate.getTime()
    ) {
      throw new Error('Provider did not confirm required COMPLIANCE retention; seal not verified');
    }
    if (input.legalHold) {
      const hold = await this.s3.send(new GetObjectLegalHoldCommand(objectRef));
      if (hold.LegalHold?.Status !== 'ON') throw new Error('Provider did not confirm legal hold');
    }

    return {
      contentHash,
      storageUri: `s3://${input.bucket}/${input.key}`,
      bucket: input.bucket,
      key: input.key,
      byteSize: body.byteLength,
      retainUntil: retention.RetainUntilDate.toISOString(),
      lockMode: 'COMPLIANCE',
      retentionAssurance: 'verified',
      retentionAssuranceReason:
        'Provider readback confirmed COMPLIANCE retention for the uploaded object version.',
      versionId: result.VersionId,
      encryption: input.encryption ?? 'AES256',
    };
  }

  /**
   * Retrieve a sealed artifact. Returns the body and metadata.
   */
  async retrieve(
    bucket: string,
    key: string,
  ): Promise<{
    body: Buffer;
    contentHash: string;
    metadata: Record<string, string>;
    contentType: string | undefined;
    retainUntil: Date | undefined;
    lockMode: ObjectLockMode | undefined;
  }> {
    const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
    const result = await this.s3.send(cmd);
    if (!result.Body) throw new Error(`Empty body for s3://${bucket}/${key}`);
    const bytes = await result.Body.transformToByteArray();
    const body = Buffer.from(bytes);
    const contentHash = createHash('sha256').update(body).digest('hex');

    return {
      body,
      contentHash,
      metadata: Object.fromEntries(
        Object.entries(result.Metadata ?? {}).map(([k, v]) => [k, v ?? '']),
      ),
      contentType: result.ContentType,
      retainUntil: result.ObjectLockRetainUntilDate,
      lockMode: result.ObjectLockMode as ObjectLockMode | undefined,
    };
  }

  /**
   * Verify that the on-disk content matches the recorded content hash.
   * Used to detect bit-rot or accidental overwrite (the latter is
   * blocked by Object Lock, but verifying is still good practice).
   */
  async verifyIntegrity(
    bucket: string,
    key: string,
    expectedHash: string,
  ): Promise<{
    ok: boolean;
    actualHash: string;
  }> {
    const r = await this.retrieve(bucket, key);
    return { ok: r.contentHash === expectedHash, actualHash: r.contentHash };
  }

  /**
   * Generate a time-limited signed URL for auditor access.
   * Audit URLs are read-only and short-lived.
   */
  async presignedAuditUrl(bucket: string, key: string, expiresInSeconds = 300): Promise<string> {
    const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
    return getSignedUrl(this.s3, cmd, { expiresIn: expiresInSeconds });
  }

  /**
   * Head an object — useful for the Approval Console's "evidence ready" check
   * without pulling the body.
   */
  async head(bucket: string, key: string) {
    const cmd = new HeadObjectCommand({ Bucket: bucket, Key: key });
    return this.s3.send(cmd);
  }

  private async assertObjectLockEnabled(bucket: string): Promise<void> {
    if (this.isGcs) {
      throw new Error(
        'GCS sealing requires verified Bucket/Object Retention Lock via a provider adapter; the S3 client cannot establish it',
      );
    }
    const result = await this.s3.send(new GetObjectLockConfigurationCommand({ Bucket: bucket }));
    if (result.ObjectLockConfiguration?.ObjectLockEnabled !== 'Enabled') {
      throw new Error(`Bucket ${bucket} does not have verified Object Lock enabled`);
    }
  }
}

/**
 * Compute SHA-256 of content for use as the canonical key.
 * Use as: `contentKey = \`tenants/\${tenantId}/evidence/\${sha256(content)}/${filename}\``
 */
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
