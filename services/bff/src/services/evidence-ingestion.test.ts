import { beforeEach, describe, expect, it } from 'vitest';
import {
  EvidenceIngestionService,
  decodeEvidence,
  evidenceUploadSchema,
} from './evidence-ingestion.js';
import {
  evidenceFixture,
  tenant,
  foreign,
  actor,
  upload,
  config,
  dataHash,
  dataBody,
} from '../test/evidence-fixture.js';

let fixture: ReturnType<typeof evidenceFixture>;
let service: EvidenceIngestionService;
beforeEach(() => {
  fixture = evidenceFixture();
  service = new EvidenceIngestionService(fixture.db, fixture.vault, config);
});

describe('human evidence durable ingestion', () => {
  it('commits intent before uploading, pins exact version, and returns only a settled database record', async () => {
    fixture.vault.seal.mockImplementation(async (input) => {
      expect(fixture.rows('evidence_ingestions')).toHaveLength(1);
      expect(fixture.rows('evidence')).toHaveLength(0);
      expect(input).toMatchObject({
        collectedByAgent: 'human',
        tenantId: tenant,
        retainUntil: '2034-01-01T00:00:00.000Z',
      });
      return fixture.verified;
    });
    const result = await service.ingest(tenant, actor, upload);
    expect(result.status).toBe('settled');
    expect(result.evidenceId).toBe(fixture.rows('evidence')[0]?.id);
    expect(fixture.calls.map((c) => c.fn)).toEqual([
      'begin_evidence_ingest',
      'settle_evidence_ingest',
    ]);
    const request = fixture.calls[0]?.args.p_request;
    expect(request).toMatchObject({
      content_hash: dataHash,
      byte_size: dataBody.length,
      collected_by_agent: 'human',
      retention_policy: 'seven_years',
      object_key: `tenants/${tenant}/evidence-ingestions/${upload.operationKey}/${dataHash}`,
    });
    expect(fixture.vault.verifyReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ versionId: 'fixture-version-1', operationId: result.operationId }),
      expect.objectContaining({ maxBytes: 8388608 }),
    );
    expect(fixture.calls[1]?.args.p_receipt).toMatchObject({
      operation_id: result.operationId,
      correlation_id: fixture.calls[0]?.args.p_correlation_id,
      version_id: 'fixture-version-1',
      verified: true,
    });
  });
  it('does not upload before a confirmed durable begin', async () => {
    fixture.faults.begin = true;
    await expect(service.ingest(tenant, actor, upload)).rejects.toMatchObject({
      code: 'ingestion_begin_unavailable',
    });
    expect(fixture.vault.seal).not.toHaveBeenCalled();
  });
  it('replaying an identical operation never uploads twice and changed bytes conflict', async () => {
    const first = await service.ingest(tenant, actor, upload);
    expect(await service.ingest(tenant, actor, upload)).toEqual(first);
    expect(fixture.vault.seal).toHaveBeenCalledTimes(1);
    await expect(
      service.ingest(tenant, actor, {
        ...upload,
        contentBase64: Buffer.from('different').toString('base64'),
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(fixture.vault.seal).toHaveBeenCalledTimes(1);
  });
  it('preserves pending intent after storage failure, sanitizing diagnostics and never deleting an object', async () => {
    fixture.vault.seal.mockRejectedValue(
      new Error('secret token, signed URL, and endpoint should not escape'),
    );
    const result = await service.ingest(tenant, actor, upload);
    expect(result).toMatchObject({
      status: 'pending',
      evidenceId: null,
      errorCode: 'storage_or_settlement_unconfirmed',
    });
    expect(fixture.rows('evidence')).toHaveLength(0);
    expect(fixture.calls.at(-1)?.args.p_error_code).toBe('storage_or_settlement_unconfirmed');
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('keeps begin-committed/no-PUT attempts pending; replay and no-object reconciliation cannot invent success', async () => {
    fixture.vault.seal.mockRejectedValue(new Error('process boundary before provider write'));
    await service.ingest(tenant, actor, upload);
    fixture.vault.findEvidenceVersion.mockResolvedValue(null);
    const replay = await service.ingest(tenant, actor, upload);
    expect(replay.status).toBe('pending');
    const result = await service.reconcile(tenant, actor, upload.operationKey);
    expect(result).toMatchObject({
      status: 'pending',
      evidenceId: null,
      errorCode: 'object_version_not_found',
    });
    expect(fixture.vault.seal).toHaveBeenCalledTimes(1);
    expect(fixture.rows('evidence')).toHaveLength(0);
  });
  it('recovers provider-success/database-failure through read-only discovery of the exact version', async () => {
    fixture.faults.settle = true;
    expect((await service.ingest(tenant, actor, upload)).status).toBe('pending');
    fixture.faults.settle = false;
    const result = await service.reconcile(tenant, actor, upload.operationKey);
    expect(result.status).toBe('settled');
    expect(fixture.vault.seal).toHaveBeenCalledTimes(1);
    expect(fixture.vault.findEvidenceVersion).toHaveBeenCalledWith(
      config.bucket,
      `tenants/${tenant}/evidence-ingestions/${upload.operationKey}/${dataHash}`,
      expect.objectContaining({
        operationId: result.operationId,
        tenantId: tenant,
        contentHash: dataHash,
      }),
      expect.any(Object),
    );
  });
  it('recognizes committed settlement despite a lost response instead of reporting stale pending', async () => {
    fixture.faults.settleResponseLost = true;
    expect((await service.ingest(tenant, actor, upload)).status).toBe('settled');
    expect(fixture.rows('evidence')).toHaveLength(1);
  });
  it('keeps ambiguous provider versions and failed verification pending', async () => {
    fixture.vault.seal.mockRejectedValue(new Error('lost upload reply'));
    await service.ingest(tenant, actor, upload);
    fixture.vault.findEvidenceVersion.mockRejectedValue(new Error('multiple versions'));
    expect((await service.reconcile(tenant, actor, upload.operationKey)).status).toBe('pending');
    expect(fixture.calls.filter((call) => call.fn === 'settle_evidence_ingest')).toHaveLength(0);
  });
  it('refuses cross-tenant operation reads before touching storage', async () => {
    await service.ingest(tenant, actor, upload);
    await expect(service.reconcile(foreign, actor, upload.operationKey)).rejects.toMatchObject({
      code: 'ingestion_not_found',
    });
    expect(fixture.vault.findEvidenceVersion).not.toHaveBeenCalled();
  });
  it('retains pending intent when both storage and failure-note persistence are unavailable', async () => {
    fixture.vault.seal.mockRejectedValue(new Error('offline'));
    fixture.faults.note = true;
    expect((await service.ingest(tenant, actor, upload)).status).toBe('pending');
    expect(fixture.rows('evidence_ingestions')).toHaveLength(1);
  });
  it.each(['', '!!!!', 'YWJj\n', 'Zg=', 'Zh=='])(
    'rejects empty, malformed or noncanonical content %j',
    (contentBase64) => {
      expect(() => decodeEvidence({ ...upload, contentBase64 })).toThrow();
    },
  );
  it('rejects oversized decoded content and unknown endpoint/authority fields', () => {
    expect(() =>
      decodeEvidence({ ...upload, contentBase64: Buffer.alloc(8388609).toString('base64') }),
    ).toThrow();
    for (const extra of [
      { tenantId: foreign },
      { collectedByAgent: 'saakshi' },
      { storageUri: 'https://attacker.invalid' },
      { retainUntil: '2099-01-01' },
    ])
      expect(evidenceUploadSchema.safeParse({ ...upload, ...extra }).success).toBe(false);
  });
});
