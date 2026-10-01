import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  S3Client,
  CreateBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectLegalHoldCommand,
  PutObjectRetentionCommand,
} from '@aws-sdk/client-s3';

const vault = vi.hoisted(() => ({
  seal: vi.fn(),
  findEvidenceVersion: vi.fn(),
  verifyReceipt: vi.fn(),
  retrieve: vi.fn(),
  verifyIntegrity: vi.fn(),
  close: vi.fn(),
}));
vi.mock('./index', () => ({
  EvidenceVault: class {
    seal = vault.seal;
    findEvidenceVersion = vault.findEvidenceVersion;
    verifyReceipt = vault.verifyReceipt;
    retrieve = vault.retrieve;
    verifyIntegrity = vault.verifyIntegrity;
    close = vault.close;
  },
}));

const original = Buffer.from('synthetic-first-version; no customer personal data');
const receipt = {
  bucket: 'synthetic-evidence',
  key: 'synthetic/operation/proof',
  versionId: 'v1',
  encryption: 'AES256',
  lockMode: 'COMPLIANCE',
  retentionAssurance: 'verified',
  tenantId: 'synthetic-tenant',
  collectedByAgent: 'human',
  operationId: 'fixture-operation',
};
const denied = () => Object.assign(new Error('retained'), { $metadata: { httpStatusCode: 403 } });
const sendClient = S3Client.prototype as unknown as { send(command: unknown): Promise<unknown> };

function provider() {
  let findCount = 0;
  const send = vi.spyOn(sendClient, 'send').mockImplementation(async (command) => {
    if (command instanceof DeleteObjectCommand || command instanceof PutObjectRetentionCommand)
      throw denied();
    if (command instanceof ListObjectsV2Command) return { KeyCount: 0 };
    if (command instanceof CreateBucketCommand || command instanceof PutObjectLegalHoldCommand)
      return {};
    throw new Error('unexpected provider command');
  });
  vault.seal.mockImplementation(
    async (input: { bucket: string; key: string; legalHold?: boolean }) => {
      if (input.bucket.endsWith('-unlocked')) throw new Error('Object Lock required');
      if (input.legalHold)
        return { ...receipt, key: input.key, versionId: 'hold-v1', legalHold: true };
      if (input.key === receipt.key && vault.seal.mock.calls.length > 1)
        return { ...receipt, versionId: 'v2' };
      return receipt;
    },
  );
  vault.findEvidenceVersion.mockImplementation(async () => {
    findCount++;
    if (findCount === 2) throw new Error('Ambiguous retained versions');
    return receipt;
  });
  vault.verifyReceipt.mockImplementation(
    async (input: { tenantId: string; legalHold?: boolean }) => {
      if (input.tenantId !== receipt.tenantId) throw new Error('metadata mismatch');
      if (input.legalHold) throw new Error('legal hold mismatch');
      return receipt;
    },
  );
  vault.retrieve.mockImplementation(
    async (_bucket: string, _key: string, version: string, options?: { maxBytes?: number }) => {
      if (version !== 'v1') throw new Error('missing version');
      if (options?.maxBytes === 1) throw new Error('byte limit');
      return { body: original };
    },
  );
  vault.verifyIntegrity.mockImplementation(
    async (_bucket: string, _key: string, _version: string, hash: string) => ({
      ok: hash !== '0'.repeat(64),
    }),
  );
  return send;
}

async function run(configPath: string, phase: string) {
  vi.resetModules();
  process.argv = ['node', 'storage-acceptance.ts', configPath, phase];
  await import('./storage-acceptance');
}

const previousArgv = process.argv;
const previousExitCode = process.exitCode;
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  process.argv = previousArgv;
  process.exitCode = previousExitCode;
});

describe('isolated storage acceptance script', () => {
  it('proves exact retained version, tamper refusals, restart, and provider outage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'axiom-evidence-acceptance-'));
    const configPath = join(dir, 'config.json');
    const resultPath = join(dir, 'result.json');
    const privateStatePath = join(dir, 'state.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        endpoint: 'http://127.0.0.1:9000',
        accessKeyId: 'test-user',
        secretAccessKey: 'test-private',
        bucket: receipt.bucket,
        privateStatePath,
        resultPath,
      }),
    );
    try {
      const send = provider();
      await run(configPath, 'initial');
      const initial = JSON.parse(readFileSync(resultPath, 'utf8')) as {
        status: string;
        outcomes: string[];
      };
      expect(initial.status).toBe('passed');
      expect(initial.outcomes).toContain('root-exact-version-delete-denied-by-local-provider');
      expect(initial.outcomes).toContain('multiple-version-recovery-refuses-ambiguity');
      expect(initial.outcomes).toContain('unlocked-bucket-refused-before-upload');
      expect(send.mock.calls.some(([command]) => command instanceof DeleteObjectCommand)).toBe(
        true,
      );
      expect(JSON.parse(readFileSync(privateStatePath, 'utf8'))).toMatchObject({ versionId: 'v1' });
      expect(vault.close).toHaveBeenCalledOnce();

      vi.clearAllMocks();
      provider();
      await run(configPath, 'restart');
      expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toMatchObject({
        status: 'passed',
        outcomes: ['persistent-volume-restart-preserves-exact-version-encryption-and-retention'],
      });

      vi.clearAllMocks();
      provider();
      vault.retrieve.mockRejectedValue(new Error('provider unavailable'));
      await run(configPath, 'unavailable');
      expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toMatchObject({
        status: 'passed',
        outcomes: ['unavailable-provider-refuses-within-deadline'],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a non-loopback provider before sending evidence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'axiom-evidence-acceptance-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ endpoint: 'http://example.com' }));
    try {
      await expect(run(configPath, 'initial')).rejects.toThrow('isolated loopback');
      expect(vault.seal).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
