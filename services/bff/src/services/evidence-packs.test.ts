import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { packFixture } from '../test/evidence-pack-fixture.js';
import { tenant, config } from '../test/evidence-fixture.js';
import { publicPack } from './evidence-pack-records.js';

let fixture: Awaited<ReturnType<typeof packFixture>>;
beforeEach(async () => {
  fixture = await packFixture();
});
describe('persisted evidence pack assembly boundaries', () => {
  it('cancels a stalled database intent before releasing bounded assembly capacity', async () => {
    const pack = await fixture.approve();
    const access = await fixture.service.access(tenant, fixture.owner);
    const abort = new AbortController();
    fixture.faults.stallBegin = true;
    const work = fixture.service.build(access, pack.pack.id, randomUUID(), abort.signal);
    const refused = expect(work).rejects.toMatchObject({ code: 'pack_deadline_exceeded' });
    await vi.waitFor(() =>
      expect(fixture.calls.some((c) => c.fn === 'begin_evidence_pack_build')).toBe(true),
    );
    await expect(fixture.service.prepare(access, fixture.input)).rejects.toMatchObject({
      code: 'pack_capacity_unavailable',
    });
    abort.abort();
    await refused;
    expect(fixture.base.vault.seal).not.toHaveBeenCalled();
    fixture.faults.stallBegin = false;
    expect((await fixture.prepare()).pack.id).toBe(pack.pack.id);
  });
  it('verifies provider members before asking SQL to freeze its own manifest', async () => {
    const pack = await fixture.prepare();
    expect(fixture.base.vault.verifyReceipt).toHaveBeenCalledOnce();
    expect(fixture.calls[0]).toMatchObject({
      fn: 'prepare_evidence_pack',
      args: {
        p_actor_id: fixture.owner,
        p_library_version: null,
        p_evidence_version_ids: fixture.input.evidenceReceiptIds,
      },
    });
    expect(fixture.base.vault.seal).not.toHaveBeenCalled();
    expect(publicPack(pack)).toMatchObject({ status: 'draft', archive: null, build: null });
    expect(JSON.stringify(publicPack(pack))).not.toContain(config.bucket);
  });
  it('refuses unsupported provenance and missing legacy receipts before provider IO', async () => {
    fixture.base.rows('evidence')[0]!.collected_by_agent = 'saakshi';
    await expect(fixture.prepare()).rejects.toMatchObject({ code: 'provenance_unavailable' });
    fixture.base.rows('evidence_object_versions').splice(0);
    await expect(fixture.prepare()).rejects.toMatchObject({ code: 'evidence_version_unavailable' });
    expect(fixture.base.vault.verifyReceipt).not.toHaveBeenCalled();
    expect(fixture.calls).toHaveLength(0);
  });
  it('refuses foreign provider settings and an aborted aggregate budget', async () => {
    fixture.base.rows('evidence_object_versions')[0]!.bucket = 'foreign-bucket';
    await expect(fixture.prepare()).rejects.toMatchObject({
      code: 'storage_configuration_changed',
    });
    fixture.base.rows('evidence_object_versions')[0]!.bucket = config.bucket;
    await expect(
      fixture.service.prepare(
        await fixture.service.access(tenant, fixture.owner),
        fixture.input,
        AbortSignal.abort(),
      ),
    ).rejects.toMatchObject({ code: 'pack_deadline_exceeded' });
    expect(fixture.base.vault.verifyReceipt).not.toHaveBeenCalled();
  });
  it('refuses oversized aggregate metadata before allocating or reading member bytes', async () => {
    const receipt = fixture.base.rows('evidence_object_versions')[0]!;
    const ids = Array.from({ length: 7 }, () => {
      const id = randomUUID();
      fixture.base
        .rows('evidence_object_versions')
        .push({ ...receipt, id, byte_size: 8 * 1024 * 1024 });
      return id;
    });
    await expect(
      fixture.service.members(await fixture.service.access(tenant, fixture.owner), ids),
    ).rejects.toMatchObject({ code: 'pack_size_exceeded' });
    expect(fixture.base.vault.verifyReceipt).not.toHaveBeenCalled();
  });
  it('requires approval and a durable build intent before the first archive PUT', async () => {
    const pack = await fixture.prepare();
    const access = await fixture.service.access(tenant, fixture.owner);
    await expect(fixture.service.build(access, pack.pack.id, randomUUID())).rejects.toMatchObject({
      code: 'not_approved',
    });
    await fixture.service.rpc('review_report', {
      p_report_id: pack.report.id,
      p_expected_content_hash: pack.pack.manifest_sha256,
      p_decision: 'approved',
    });
    fixture.faults.begin = true;
    await expect(fixture.service.build(access, pack.pack.id, randomUUID())).rejects.toMatchObject({
      code: 'report_persistence_unconfirmed',
    });
    expect(fixture.base.vault.seal).not.toHaveBeenCalled();
    expect(fixture.base.rows('evidence_pack_archives')).toHaveLength(0);
  });
  it('settles exact archive bytes once and never uploads again on stable-key replay', async () => {
    const pack = await fixture.approve();
    const access = await fixture.service.access(tenant, fixture.owner);
    const key = randomUUID();
    const built = await fixture.service.build(access, pack.pack.id, key);
    expect(built.build?.status).toBe('settled');
    expect(built.archive?.version_id).toBe('archive-version');
    expect(fixture.base.vault.seal).toHaveBeenCalledOnce();
    expect(fixture.base.vault.seal).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: built.build!.id,
        retainUntil: built.build!.retain_until,
        contentType: 'application/zip',
      }),
      expect.objectContaining({ maxBytes: 64 * 1024 * 1024, signal: expect.any(AbortSignal) }),
    );
    const replay = await fixture.service.build(access, pack.pack.id, key);
    expect(replay.archive?.id).toBe(built.archive?.id);
    expect(fixture.base.vault.seal).toHaveBeenCalledOnce();
    await expect(fixture.service.build(access, pack.pack.id, randomUUID())).rejects.toMatchObject({
      code: 'build_already_started',
    });
    expect(fixture.base.rows('evidence')).toHaveLength(1); // Archive never enters the ordinary evidence export path.
  });
  it('preserves pending settlement and reconciles exact stored version without another PUT', async () => {
    const pack = await fixture.approve();
    const access = await fixture.service.access(tenant, fixture.owner);
    const key = randomUUID();
    fixture.faults.settle = true;
    const pending = await fixture.service.build(access, pack.pack.id, key);
    expect(pending.build).toMatchObject({
      status: 'pending',
      last_error_code: 'storage_or_settlement_unconfirmed',
    });
    expect(pending.archive).toBeNull();
    fixture.faults.settle = false;
    const settled = await fixture.service.reconcile(access, pack.pack.id, key);
    expect(settled.build?.status).toBe('settled');
    expect(fixture.base.vault.seal).toHaveBeenCalledOnce();
  });
  it('reports actual committed settlement after a lost settlement response', async () => {
    const pack = await fixture.approve();
    fixture.faults.settleResponseLost = true;
    const result = await fixture.service.build(
      await fixture.service.access(tenant, fixture.owner),
      pack.pack.id,
      randomUUID(),
    );
    expect(result.build?.status).toBe('settled');
    expect(result.archive).not.toBeNull();
  });
  it('leaves begin-without-object pending and never pretends read-only reconcile can upload', async () => {
    const pack = await fixture.approve();
    const access = await fixture.service.access(tenant, fixture.owner);
    const key = randomUUID();
    fixture.base.vault.seal.mockRejectedValue(new Error('provider unavailable'));
    await fixture.service.build(access, pack.pack.id, key);
    fixture.base.vault.findEvidenceVersion.mockResolvedValue(null);
    const pending = await fixture.service.reconcile(access, pack.pack.id, key);
    expect(pending.build).toMatchObject({
      status: 'pending',
      last_error_code: 'object_version_not_found',
    });
    expect(fixture.base.vault.seal).toHaveBeenCalledOnce();
    expect(pending.archive).toBeNull();
  });
  it('refuses unreleased content and returns exact stored bytes only after digest-bound release', async () => {
    const pack = await fixture.approve();
    const access = await fixture.service.access(tenant, fixture.owner);
    const built = await fixture.service.build(access, pack.pack.id, randomUUID());
    await expect(fixture.service.content(access, pack.pack.id)).rejects.toMatchObject({
      code: 'pack_not_released',
    });
    await fixture.service.rpc('release_report', {
      p_report_id: pack.report.id,
      p_expected_content_hash: pack.pack.manifest_sha256,
      p_expected_archive_hash: built.archive!.content_hash,
    });
    const content = await fixture.service.content(access, pack.pack.id);
    expect(content.body.equals(fixture.storedArchive()!)).toBe(true);
    expect(content.hash).toBe(built.archive!.content_hash);
    fixture.base.vault.retrieve.mockResolvedValueOnce({
      body: Buffer.from('tampered'),
      contentHash: 'a'.repeat(64),
      metadata: {},
      contentType: 'application/zip',
      versionId: 'archive-version',
      encryption: 'AES256',
      retainUntil: undefined,
      lockMode: undefined,
    });
    await expect(fixture.service.content(access, pack.pack.id)).rejects.toMatchObject({
      code: 'provider_verification_failed',
    });
  });
  it('rechecks export authority after provider readback before serving bytes', async () => {
    const pack = await fixture.approve();
    const access = await fixture.service.access(tenant, fixture.owner);
    const built = await fixture.service.build(access, pack.pack.id, randomUUID());
    await fixture.service.rpc('release_report', {
      p_report_id: pack.report.id,
      p_expected_content_hash: pack.pack.manifest_sha256,
      p_expected_archive_hash: built.archive!.content_hash,
    });
    const normal = fixture.base.vault.retrieve.getMockImplementation()!;
    fixture.base.vault.retrieve.mockImplementationOnce(async (...args) => {
      const result = await normal(...args);
      fixture.base.rows('tenant_users').find((r) => r.user_id === fixture.owner)!.role = 'viewer';
      return result;
    });
    await expect(fixture.service.content(access, pack.pack.id)).rejects.toMatchObject({
      code: 'forbidden',
      status: 403,
    });
  });
});
