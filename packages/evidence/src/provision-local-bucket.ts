/** Create the one dedicated local retained-evidence bucket with Object Lock.
 *
 * Owner-authorized (2026-10-17) for the local retained runtime only: objects
 * sealed here carry COMPLIANCE retention (2555 days) and cannot be deleted or
 * shortened by anyone, including the MinIO root user, until it expires. This
 * script therefore refuses any bucket name but the dedicated one and any
 * endpoint that is not this machine. It creates nothing else and never writes
 * an object; idempotent when the bucket already exists with Object Lock on.
 *
 * Usage: pnpm --filter @axiom/evidence exec tsx src/provision-local-bucket.ts <runtime.env>
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CreateBucketCommand,
  GetObjectLockConfigurationCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const LOCAL_RETAINED_BUCKET = 'axiom-proof-local-evidence-retained';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', 'axiom-minio']);

const path = resolve(process.argv[2] ?? '');
const info = statSync(path);
if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error('Private 0600 env file required');
const env = Object.fromEntries(
  readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const index = line.indexOf('=');
      if (index < 1) throw new Error('Invalid private environment');
      return [line.slice(0, index), line.slice(index + 1)];
    }),
);
const endpoint = env.AXIOM_STORAGE_PROVISION_ENDPOINT ?? env.AXIOM_STORAGE_ENDPOINT;
if (!endpoint || !LOOPBACK.has(new URL(endpoint).hostname) || env.AXIOM_REGION !== 'ap-south-1')
  throw new Error('Local Object Lock provider required');
if (env.AXIOM_EVIDENCE_BUCKET !== LOCAL_RETAINED_BUCKET)
  throw new Error(`Only ${LOCAL_RETAINED_BUCKET} is authorized`);
if (!env.AXIOM_STORAGE_ACCESS_KEY_ID || !env.AXIOM_STORAGE_SECRET_ACCESS_KEY)
  throw new Error('Incomplete private environment');

const s3 = new S3Client({
  region: env.AXIOM_REGION,
  endpoint,
  forcePathStyle: true,
  credentials: {
    accessKeyId: env.AXIOM_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.AXIOM_STORAGE_SECRET_ACCESS_KEY,
  },
});
const Bucket = LOCAL_RETAINED_BUCKET;
let exists = true;
try {
  await s3.send(new HeadBucketCommand({ Bucket }));
} catch (error) {
  if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404)
    throw error;
  exists = false;
}
if (!exists) await s3.send(new CreateBucketCommand({ Bucket, ObjectLockEnabledForBucket: true }));
const lock = await s3.send(new GetObjectLockConfigurationCommand({ Bucket }));
if (lock.ObjectLockConfiguration?.ObjectLockEnabled !== 'Enabled')
  throw new Error('Bucket exists without Object Lock; refusing to use it');
console.log(`${Bucket}: ${exists ? 'already present' : 'created'}, Object Lock enabled`);
