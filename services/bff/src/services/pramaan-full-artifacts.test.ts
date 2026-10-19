import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  fullClosureFixture,
  fullClosureSha as sha,
} from '@axiom/report-kit/test-fixtures/full-closure';
import { PramaanFullArtifactService } from './pramaan-full-artifacts.js';
import type { EvidenceDatabase } from './evidence-ingestion.js';
import { evidenceFixture, config } from '../test/evidence-fixture.js';
import { abortableResult } from '../test/abortable-result.js';
function setup() {
  const fixture = evidenceFixture(),
    f = fullClosureFixture(),
    manager = randomUUID(),
    founder = randomUUID(),
    viewer = randomUUID();
  for (const component of f.source.components) component.bucket = config.bucket;
  f.sourceText = JSON.stringify(f.source);
  f.sourceSha256 = sha(f.sourceText);
  for (const [user, role] of [
    [manager, 'admin'],
    [founder, 'founder'],
    [viewer, 'viewer'],
  ]) {
    fixture.rows('tenant_users').push({ tenant_id: f.tenantId, user_id: user, role });
    fixture.rows('users').push({ id: user, is_axiom_internal: user === founder });
  }
  const calls: string[] = [],
    faults = { put: false, lookup: false, source: false };
  let archived: Buffer | null = null;
  fixture.vault.verifyReceipt.mockImplementation(async (expected) => ({
    ...fixture.verified,
    ...expected,
    key: expected.key,
    versionId: expected.versionId,
    readbackAt: new Date().toISOString(),
    retainUntil: expected.retainUntil,
    encryption: expected.encryption ?? 'AES256',
  }));
  fixture.vault.retrieve.mockImplementation(async (_bucket, key, versionId) => {
    const component = f.source.components.find((c) => c.object_key === key);
    const bytes = component ? f.members.find((m) => m.id === component.id)!.bytes : archived;
    if (!bytes) throw Error('synthetic missing');
    return {
      body: Buffer.from(bytes) as Buffer<ArrayBuffer>,
      contentHash: sha(bytes),
      metadata: {},
      contentType: 'application/octet-stream',
      retainUntil: new Date('2034-01-01T00:00:00Z'),
      lockMode: 'COMPLIANCE',
      versionId,
      encryption: 'AES256',
    };
  });
  fixture.vault.seal.mockImplementation(async (input) => {
    archived = Buffer.from(input.body);
    if (faults.put) throw Error('unknown provider outcome');
    return {
      ...fixture.verified,
      bucket: input.bucket,
      key: input.key,
      versionId: 'full-version',
      contentHash: sha(archived),
      byteSize: archived.length,
      retainUntil: input.retainUntil!,
      readbackAt: new Date().toISOString(),
    };
  });
  fixture.vault.findEvidenceVersion.mockImplementation(async () => {
    if (faults.lookup) throw Error('lookup unavailable');
    return archived ? { versionId: 'full-version' } : null;
  });
  const result = (data: Record<string, unknown>) =>
    abortableResult(Promise.resolve({ data, error: null }));
  const writer = {
    ...fixture.db,
    rpc: ((name: string, args: Record<string, unknown>) => {
      calls.push(name);
      if (name === 'begin_full_pramaan') {
        const old = fixture
          .rows('pramaan_full_builds')
          .find((b) => b.operation_key === args.p_operation_key);
        if (old) return result({ dossierId: old.dossier_id, replayed: true });
        const dossierId = randomUUID(),
          buildId = randomUUID(),
          request = args.p_request as Record<string, unknown>;
        fixture.rows('pramaan_dossiers').push({
          id: dossierId,
          tenant_id: f.tenantId,
          engagement_id: f.engagementId,
          report_id: f.reportId,
          title: args.p_title,
          status: 'draft',
          proof_seal_hash: 'a'.repeat(64),
        });
        fixture.rows('pramaan_full_builds').push({
          id: buildId,
          tenant_id: f.tenantId,
          dossier_id: dossierId,
          report_id: f.reportId,
          operation_key: args.p_operation_key,
          requested_by: args.p_actor_id,
          request,
          source_text: args.p_source_text,
          source_sha256: request.source_sha256,
          retain_until: '2034-01-01T00:00:00.000Z',
          correlation_id: args.p_correlation_id,
          status: 'pending',
          created_at: new Date().toISOString(),
        });
        return result({ dossierId, buildId, status: 'pending', replayed: false });
      }
      if (name === 'settle_full_pramaan') {
        const b = fixture.rows('pramaan_full_builds')[0]!,
          r = args.p_receipt as Record<string, unknown>;
        fixture.rows('pramaan_full_archives').push({
          id: randomUUID(),
          tenant_id: f.tenantId,
          dossier_id: b.dossier_id,
          build_id: b.id,
          ...r,
        });
        b.status = 'settled';
        return result({ status: 'settled' });
      }
      if (name === 'note_full_pramaan_failure') return result({ status: 'pending' });
      if (name === 'review_full_pramaan') return result({ status: 'approved' });
      if (name === 'seal_full_pramaan') return result({ status: 'sealed' });
      if (name === 'release_full_pramaan') {
        fixture.rows('pramaan_full_releases').push({
          tenant_id: f.tenantId,
          dossier_id: args.p_dossier_id,
          archive_sha256: args.p_expected_archive,
          archive_version_id: args.p_expected_version,
        });
        return result({ status: 'released' });
      }
      throw Error(`Unexpected mutation ${name}`);
    }) as unknown as EvidenceDatabase['rpc'],
  };
  const reader = {
    ...fixture.db,
    rpc: ((name: string) => {
      expect(name).toBe('read_full_closure_source');
      if (faults.source)
        return abortableResult(
          Promise.resolve({
            data: null,
            error: { code: '23514', message: 'released_approval_proof_required' },
          }),
        );
      return result({ sourceText: f.sourceText, sourceSha256: f.sourceSha256 });
    }) as unknown as EvidenceDatabase['rpc'],
  };
  const service = new PramaanFullArtifactService(
    reader,
    () => ({ vault: fixture.vault, config }),
    () => writer,
  );
  const input = {
    engagementId: f.engagementId,
    reportId: f.reportId,
    dossierType: 'full_closure',
    title: f.title,
    operationKey: randomUUID(),
  };
  return {
    fixture,
    f,
    manager,
    founder,
    viewer,
    calls,
    faults,
    service,
    input,
    forgetArchive: () => {
      archived = null;
    },
  };
}
describe('full closure custody transport', () => {
  it('verifies every exact component, writes once, settles and requires release before download', async () => {
    const x = setup(),
      built = await x.service.create(x.f.tenantId, x.manager, x.input),
      id = built.dossierId;
    expect(built.status).toBe('settled');
    expect(x.fixture.vault.seal).toHaveBeenCalledTimes(1);
    for (const c of x.f.source.components)
      expect(x.fixture.vault.retrieve).toHaveBeenCalledWith(
        c.bucket,
        c.object_key,
        c.version_id,
        expect.any(Object),
      );
    await expect(x.service.archive(x.f.tenantId, x.founder, id)).rejects.toMatchObject({
      code: 'full_closure_release_required',
    });
    const preview = await x.service.preview(x.f.tenantId, x.founder, id);
    const exact = { expectedArchiveSha256: preview.sha256, expectedVersionId: 'full-version' };
    await x.service.review(x.f.tenantId, x.founder, id, {
      ...exact,
      note: 'Reviewed exact archive',
    });
    await x.service.seal(x.f.tenantId, x.founder, id, 'a'.repeat(64));
    await x.service.release(x.f.tenantId, x.founder, id, exact);
    expect((await x.service.archive(x.f.tenantId, x.founder, id)).sha256).toBe(preview.sha256);
    expect(x.calls).toEqual([
      'begin_full_pramaan',
      'settle_full_pramaan',
      'review_full_pramaan',
      'seal_full_pramaan',
      'release_full_pramaan',
    ]);
  });
  it('keeps an ambiguous PUT pending and reconciles the exact version without another PUT', async () => {
    const x = setup();
    x.faults.put = true;
    const b = await x.service.create(x.f.tenantId, x.manager, x.input);
    expect(b.status).toBe('pending');
    x.faults.put = false;
    expect(
      (await x.service.reconcile(x.f.tenantId, x.manager, b.dossierId, x.input.operationKey))
        .status,
    ).toBe('settled');
    expect(x.fixture.vault.seal).toHaveBeenCalledTimes(1);
  });
  it('never retries provider lookup uncertainty; only founder retries confirmed absence', async () => {
    const x = setup();
    x.faults.put = true;
    const b = await x.service.create(x.f.tenantId, x.manager, x.input);
    x.forgetArchive();
    x.faults.put = false;
    x.faults.lookup = true;
    expect(
      (await x.service.retryMissing(x.f.tenantId, x.founder, b.dossierId, x.input.operationKey))
        .status,
    ).toBe('pending');
    expect(x.fixture.vault.seal).toHaveBeenCalledTimes(1);
    await expect(
      x.service.retryMissing(x.f.tenantId, x.manager, b.dossierId, x.input.operationKey),
    ).rejects.toMatchObject({ status: 403 });
    x.faults.lookup = false;
    expect(
      (await x.service.retryMissing(x.f.tenantId, x.founder, b.dossierId, x.input.operationKey))
        .status,
    ).toBe('settled');
    expect(x.fixture.vault.seal).toHaveBeenCalledTimes(2);
  });
  it('fails before persistence on missing SQL source, scope mismatch or substituted retained bytes', async () => {
    const x = setup();
    x.faults.source = true;
    await expect(x.service.create(x.f.tenantId, x.manager, x.input)).rejects.toMatchObject({
      code: 'released_approval_proof_required',
    });
    expect(x.calls).toEqual([]);
    x.faults.source = false;
    await expect(
      x.service.create(x.f.tenantId, x.manager, { ...x.input, engagementId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'source_version_conflict' });
    x.fixture.vault.retrieve.mockImplementation(async () => {
      throw Error('wrong or absent exact version');
    });
    await expect(x.service.create(x.f.tenantId, x.manager, x.input)).rejects.toThrow();
    expect(x.calls).toEqual([]);
    expect(x.fixture.vault.seal).not.toHaveBeenCalled();
  });
  it('rejects viewer creation and live revoked founder archive authority', async () => {
    const x = setup();
    await expect(x.service.create(x.f.tenantId, x.viewer, x.input)).rejects.toMatchObject({
      status: 403,
    });
    const b = await x.service.create(x.f.tenantId, x.manager, x.input);
    x.fixture.rows('users').find((u) => u.id === x.founder)!.is_axiom_internal = false;
    await expect(x.service.preview(x.f.tenantId, x.founder, b.dossierId)).rejects.toMatchObject({
      status: 403,
    });
  });
  it('binds review and release to the exact archive hash and version before any mutation', async () => {
    const x = setup(),
      b = await x.service.create(x.f.tenantId, x.manager, x.input);
    await expect(
      x.service.review(x.f.tenantId, x.founder, b.dossierId, {
        expectedArchiveSha256: 'b'.repeat(64),
        expectedVersionId: 'invented',
        note: 'Mismatch',
      }),
    ).rejects.toMatchObject({ code: 'archive_version_mismatch' });
    await expect(
      x.service.release(x.f.tenantId, x.founder, b.dossierId, {
        expectedArchiveSha256: 'b'.repeat(64),
        expectedVersionId: 'invented',
      }),
    ).rejects.toMatchObject({ code: 'archive_version_mismatch' });
    expect(x.calls).toEqual(['begin_full_pramaan', 'settle_full_pramaan']);
  });
});
