import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { EvidenceDatabase } from './evidence-ingestion.js';
import { PramaanTechnicalArtifactService } from './pramaan-technical-artifacts.js';
import { evidenceFixture, tenant, config } from '../test/evidence-fixture.js';
import { abortableResult } from '../test/abortable-result.js';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function setup() {
  const fixture = evidenceFixture();
  const manager = randomUUID();
  const founder = randomUUID();
  const engagementId = randomUUID();
  const reportId = randomUUID();
  const requestId = randomUUID();
  const sourceBuildId = randomUUID();
  const sourceVersionId = randomUUID();
  const pdfVersionId = randomUUID();
  const operationKey = randomUUID();
  const sourceBytes = Buffer.from(
    JSON.stringify({
      schema_version: 1,
      kind: 'technical_plan_source',
      tenant_id: tenant,
      request_id: requestId,
      plan: { engagement_id: engagementId },
    }),
  );
  const pdfBytes = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(600, 1)]);
  fixture
    .rows('tenant_users')
    .push(
      { tenant_id: tenant, user_id: manager, role: 'admin' },
      { tenant_id: tenant, user_id: founder, role: 'founder' },
    );
  fixture
    .rows('users')
    .push({ id: manager, is_axiom_internal: false }, { id: founder, is_axiom_internal: true });
  fixture.rows('reports').push({
    id: reportId,
    tenant_id: tenant,
    engagement_id: engagementId,
    kind: 'technical',
    generated_by_agent: 'technical-report-builder',
    status: 'published',
    title: 'Released technical report',
    released_by: founder,
    released_archive_hash: sha(pdfBytes),
    content: { source_sha256: sha(sourceBytes) },
  });
  fixture.rows('technical_report_requests').push({
    id: requestId,
    tenant_id: tenant,
    report_id: reportId,
    engagement_id: engagementId,
    status: 'released',
  });
  fixture
    .rows('technical_request_sources')
    .push({ request_id: requestId, tenant_id: tenant, source_sha256: sha(sourceBytes) });
  fixture.rows('technical_artifact_builds').push({
    id: sourceBuildId,
    tenant_id: tenant,
    report_id: reportId,
    status: 'settled',
    source_sha256: sha(sourceBytes),
  });
  for (const [id, kind, key, bytes] of [
    [sourceVersionId, 'source_json', 'source-key', sourceBytes],
    [pdfVersionId, 'technical_pdf', 'pdf-key', pdfBytes],
  ] as const)
    fixture.rows('technical_artifact_versions').push({
      id,
      tenant_id: tenant,
      report_id: reportId,
      build_id: sourceBuildId,
      artifact_kind: kind,
      provider: config.provider,
      bucket: config.bucket,
      object_key: key,
      version_id: `${key}-version`,
      content_hash: sha(bytes),
      byte_size: bytes.length,
      retain_until: '2034-01-01T00:00:00.000Z',
      encryption: 'AES256',
    });
  let archived: Buffer | null = null;
  let failSeal = false;
  fixture.vault.verifyReceipt.mockImplementation(async (expected) => ({
    ...fixture.verified,
    bucket: expected.bucket,
    key: expected.key,
    versionId: expected.versionId,
    contentHash: expected.contentHash,
    byteSize: expected.byteSize,
    retainUntil: expected.retainUntil,
    encryption: expected.encryption ?? 'AES256',
    readbackAt: new Date().toISOString(),
  }));
  fixture.vault.retrieve.mockImplementation(async (_bucket, key, versionId) => {
    const bytes = key === 'source-key' ? sourceBytes : key === 'pdf-key' ? pdfBytes : archived;
    if (!bytes) throw new Error('exact provider version absent');
    return {
      body: Buffer.from(bytes) as Buffer<ArrayBuffer>,
      contentHash: sha(bytes),
      metadata: {},
      contentType: 'application/octet-stream',
      retainUntil: new Date('2034-01-01T00:00:00.000Z'),
      lockMode: 'COMPLIANCE',
      versionId,
      encryption: 'AES256',
    };
  });
  fixture.vault.seal.mockImplementation(async (input) => {
    if (failSeal) throw new Error('provider outcome unknown');
    archived = Buffer.from(input.body);
    return {
      ...fixture.verified,
      bucket: input.bucket,
      key: input.key,
      versionId: 'dossier-version',
      contentHash: sha(archived),
      byteSize: archived.length,
      retainUntil: input.retainUntil!,
      readbackAt: new Date().toISOString(),
    };
  });
  fixture.vault.findEvidenceVersion.mockImplementation(async () =>
    archived ? { versionId: 'dossier-version' } : null,
  );
  const calls: string[] = [];
  const db = {
    ...fixture.db,
    rpc: ((name: string, args: Record<string, unknown>) => {
      calls.push(name);
      if (name === 'begin_technical_pramaan') {
        const request = args.p_request as Record<string, unknown>;
        const dossierId = randomUUID();
        const buildId = randomUUID();
        fixture.rows('pramaan_dossiers').push({
          id: dossierId,
          tenant_id: tenant,
          engagement_id: engagementId,
          report_id: reportId,
          dossier_type: 'technical_register',
          title: args.p_title,
          status: 'draft',
          merkle_root: 'a'.repeat(64),
          manifest_hash: request.manifest_sha256,
          archive_hash: request.archive_sha256,
          archive_bytes: request.archive_bytes,
          proof_seal_hash: 'b'.repeat(64),
          metadata: {},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        fixture.rows('pramaan_technical_builds').push({
          id: buildId,
          tenant_id: tenant,
          dossier_id: dossierId,
          report_id: reportId,
          source_build_id: sourceBuildId,
          operation_key: args.p_operation_key,
          requested_by: args.p_actor_id,
          request,
          retain_until: '2034-01-01T00:00:00.000Z',
          correlation_id: args.p_correlation_id,
          status: 'pending',
          last_error_code: null,
        });
        return abortableResult(
          Promise.resolve({
            data: { dossierId, buildId, status: 'pending', replayed: false },
            error: null,
          }),
        );
      }
      if (name === 'settle_technical_pramaan') {
        const receipt = args.p_receipt as Record<string, unknown>;
        const build = fixture.rows('pramaan_technical_builds')[0]!;
        fixture.rows('pramaan_technical_archives').push({
          id: randomUUID(),
          tenant_id: tenant,
          dossier_id: build.dossier_id,
          build_id: build.id,
          provider: receipt.provider,
          bucket: receipt.bucket,
          object_key: receipt.object_key,
          version_id: receipt.version_id,
          content_hash: receipt.content_hash,
          byte_size: receipt.byte_size,
          retain_until: receipt.retain_until,
          encryption: receipt.encryption,
        });
        build.status = 'settled';
        return abortableResult(Promise.resolve({ data: { status: 'settled' }, error: null }));
      }
      if (name === 'seal_technical_pramaan') {
        const dossier = fixture.rows('pramaan_dossiers')[0]!;
        dossier.status = 'sealed';
        return abortableResult(
          Promise.resolve({ data: { dossierId: dossier.id, status: 'sealed' }, error: null }),
        );
      }
      if (name === 'note_technical_pramaan_failure')
        return abortableResult(Promise.resolve({ data: { status: 'pending' }, error: null }));
      throw new Error(`Unexpected RPC ${name}`);
    }) as unknown as EvidenceDatabase['rpc'],
  } as EvidenceDatabase;
  const reader = {
    ...db,
    rpc: () => {
      throw new Error('service_role RPC must never be used for dossier mutation');
    },
  } as EvidenceDatabase;
  const service = new PramaanTechnicalArtifactService(
    reader,
    () => ({ vault: fixture.vault, config }),
    () => db,
  );
  return {
    fixture,
    service,
    manager,
    founder,
    engagementId,
    reportId,
    operationKey,
    calls,
    sourceBytes,
    pdfBytes,
    setFailSeal: (value: boolean) => {
      failSeal = value;
    },
  };
}

describe('Pramaan source-bound provider workflow', () => {
  it('retains exact source-derived archive, settles, and requires founder seal', async () => {
    const f = setup();
    const created = await f.service.create(tenant, f.manager, {
      engagementId: f.engagementId,
      reportId: f.reportId,
      dossierType: 'technical_register',
      title: 'Q3 closure',
      operationKey: f.operationKey,
    });
    expect(created.status).toBe('settled');
    expect(f.calls).toEqual(['begin_technical_pramaan', 'settle_technical_pramaan']);
    await expect(
      f.service.seal(tenant, f.manager, created.dossierId, 'b'.repeat(64)),
    ).rejects.toMatchObject({ code: 'dossier_not_found' });
    expect(
      await f.service.seal(tenant, f.founder, created.dossierId, 'b'.repeat(64)),
    ).toMatchObject({ status: 'sealed' });
    const exact = await f.service.archive(tenant, f.founder, created.dossierId);
    expect(sha(exact.body)).toBe(exact.sha256);
  });

  it('keeps an ambiguous upload pending and never automatically retries a PUT', async () => {
    const f = setup();
    f.setFailSeal(true);
    const created = await f.service.create(tenant, f.manager, {
      engagementId: f.engagementId,
      reportId: f.reportId,
      dossierType: 'technical_register',
      title: '  Q3 closure  ',
      operationKey: f.operationKey,
    });
    expect(created.status).toBe('pending');
    expect(f.fixture.rows('pramaan_dossiers')[0]!.title).toBe('Q3 closure');
    expect(f.fixture.vault.seal).toHaveBeenCalledTimes(1);
    expect(
      (await f.service.reconcile(tenant, f.manager, created.dossierId, f.operationKey)).status,
    ).toBe('pending');
    expect(f.fixture.vault.seal).toHaveBeenCalledTimes(1);
    await expect(
      f.service.seal(tenant, f.founder, created.dossierId, 'b'.repeat(64)),
    ).rejects.toMatchObject({ code: 'archive_unverified' });
    f.setFailSeal(false);
    expect(
      (await f.service.retryMissing(tenant, f.founder, created.dossierId, f.operationKey)).status,
    ).toBe('settled');
    expect(f.fixture.vault.seal).toHaveBeenCalledTimes(2);
  });

  it('refuses unpublished or unsupported source without a dossier write', async () => {
    const f = setup();
    const input = {
      engagementId: f.engagementId,
      reportId: f.reportId,
      title: 'Q3 closure',
      operationKey: f.operationKey,
    };
    await expect(
      f.service.create(tenant, f.manager, { ...input, dossierType: 'dpb_statutory' }),
    ).rejects.toMatchObject({ code: 'source_bound_dossier_required' });
    f.fixture.rows('reports')[0]!.kind = 'board';
    await expect(
      f.service.create(tenant, f.manager, { ...input, dossierType: 'technical_register' }),
    ).rejects.toMatchObject({ code: 'source_bound_dossier_required', status: 409 });
    f.fixture.rows('reports')[0]!.kind = 'technical';
    f.fixture.rows('reports')[0]!.status = 'approved';
    await expect(
      f.service.create(tenant, f.manager, { ...input, dossierType: 'technical_register' }),
    ).rejects.toMatchObject({ code: 'source_report_not_released' });
    expect(f.calls).toHaveLength(0);
  });

  it('refuses a changed frozen source before build and missing exact source at seal', async () => {
    const f = setup();
    const input = {
      engagementId: f.engagementId,
      reportId: f.reportId,
      dossierType: 'technical_register',
      title: 'Assessment-derived dossier',
      operationKey: f.operationKey,
    };
    f.fixture.rows('technical_request_sources')[0]!.source_sha256 = '0'.repeat(64);
    await expect(f.service.create(tenant, f.manager, input)).rejects.toMatchObject({
      code: 'source_version_conflict',
    });
    expect(f.calls).toHaveLength(0);
    f.fixture.rows('technical_request_sources')[0]!.source_sha256 = sha(f.sourceBytes);
    const created = await f.service.create(tenant, f.manager, input);
    expect(created.status).toBe('settled');
    f.fixture.vault.retrieve.mockRejectedValueOnce(new Error('exact source version missing'));
    await expect(
      f.service.seal(tenant, f.founder, created.dossierId, 'b'.repeat(64)),
    ).rejects.toThrow();
    expect(f.calls).not.toContain('seal_technical_pramaan');
  });
});
