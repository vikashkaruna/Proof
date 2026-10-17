import { describe, expect, it, vi } from 'vitest';
import {
  CreateBucketCommand,
  GetObjectLockConfigurationCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import {
  LOCAL_RETAINED_BUCKET,
  localBucketSettings,
  provisionLocalBucket,
} from './provision-local-bucket.js';

const env = (over: Record<string, string> = {}) =>
  Object.entries({
    AXIOM_STORAGE_ENDPOINT: 'http://axiom-minio:9000',
    AXIOM_STORAGE_PROVISION_ENDPOINT: 'http://127.0.0.1:9100',
    AXIOM_EVIDENCE_BUCKET: LOCAL_RETAINED_BUCKET,
    AXIOM_STORAGE_ACCESS_KEY_ID: 'synthetic-user',
    AXIOM_STORAGE_SECRET_ACCESS_KEY: 'synthetic-secret',
    AXIOM_REGION: 'ap-south-1',
    ...over,
  })
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

describe('local retained bucket settings', () => {
  it('prefers the host provisioning endpoint and returns the credentials', () => {
    expect(localBucketSettings(env())).toEqual({
      endpoint: 'http://127.0.0.1:9100',
      region: 'ap-south-1',
      accessKeyId: 'synthetic-user',
      secretAccessKey: 'synthetic-secret',
    });
  });
  it.each([
    [{ AXIOM_EVIDENCE_BUCKET: 'evidence-other' }, /dedicated local retained bucket/],
    [{ AXIOM_STORAGE_PROVISION_ENDPOINT: 'https://s3.ap-south-1.amazonaws.com' }, /Local/],
    [{ AXIOM_REGION: 'us-east-1' }, /Local/],
    [{ AXIOM_STORAGE_SECRET_ACCESS_KEY: '' }, /Incomplete/],
  ])('refuses %o', (over, message) => {
    expect(() => localBucketSettings(env(over))).toThrow(message);
  });
  it('refuses malformed lines', () => {
    expect(() => localBucketSettings('not a setting')).toThrow(/Invalid/);
  });
});

function fakeS3(options: { exists: boolean; locked: boolean; headStatus?: number }) {
  const sent: string[] = [];
  const send = vi.fn(async (command: object) => {
    sent.push(command.constructor.name);
    if (command instanceof HeadBucketCommand && !options.exists)
      throw Object.assign(new Error('missing'), {
        $metadata: { httpStatusCode: options.headStatus ?? 404 },
      });
    if (command instanceof CreateBucketCommand) {
      expect(command.input).toEqual({
        Bucket: LOCAL_RETAINED_BUCKET,
        ObjectLockEnabledForBucket: true,
      });
      return {};
    }
    if (command instanceof GetObjectLockConfigurationCommand)
      return {
        ObjectLockConfiguration: options.locked ? { ObjectLockEnabled: 'Enabled' } : {},
      };
    return {};
  });
  return { s3: { send } as never, sent };
}

describe('provisionLocalBucket', () => {
  it('creates the bucket with Object Lock when absent', async () => {
    const f = fakeS3({ exists: false, locked: true });
    await expect(provisionLocalBucket(f.s3)).resolves.toBe('created');
    expect(f.sent).toEqual([
      'HeadBucketCommand',
      'CreateBucketCommand',
      'GetObjectLockConfigurationCommand',
    ]);
  });
  it('is idempotent when the locked bucket already exists', async () => {
    const f = fakeS3({ exists: true, locked: true });
    await expect(provisionLocalBucket(f.s3)).resolves.toBe('already present');
    expect(f.sent).not.toContain('CreateBucketCommand');
  });
  it('refuses an existing bucket without Object Lock', async () => {
    const f = fakeS3({ exists: true, locked: false });
    await expect(provisionLocalBucket(f.s3)).rejects.toThrow(/without Object Lock/);
  });
  it('does not create on an authorization or transport failure', async () => {
    const f = fakeS3({ exists: false, locked: true, headStatus: 403 });
    await expect(provisionLocalBucket(f.s3)).rejects.toThrow('missing');
    expect(f.sent).toEqual(['HeadBucketCommand']);
  });
});
