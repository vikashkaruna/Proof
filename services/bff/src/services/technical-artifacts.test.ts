import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { TechnicalArtifactService } from './technical-artifacts.js';
import { config, evidenceFixture, tenant } from '../test/evidence-fixture.js';

describe('Technical retained artifacts', () => {
  it.each(
    (['rejected', 'archived'] as const).flatMap((status) =>
      (['none', 'pending', 'settled'] as const).map((buildState) => ({ status, buildState })),
    ),
  )(
    'refuses $status artifact work with a $buildState historical build',
    async ({ status, buildState }) => {
      const fixture = evidenceFixture(),
        actor = randomUUID(),
        reportId = randomUUID(),
        operationKey = randomUUID();
      fixture.rows('tenant_users').push({ tenant_id: tenant, user_id: actor, role: 'founder' });
      fixture.rows('users').push({ id: actor, is_axiom_internal: true });
      fixture.rows('reports').push({
        id: reportId,
        tenant_id: tenant,
        engagement_id: randomUUID(),
        kind: 'technical',
        title: 'Retained synthetic review',
        status,
        generated_by_agent: 'technical-report-builder',
        content_text: '{}',
        content_sha256: 'a'.repeat(64),
        reviewed_content_hash: 'a'.repeat(64),
        released_archive_hash: null,
      });
      if (buildState !== 'none')
        fixture.rows('technical_artifact_builds').push({
          id: randomUUID(),
          tenant_id: tenant,
          report_id: reportId,
          operation_key: operationKey,
          status: buildState,
          retain_until: '2034-01-01T00:00:00.000Z',
          correlation_id: randomUUID(),
          last_error_code: null,
          request: {
            provider: config.provider,
            bucket: config.bucket,
            artifacts: [
              {
                kind: 'source_json',
                object_key: 'retained/source',
                content_hash: 'a'.repeat(64),
                byte_size: 2,
              },
              {
                kind: 'technical_pdf',
                object_key: 'retained/pdf',
                content_hash: 'b'.repeat(64),
                byte_size: 12,
              },
            ],
          },
        });
      if (buildState === 'settled') {
        const buildId = fixture.rows('technical_artifact_builds')[0]!.id;
        for (const [kind, digest, bytes, key] of [
          ['source_json', 'a'.repeat(64), 2, 'retained/source'],
          ['technical_pdf', 'b'.repeat(64), 12, 'retained/pdf'],
        ] as const)
          fixture.rows('technical_artifact_versions').push({
            id: randomUUID(),
            tenant_id: tenant,
            build_id: buildId,
            artifact_kind: kind,
            provider: config.provider,
            bucket: config.bucket,
            object_key: key,
            version_id: 'historical-exact-version',
            content_hash: digest,
            byte_size: bytes,
            retain_until: '2034-01-01T00:00:00.000Z',
            legal_hold: false,
            encryption: 'AES256',
          });
      }
      const storage = vi.fn(() => {
        throw new Error('terminal report must not access provider');
      });
      const renderPdf = vi.fn(async () => {
        throw new Error('terminal report must not render');
      });
      const rpc = vi.spyOn(fixture.db, 'rpc');
      const service = new TechnicalArtifactService(fixture.db, storage, renderPdf);
      const retained = structuredClone({
        reports: fixture.rows('reports'),
        builds: fixture.rows('technical_artifact_builds'),
      });
      for (const operation of [
        () => service.build(tenant, actor, reportId, operationKey),
        () => service.build(tenant, actor, reportId, randomUUID()),
        () => service.reconcile(tenant, actor, reportId, operationKey),
        () => service.retryMissing(tenant, actor, reportId, operationKey),
      ])
        await expect(operation()).rejects.toMatchObject({ code: 'not_approved', status: 409 });
      await expect(service.pdf(tenant, actor, reportId)).rejects.toMatchObject({
        code: 'report_artifact_unverified',
        status: 409,
      });
      expect(storage).not.toHaveBeenCalled();
      expect(renderPdf).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
      expect({
        reports: fixture.rows('reports'),
        builds: fixture.rows('technical_artifact_builds'),
      }).toEqual(retained);
      fixture.rows('tenant_users')[0]!.role = 'owner';
      await expect(service.pdf(tenant, actor, reportId)).rejects.toMatchObject({
        code: 'forbidden',
        status: 403,
      });
      fixture.rows('tenant_users')[0]!.role = 'founder';
      fixture.rows('reports')[0]!.status = 'withdrawn';
      await expect(service.pdf(tenant, actor, reportId)).rejects.toMatchObject({
        code: 'invalid_report_record',
        status: 503,
      });
      expect(storage).not.toHaveBeenCalled();
    },
  );

  it('refuses artifact replay when its report no longer exists', async () => {
    const fixture = evidenceFixture(),
      actor = randomUUID(),
      reportId = randomUUID(),
      operationKey = randomUUID();
    fixture.rows('tenant_users').push({ tenant_id: tenant, user_id: actor, role: 'founder' });
    fixture.rows('users').push({ id: actor, is_axiom_internal: true });
    fixture.rows('technical_artifact_builds').push({
      id: randomUUID(),
      tenant_id: tenant,
      report_id: reportId,
      operation_key: operationKey,
      status: 'settled',
      retain_until: '2034-01-01T00:00:00.000Z',
      correlation_id: randomUUID(),
      last_error_code: null,
      request: {
        provider: config.provider,
        bucket: config.bucket,
        artifacts: [
          {
            kind: 'source_json',
            object_key: 'retained/source',
            content_hash: 'a'.repeat(64),
            byte_size: 2,
          },
          {
            kind: 'technical_pdf',
            object_key: 'retained/pdf',
            content_hash: 'b'.repeat(64),
            byte_size: 12,
          },
        ],
      },
    });
    const storage = vi.fn(() => {
      throw new Error('orphan artifacts must not access provider');
    });
    const service = new TechnicalArtifactService(fixture.db, storage);
    for (const operation of [
      () => service.build(tenant, actor, reportId, operationKey),
      () => service.reconcile(tenant, actor, reportId, operationKey),
      () => service.retryMissing(tenant, actor, reportId, operationKey),
      () => service.pdf(tenant, actor, reportId),
    ])
      await expect(operation()).rejects.toMatchObject({ code: 'report_not_found', status: 404 });
    expect(storage).not.toHaveBeenCalled();
  });

  it('refuses missing or wrong-kind reports before any provider access', async () => {
    const fixture = evidenceFixture();
    const actor = randomUUID();
    fixture.rows('tenant_users').push({ tenant_id: tenant, user_id: actor, role: 'owner' });
    const storage = vi.fn(() => {
      throw new Error('provider must not be consulted');
    });
    const service = new TechnicalArtifactService(fixture.db, storage);
    await expect(service.pdf(tenant, actor, randomUUID())).rejects.toMatchObject({
      code: 'report_not_found',
      status: 404,
    });
    const board = randomUUID();
    fixture.rows('reports').push({
      id: board,
      tenant_id: tenant,
      kind: 'board',
      title: 'Board',
      status: 'published',
      generated_by_agent: 'board-report-builder',
    });
    await expect(service.pdf(tenant, actor, board)).rejects.toMatchObject({
      code: 'report_not_found',
      status: 404,
    });
    expect(storage).not.toHaveBeenCalled();
  });

  it('refuses an external founder or owner before generating an unreviewed artifact', async () => {
    const fixture = evidenceFixture();
    const actor = randomUUID();
    fixture.rows('tenant_users').push({ tenant_id: tenant, user_id: actor, role: 'founder' });
    fixture.rows('users').push({ id: actor, is_axiom_internal: false });
    const storage = vi.fn(() => {
      throw new Error('provider must not be consulted');
    });
    const service = new TechnicalArtifactService(fixture.db, storage);
    await expect(service.build(tenant, actor, randomUUID(), randomUUID())).rejects.toMatchObject({
      code: 'forbidden',
      status: 403,
    });
    expect(storage).not.toHaveBeenCalled();
  });

  it('reads the exact released version and refuses changed provider bytes', async () => {
    const fixture = evidenceFixture();
    const actor = randomUUID();
    const reportId = randomUUID();
    const buildId = randomUUID();
    const pdfBytes = Buffer.from('%PDF-1.7\nretained fixture');
    const pdfHash = createHash('sha256').update(pdfBytes).digest('hex');
    const sourceBytes = Buffer.from('{"source":"retained fixture"}');
    const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
    const retainUntil = '2033-10-01T00:00:00.000Z';
    const pdfKey = `reports/technical/${tenant}/${reportId}/technical_pdf/${pdfHash}`;
    fixture.rows('tenant_users').push({ tenant_id: tenant, user_id: actor, role: 'owner' });
    fixture.rows('reports').push({
      id: reportId,
      tenant_id: tenant,
      engagement_id: randomUUID(),
      kind: 'technical',
      title: 'Review pack',
      status: 'published',
      generated_by_agent: 'technical-report-builder',
      content_text: '{}',
      content_sha256: 'a'.repeat(64),
      reviewed_content_hash: 'a'.repeat(64),
      released_archive_hash: pdfHash,
    });
    fixture.rows('technical_artifact_builds').push({
      id: buildId,
      tenant_id: tenant,
      report_id: reportId,
      operation_key: randomUUID(),
      status: 'settled',
      retain_until: retainUntil,
      correlation_id: randomUUID(),
      last_error_code: null,
      request: {
        provider: config.provider,
        bucket: config.bucket,
        artifacts: [
          {
            kind: 'source_json',
            object_key: `reports/technical/${tenant}/${reportId}/source_json/${sourceHash}`,
            content_hash: sourceHash,
            byte_size: sourceBytes.length,
          },
          {
            kind: 'technical_pdf',
            object_key: pdfKey,
            content_hash: pdfHash,
            byte_size: pdfBytes.length,
          },
        ],
      },
    });
    for (const kind of ['source_json', 'technical_pdf'] as const) {
      fixture.rows('technical_artifact_versions').push({
        id: randomUUID(),
        tenant_id: tenant,
        build_id: buildId,
        artifact_kind: kind,
        provider: config.provider,
        bucket: config.bucket,
        object_key:
          kind === 'technical_pdf'
            ? pdfKey
            : `reports/technical/${tenant}/${reportId}/source_json/${sourceHash}`,
        version_id: kind === 'technical_pdf' ? 'exact-pdf-version' : 'exact-source-version',
        content_hash: kind === 'technical_pdf' ? pdfHash : sourceHash,
        byte_size: kind === 'technical_pdf' ? pdfBytes.length : sourceBytes.length,
        retain_until: retainUntil,
        legal_hold: false,
        encryption: 'AES256',
      });
    }
    fixture.vault.verifyReceipt.mockResolvedValue(fixture.verified);
    fixture.vault.retrieve.mockImplementation(async (_bucket, key) => ({
      body: key === pdfKey ? Buffer.from('%PDF-1.7\nchanged fixture') : sourceBytes,
      contentHash: key === pdfKey ? pdfHash : sourceHash,
      metadata: {},
      contentType: key === pdfKey ? 'application/pdf' : 'application/json',
      retainUntil: new Date(retainUntil),
      lockMode: 'COMPLIANCE',
      versionId: key === pdfKey ? 'exact-pdf-version' : 'exact-source-version',
      encryption: 'AES256',
    }));
    const service = new TechnicalArtifactService(fixture.db, () => ({
      config,
      vault: fixture.vault,
    }));
    await expect(service.pdf(tenant, actor, reportId)).rejects.toMatchObject({
      code: 'provider_verification_failed',
      status: 503,
    });
    expect(fixture.vault.retrieve).toHaveBeenCalledWith(
      config.bucket,
      pdfKey,
      'exact-pdf-version',
      expect.objectContaining({ maxBytes: 32 * 1024 * 1024 }),
    );
    fixture.vault.retrieve.mockClear();
    fixture.vault.verifyReceipt.mockRejectedValueOnce(new Error('exact source unavailable'));
    await expect(service.pdf(tenant, actor, reportId)).rejects.toThrow('exact source unavailable');
    expect(fixture.vault.retrieve).not.toHaveBeenCalled();
    fixture.vault.retrieve.mockImplementationOnce(async () => ({
      body: Buffer.from('{"source":"changed"}'),
      contentHash: sourceHash,
      metadata: {},
      contentType: 'application/json',
      retainUntil: new Date(retainUntil),
      lockMode: 'COMPLIANCE',
      versionId: 'exact-source-version',
      encryption: 'AES256',
    }));
    await expect(service.pdf(tenant, actor, reportId)).rejects.toMatchObject({
      code: 'provider_verification_failed',
      status: 503,
    });
    expect(fixture.vault.retrieve).toHaveBeenCalledTimes(1);
  });
});
