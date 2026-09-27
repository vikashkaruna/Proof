/** Synthetic isolated S3 acceptance. Invoked only by scripts/test-evidence-storage.py. */
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  S3Client,
  CreateBucketCommand,
  DeleteObjectCommand,
  PutObjectRetentionCommand,
  ListObjectsV2Command,
  PutObjectLegalHoldCommand,
} from '@aws-sdk/client-s3';
import { EvidenceVault, type SealedEvidence } from './index';

const configPath = process.argv[2];
const phase = process.argv[3];
if (!configPath || !['initial', 'restart', 'unavailable'].includes(phase ?? ''))
  throw new Error('Fixture arguments required');
const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  privateStatePath: string;
  resultPath: string;
};
const url = new URL(config.endpoint);
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
  throw new Error('Fixture must be isolated loopback');
const credentials = { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey };
const s3 = new S3Client({
  region: 'ap-south-1',
  endpoint: config.endpoint,
  credentials,
  forcePathStyle: true,
  maxAttempts: 1,
});
const vault = new EvidenceVault('ap-south-1', config.endpoint, credentials);
const options = { timeoutMs: 10_000, maxBytes: 1024 * 1024 };
const outcomes: string[] = [];
const original = Buffer.from('synthetic-first-version; no customer personal data');
const hash = createHash('sha256').update(original).digest('hex');
const input = {
  bucket: config.bucket,
  key: 'synthetic/operation/proof',
  body: original,
  contentType: 'text/plain',
  retentionDays: 1,
  tenantId: 'synthetic-tenant',
  collectedByAgent: 'human',
  operationId: 'fixture-operation',
};
const receiptInput = (sealed: SealedEvidence) => ({
  ...sealed,
  tenantId: input.tenantId,
  collectedByAgent: input.collectedByAgent,
  operationId: input.operationId,
});
async function denied(work: Promise<unknown>) {
  await assert.rejects(work, (error: unknown) => {
    const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
      ?.httpStatusCode;
    // This pinned upstream maps ErrObjectLocked to 400 InvalidRequest.
    // Accept only that specific retention refusal, not arbitrary client errors.
    return (
      status === 403 ||
      (status === 400 &&
        error instanceof Error &&
        error.name === 'InvalidRequest' &&
        error.message === 'Object is WORM protected and cannot be overwritten')
    );
  });
}

try {
  if (phase === 'initial') {
    await s3.send(
      new CreateBucketCommand({ Bucket: config.bucket, ObjectLockEnabledForBucket: true }),
    );
    await s3.send(new CreateBucketCommand({ Bucket: `${config.bucket}-unlocked` }));
    const sealed = await vault.seal(input, options);
    assert.equal(sealed.encryption, 'AES256');
    assert.equal(sealed.lockMode, 'COMPLIANCE');
    assert.equal(sealed.retentionAssurance, 'verified');
    assert.ok(sealed.versionId);
    outcomes.push('actual-encrypted-exact-version-provider-receipt');
    const found = await vault.findEvidenceVersion(
      input.bucket,
      input.key,
      { ...receiptInput(sealed), byteSize: original.length },
      options,
    );
    assert.equal(found?.versionId, sealed.versionId);
    await vault.verifyReceipt(receiptInput(sealed), options);
    outcomes.push('lost-upload-response-reconciles-unique-bound-version');
    const second = await vault.seal(
      { ...input, body: 'synthetic-second-version', operationId: 'fixture-operation-2' },
      options,
    );
    assert.notEqual(second.versionId, sealed.versionId);
    assert.deepEqual(
      (await vault.retrieve(input.bucket, input.key, sealed.versionId, options)).body,
      original,
    );
    outcomes.push('same-key-overwrite-preserves-original-version-bytes');
    await assert.rejects(
      vault.findEvidenceVersion(
        input.bucket,
        input.key,
        { ...receiptInput(sealed), byteSize: original.length },
        options,
      ),
      /Ambiguous/,
    );
    outcomes.push('multiple-version-recovery-refuses-ambiguity');
    await denied(
      s3.send(
        new DeleteObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
          VersionId: sealed.versionId,
        }),
      ),
    );
    outcomes.push('root-exact-version-delete-denied-by-local-provider');
    await denied(
      s3.send(
        new PutObjectRetentionCommand({
          Bucket: input.bucket,
          Key: input.key,
          VersionId: sealed.versionId,
          BypassGovernanceRetention: true,
          Retention: { Mode: 'COMPLIANCE', RetainUntilDate: new Date(Date.now() + 60_000) },
        }),
      ),
    );
    await vault.verifyReceipt(receiptInput(sealed), options);
    outcomes.push('root-retention-shortening-denied-by-local-provider');
    assert.equal(
      (
        await vault.verifyIntegrity(
          input.bucket,
          input.key,
          sealed.versionId,
          '0'.repeat(64),
          options,
        )
      ).ok,
      false,
    );
    assert.equal(
      (await vault.verifyIntegrity(input.bucket, input.key, sealed.versionId, hash, options)).ok,
      true,
    );
    outcomes.push('wrong-hash-refused-original-hash-proven');
    await assert.rejects(
      vault.retrieve(input.bucket, input.key, sealed.versionId, { ...options, maxBytes: 1 }),
      /byte limit/,
    );
    outcomes.push('real-oversized-response-refused');
    await assert.rejects(vault.retrieve(input.bucket, input.key, 'missing-version', options));
    outcomes.push('unknown-exact-version-refused');
    await assert.rejects(
      vault.verifyReceipt({ ...receiptInput(sealed), tenantId: 'foreign-tenant' }, options),
      /metadata mismatch/,
    );
    outcomes.push('foreign-tenant-metadata-refused');
    await assert.rejects(
      vault.seal({ ...input, bucket: `${config.bucket}-unlocked` }, options),
      /Object Lock/,
    );
    const unlocked = await s3.send(
      new ListObjectsV2Command({ Bucket: `${config.bucket}-unlocked` }),
    );
    assert.equal(unlocked.KeyCount, 0);
    outcomes.push('unlocked-bucket-refused-before-upload');
    const hold = await vault.seal(
      { ...input, key: 'synthetic/legal-hold', legalHold: true },
      options,
    );
    assert.equal(hold.legalHold, true);
    await s3.send(
      new PutObjectLegalHoldCommand({
        Bucket: input.bucket,
        Key: hold.key,
        VersionId: hold.versionId,
        LegalHold: { Status: 'OFF' },
      }),
    );
    await assert.rejects(
      vault.verifyReceipt({ ...receiptInput(hold), legalHold: true }, options),
      /legal hold/,
    );
    await denied(
      s3.send(
        new DeleteObjectCommand({ Bucket: input.bucket, Key: hold.key, VersionId: hold.versionId }),
      ),
    );
    outcomes.push('legal-hold-readback-and-removal-do-not-bypass-compliance');
    writeFileSync(config.privateStatePath, JSON.stringify(sealed), { mode: 0o600 });
  } else {
    const sealed = JSON.parse(readFileSync(config.privateStatePath, 'utf8')) as SealedEvidence;
    if (phase === 'restart') {
      const verified = await vault.verifyReceipt(receiptInput(sealed), options);
      assert.equal(verified.versionId, sealed.versionId);
      assert.deepEqual(
        (await vault.retrieve(input.bucket, input.key, sealed.versionId, options)).body,
        original,
      );
      outcomes.push('persistent-volume-restart-preserves-exact-version-encryption-and-retention');
    } else {
      const start = Date.now();
      await assert.rejects(
        vault.retrieve(input.bucket, input.key, sealed.versionId, { ...options, timeoutMs: 1_000 }),
      );
      assert.ok(Date.now() - start < 5_000);
      outcomes.push('unavailable-provider-refuses-within-deadline');
    }
  }
  writeFileSync(
    config.resultPath,
    JSON.stringify({ phase, status: 'passed', outcomes }, null, 2) + '\n',
    { mode: 0o600 },
  );
  console.log(`Evidence storage ${phase}: ${outcomes.length} outcomes passed`);
} catch (error) {
  // No provider response bodies, endpoints with secrets, or artifact bytes in logs.
  const category = error instanceof Error ? error.name : 'unknown';
  writeFileSync(
    config.resultPath,
    JSON.stringify({
      phase,
      status: 'failed',
      category,
      diagnostic:
        error instanceof assert.AssertionError
          ? {
              code: error.code,
              operator: error.operator,
              actualErrorName: error.actual instanceof Error ? error.actual.name : undefined,
              actualHttpStatus: (
                error.actual as { $metadata?: { httpStatusCode?: number } } | undefined
              )?.$metadata?.httpStatusCode,
            }
          : undefined,
      completedOutcomes: outcomes,
    }),
    { mode: 0o600 },
  );
  console.error(`Evidence storage ${phase}: failed (${category})`);
  process.exitCode = 1;
} finally {
  s3.destroy();
  vault.close();
}
