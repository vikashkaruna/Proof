import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DpbArtifactService } from './dpb-artifacts.js';
import { config, evidenceFixture, tenant } from '../test/evidence-fixture.js';

describe('DPB retained artifacts', () => {
  it('refuses missing or wrong-kind reports before any provider access', async () => {
    const fixture = evidenceFixture();
    const actor = randomUUID();
    fixture.rows('tenant_users').push({ tenant_id: tenant, user_id: actor, role: 'owner' });
    const storage = vi.fn(() => {
      throw new Error('provider must not be consulted');
    });
    const service = new DpbArtifactService(fixture.db, storage);
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
    const service = new DpbArtifactService(fixture.db, storage);
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
    const sourceHash = 'b'.repeat(64);
    const retainUntil = '2033-10-01T00:00:00.000Z';
    const pdfKey = `reports/dpb/${tenant}/${reportId}/dpb_pdf/${pdfHash}`;
    fixture.rows('tenant_users').push({ tenant_id: tenant, user_id: actor, role: 'owner' });
    fixture.rows('reports').push({
      id: reportId,
      tenant_id: tenant,
      engagement_id: null,
      kind: 'dpb',
      title: 'Review pack',
      status: 'published',
      generated_by_agent: 'dpb-report-builder',
      content_text: '{}',
      content_sha256: 'a'.repeat(64),
      reviewed_content_hash: 'a'.repeat(64),
      released_archive_hash: pdfHash,
    });
    fixture.rows('dpb_artifact_builds').push({
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
            object_key: `reports/dpb/${tenant}/${reportId}/source_json/${sourceHash}`,
            content_hash: sourceHash,
            byte_size: 20,
          },
          {
            kind: 'dpb_pdf',
            object_key: pdfKey,
            content_hash: pdfHash,
            byte_size: pdfBytes.length,
          },
        ],
      },
    });
    for (const kind of ['source_json', 'dpb_pdf'] as const) {
      fixture.rows('dpb_artifact_versions').push({
        id: randomUUID(),
        tenant_id: tenant,
        build_id: buildId,
        artifact_kind: kind,
        provider: config.provider,
        bucket: config.bucket,
        object_key:
          kind === 'dpb_pdf'
            ? pdfKey
            : `reports/dpb/${tenant}/${reportId}/source_json/${sourceHash}`,
        version_id: kind === 'dpb_pdf' ? 'exact-pdf-version' : 'exact-source-version',
        content_hash: kind === 'dpb_pdf' ? pdfHash : sourceHash,
        byte_size: kind === 'dpb_pdf' ? pdfBytes.length : 20,
        retain_until: retainUntil,
        legal_hold: false,
        encryption: 'AES256',
      });
    }
    fixture.vault.verifyReceipt.mockResolvedValue(fixture.verified);
    fixture.vault.retrieve.mockResolvedValue({
      body: Buffer.from('%PDF-1.7\nchanged fixture'),
      contentHash: pdfHash,
      metadata: {},
      contentType: 'application/pdf',
      retainUntil: new Date(retainUntil),
      lockMode: 'COMPLIANCE',
      versionId: 'exact-pdf-version',
      encryption: 'AES256',
    });
    const service = new DpbArtifactService(fixture.db, () => ({ config, vault: fixture.vault }));
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
  });
});
