import { createHash, createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalEngine } from '@axiom/approval-engine';
import { abortableResult } from '../test/abortable-result.js';
import { evidenceFixture, tenant, actor, operationKey, config } from '../test/evidence-fixture.js';
import { ApprovalProofArchiveService } from './approval-proof-archive.js';

const key = 'archive-test-signing-key-0123456789';
const h = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function setup() {
  const f = evidenceFixture();
  const engine = new ApprovalEngine(Buffer.from(key));
  const tokenId = randomUUID();
  const planId = randomUUID();
  const actionId = randomUUID();
  const batchId = randomUUID();
  const reconciliationId = randomUUID();
  f.rows('tenant_users').push({ tenant_id: tenant, user_id: actor, role: 'founder' });
  f.rows('users').push({ id: actor, is_axiom_internal: true });
  const spec = {
    planId,
    actionIds: [actionId],
    approverId: actor,
    mode: 'individual' as const,
    concurrency: 1,
    stopOnFailure: true,
    expiresAt: '2030-01-01T00:00:00.000Z',
    nonce: 'nonce-test',
    contentDigest: 'a'.repeat(64),
  };
  const statement = JSON.stringify({
    schema_version: 2,
    tenant_id: tenant,
    plan_id: planId,
    batch_id: batchId,
    token_id: tokenId,
    approved_content_digest: spec.contentDigest,
  });
  const source = {
    schema_version: 1,
    kind: 'approval_proof_source',
    tenant_id: tenant,
    plan_id: planId,
    token: {
      id: tokenId,
      approver_id: actor,
      action_ids: [actionId],
      signed_payload: spec,
      signature: await engine.sign(tenant, spec),
    },
    execution: { id: batchId, content_digest: spec.contentDigest },
    reconciliation: {
      id: reconciliationId,
      statement,
      signature: createHmac('sha256', key).update(statement).digest('hex'),
      approved_scope: { token_id: tokenId, content_digest: spec.contentDigest },
    },
  };
  const sourceText = JSON.stringify(source);
  const sourceSha256 = h(sourceText);
  const archiveId = randomUUID();
  const retainUntil = '2035-01-01T00:00:00.000Z';
  const versionId = 'version-immutable-1';
  let beginCalls = 0;
  f.db.rpc = ((name: string, args: Record<string, unknown>) => {
    if (name === 'prepare_approval_proof_source')
      return abortableResult(
        Promise.resolve({
          data: { sourceText, sourceSha256, sourceBytes: Buffer.byteLength(sourceText) },
          error: null,
        }),
      );
    if (name === 'begin_approval_proof_archive') {
      beginCalls++;
      if (!f.rows('approval_proof_archives').length)
        f.rows('approval_proof_archives').push({
          id: archiveId,
          tenant_id: tenant,
          token_id: tokenId,
          plan_id: planId,
          batch_id: batchId,
          reconciliation_id: reconciliationId,
          operation_key: operationKey,
          actor_id: actor,
          source_text: sourceText,
          source_sha256: sourceSha256,
          source_bytes: Buffer.byteLength(sourceText),
          provider: config.provider,
          bucket: config.bucket,
          object_key: args.p_object_key,
          retain_until: retainUntil,
          status: 'pending',
        });
      return abortableResult(
        Promise.resolve({
          data: {
            archiveId,
            status: 'pending',
            sourceText,
            sourceSha256,
            sourceBytes: Buffer.byteLength(sourceText),
            retainUntil,
            replayed: beginCalls > 1,
          },
          error: null,
        }),
      );
    }
    if (name === 'settle_approval_proof_archive') {
      f.rows('approval_proof_archives')[0]!.status = 'settled';
      f.rows('approval_proof_versions').push({
        archive_id: archiveId,
        tenant_id: tenant,
        version_id: versionId,
        content_hash: sourceSha256,
        byte_size: Buffer.byteLength(sourceText),
        retain_until: retainUntil,
        legal_hold: false,
        encryption: 'AES256',
      });
      return abortableResult(
        Promise.resolve({ data: { archiveId, status: 'settled', versionId }, error: null }),
      );
    }
    if (name === 'release_approval_proof_archive') {
      if (!f.rows('approval_proof_reviews').length)
        return abortableResult(
          Promise.resolve({ data: { error: 'founder_review_required' }, error: null }),
        );
      f.rows('approval_proof_archives')[0]!.status = 'released';
      return abortableResult(
        Promise.resolve({
          data: { archiveId, status: 'released', sourceSha256, versionId },
          error: null,
        }),
      );
    }
    if (name === 'review_approval_proof_archive') {
      f.rows('approval_proof_reviews').push({
        tenant_id: tenant,
        archive_id: archiveId,
        reviewed_by: actor,
        source_sha256: sourceSha256,
        version_id: versionId,
      });
      return abortableResult(
        Promise.resolve({
          data: { archiveId, sourceSha256, versionId, reviewedBy: actor, replayed: false },
          error: null,
        }),
      );
    }
    throw new Error(`Unexpected RPC: ${name}`);
  }) as never;
  f.vault.seal.mockResolvedValue(f.verified);
  f.vault.findEvidenceVersion.mockResolvedValue({ versionId });
  f.vault.verifyReceipt.mockResolvedValue({
    ...f.verified,
    contentHash: sourceSha256,
    byteSize: Buffer.byteLength(sourceText),
    versionId,
    retainUntil,
  });
  f.vault.retrieve.mockResolvedValue({
    body: Buffer.from(sourceText),
    contentHash: sourceSha256,
    metadata: {},
    contentType: 'application/json',
    versionId,
  } as never);
  const service = new ApprovalProofArchiveService(f.db, engine, () => ({ vault: f.vault, config }));
  return { f, service, source, sourceText, sourceSha256, archiveId, tokenId, versionId };
}

describe('approval proof archive', () => {
  it('retains exact source, releases only after provider receipt, and downloads that version', async () => {
    const { f, service, archiveId, tokenId, sourceSha256, sourceText, versionId } = await setup();
    const started = await service.start(tenant, actor, tokenId, operationKey);
    expect(started).toMatchObject({ archiveId, status: 'settled', sourceSha256, versionId });
    expect(f.vault.seal).toHaveBeenCalledWith(
      expect.objectContaining({
        createOnly: true,
        operationId: archiveId,
        body: Buffer.from(sourceText),
      }),
      expect.any(Object),
    );
    await expect(service.release(tenant, actor, archiveId)).rejects.toMatchObject({
      code: 'founder_review_required',
    });
    const preview = await service.preview(tenant, actor, archiveId);
    expect(preview).toEqual({ sourceText, sourceSha256, versionId });
    await expect(
      service.review(tenant, actor, archiveId, 'f'.repeat(64), versionId),
    ).rejects.toMatchObject({ code: 'approval_archive_version_mismatch' });
    expect(await service.review(tenant, actor, archiveId, sourceSha256, versionId)).toMatchObject({
      reviewed: true,
      sourceSha256,
      versionId,
    });
    const released = await service.release(tenant, actor, archiveId);
    expect(released.status).toBe('released');
    const downloaded = await service.download(tenant, actor, archiveId);
    expect(downloaded.bytes.toString()).toBe(sourceText);
    expect(downloaded.versionId).toBe(versionId);
    expect(await service.statusForToken(tenant, actor, tokenId)).toMatchObject({
      archiveId,
      status: 'released',
      versionId,
    });
  });

  it('does not expose a pending archive to an owner before founder release', async () => {
    const { f, service, tokenId } = await setup();
    f.vault.seal.mockRejectedValueOnce(new Error('response lost'));
    await expect(service.start(tenant, actor, tokenId, operationKey)).rejects.toMatchObject({
      code: 'approval_archive_pending_reconciliation',
    });
    const owner = randomUUID();
    f.rows('tenant_users').push({ tenant_id: tenant, user_id: owner, role: 'owner' });
    await expect(service.statusForToken(tenant, owner, tokenId)).rejects.toMatchObject({
      code: 'approval_archive_forbidden',
    });
  });

  it('refuses founder review when exact retained bytes differ from the frozen source', async () => {
    const { f, service, tokenId, archiveId, sourceSha256, versionId } = await setup();
    await service.start(tenant, actor, tokenId, operationKey);
    f.vault.retrieve.mockResolvedValueOnce({
      body: Buffer.from('substituted'),
      contentHash: sourceSha256,
      versionId,
    } as never);
    await expect(
      service.review(tenant, actor, archiveId, sourceSha256, versionId),
    ).rejects.toMatchObject({ code: 'approval_archive_version_invalid' });
    expect(f.rows('approval_proof_reviews')).toHaveLength(0);
  });

  it('refuses a mismatched signature before archive intent or provider PUT', async () => {
    const { f, service, source, tokenId } = await setup();
    source.token.signature = 'b'.repeat(64);
    const sourceText = JSON.stringify(source);
    f.db.rpc = ((name: string) => {
      if (name !== 'prepare_approval_proof_source') throw new Error('Unexpected write');
      return abortableResult(
        Promise.resolve({
          data: {
            sourceText,
            sourceSha256: h(sourceText),
            sourceBytes: Buffer.byteLength(sourceText),
          },
          error: null,
        }),
      );
    }) as never;
    await expect(service.start(tenant, actor, tokenId, operationKey)).rejects.toMatchObject({
      code: 'approval_archive_signature_invalid',
    });
    expect(f.vault.seal).not.toHaveBeenCalled();
  });

  it('refuses a forged reconciliation statement even when the token signature is valid', async () => {
    const { f, service, source, tokenId } = await setup();
    source.reconciliation.signature = 'c'.repeat(64);
    const sourceText = JSON.stringify(source);
    f.db.rpc = ((name: string) => {
      if (name !== 'prepare_approval_proof_source') throw new Error('Unexpected write');
      return abortableResult(
        Promise.resolve({
          data: {
            sourceText,
            sourceSha256: h(sourceText),
            sourceBytes: Buffer.byteLength(sourceText),
          },
          error: null,
        }),
      );
    }) as never;
    await expect(service.start(tenant, actor, tokenId, operationKey)).rejects.toMatchObject({
      code: 'approval_archive_signature_invalid',
    });
    expect(f.vault.seal).not.toHaveBeenCalled();
  });

  it('keeps an uncertain PUT pending and never auto-repeats it on an idempotent start', async () => {
    const { f, service, tokenId } = await setup();
    f.vault.seal.mockRejectedValueOnce(new Error('response lost'));
    await expect(service.start(tenant, actor, tokenId, operationKey)).rejects.toMatchObject({
      code: 'approval_archive_pending_reconciliation',
    });
    expect((await service.start(tenant, actor, tokenId, operationKey)).status).toBe('pending');
    expect(f.vault.seal).toHaveBeenCalledTimes(1);
  });

  it('refuses a demoted founder on live authority recheck', async () => {
    const { f, service, tokenId } = await setup();
    f.rows('tenant_users')[0]!.role = 'viewer';
    await expect(service.start(tenant, actor, tokenId, operationKey)).rejects.toMatchObject({
      code: 'approval_archive_forbidden',
    });
    expect(f.vault.seal).not.toHaveBeenCalled();
  });
});
