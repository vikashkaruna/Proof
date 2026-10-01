/** Synthetic acceptance of the one-version board artifact storage primitive. */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EvidenceVault } from '../packages/evidence/src/index.ts';

const path = resolve(process.argv[2] ?? '.axiom-runtime/evidence-storage/runtime.env');
const env = Object.fromEntries(
  readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const index = line.indexOf('=');
      if (index < 1) throw new Error('Invalid private fixture environment');
      return [line.slice(0, index), line.slice(index + 1)];
    }),
);
const endpoint = env.AXIOM_STORAGE_ENDPOINT;
if (!endpoint || new URL(endpoint).hostname !== '127.0.0.1' || env.AXIOM_REGION !== 'ap-south-1')
  throw new Error('Owned loopback Object Lock fixture required');
if (
  !env.AXIOM_EVIDENCE_BUCKET ||
  !env.AXIOM_STORAGE_ACCESS_KEY_ID ||
  !env.AXIOM_STORAGE_SECRET_ACCESS_KEY
)
  throw new Error('Incomplete private fixture environment');

const vault = new EvidenceVault(env.AXIOM_REGION, endpoint, {
  accessKeyId: env.AXIOM_STORAGE_ACCESS_KEY_ID,
  secretAccessKey: env.AXIOM_STORAGE_SECRET_ACCESS_KEY,
});
const tenantId = '11111111-1111-4111-8111-111111111111';
const operationId = randomUUID();
const body = Buffer.from(`Synthetic board artifact conditional PUT ${operationId}\n`);
const key = `tenants/${tenantId}/reports/synthetic/${operationId}/source_json/${createHash('sha256').update(body).digest('hex')}`;
const input = {
  bucket: env.AXIOM_EVIDENCE_BUCKET,
  key,
  body,
  contentType: 'application/json',
  retentionDays: 2555,
  tenantId,
  collectedByAgent: 'board-report-builder',
  operationId,
  createOnly: true,
};
try {
  const first = await vault.seal(input, { maxBytes: 4 * 1024 * 1024 });
  let secondRefused = false;
  try {
    await vault.seal(input, { maxBytes: 4 * 1024 * 1024 });
  } catch {
    secondRefused = true;
  }
  const verifier = new EvidenceVault(env.AXIOM_REGION, endpoint, {
    accessKeyId: env.AXIOM_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.AXIOM_STORAGE_SECRET_ACCESS_KEY,
  });
  let recovered: { versionId: string } | null;
  try {
    recovered = await verifier.findEvidenceVersion(
      input.bucket,
      key,
      {
        tenantId,
        contentHash: createHash('sha256').update(body).digest('hex'),
        byteSize: body.length,
        operationId,
        collectedByAgent: 'board-report-builder',
      },
      { maxBytes: 4 * 1024 * 1024 },
    );
  } finally {
    verifier.close();
  }
  if (
    first.retentionAssurance !== 'verified' ||
    first.lockMode !== 'COMPLIANCE' ||
    !secondRefused ||
    recovered?.versionId !== first.versionId
  )
    throw new Error('Board Object Lock conditional-version acceptance failed');
  console.log('Board Object Lock conditional-version acceptance passed');
} finally {
  vault.close();
}
