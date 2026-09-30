import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { EvidenceDatabase } from './evidence-ingestion.js';
import { StatutoryArtifactService } from './statutory-artifacts.js';
import { evidenceFixture, tenant, config } from '../test/evidence-fixture.js';
import { abortableResult } from '../test/abortable-result.js';
import { buildAuditorAssessmentPack } from '@axiom/report-kit/auditor-source';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const reportId = '55555555-5555-4555-8555-555555555555';
const requestId = '44444444-4444-4444-8444-444444444444';
const actorId = '66666666-6666-4666-8666-666666666666';
const engagementId = '22222222-2222-4222-8222-222222222222';
const runId = '33333333-3333-4333-8333-333333333333';
const operationKey = '77777777-7777-4777-8777-777777777777';
const title = 'Auditor assessment review';

function setup() {
  const fixture = evidenceFixture();
  fixture.rows('tenant_users').push({ tenant_id: tenant, user_id: actorId, role: 'founder' });
  fixture.rows('users').push({ id: actorId, is_axiom_internal: true });
  const controls = [
    {
      id: 'C-1',
      title: 'Encryption',
      domain: 'Security',
      severity: 'high',
      remediation_patterns: ['Encrypt the volume.'],
    },
  ];
  const result = {
    library_version: 'test-v1',
    posture_score: 20,
    estimated_exposure_inr: 500000,
    findings: [
      { control_id: 'C-1', score: 20, risk_points: 8, rationale: 'Volume was unencrypted.' },
    ],
  };
  const controlsText = JSON.stringify(controls);
  const resultText = JSON.stringify(result);
  const sourceText = JSON.stringify({
    schema_version: 1,
    serialization: 'postgres-jsonb-text-v1',
    kind: 'statutory_source',
    report_kind: 'auditor',
    request_id: requestId,
    tenant_id: tenant,
    engagement_id: engagementId,
    assessment_run_id: runId,
    library_version: 'test-v1',
    controls_text: controlsText,
    controls_sha256: sha(controlsText),
    result_text: resultText,
    result_sha256: sha(resultText),
    finalized_at: '2026-09-30T12:00:00.000Z',
    receipts: {
      started: { id: '1', entry_hash: '1'.repeat(64) },
      completed: { id: '2', entry_hash: '2'.repeat(64) },
      finalized: { id: '3', entry_hash: '3'.repeat(64) },
    },
  });
  const documentText = JSON.stringify(
    buildAuditorAssessmentPack({
      sourceText,
      sourceSha256: sha(sourceText),
      requestId,
      tenantId: tenant,
      engagementId,
      assessmentRunId: runId,
      title,
      generatedAt: '2026-09-30T12:01:00.000Z',
    }),
  );
  const reviewText = JSON.stringify({
    schema_version: 1,
    report_id: reportId,
    content_sha256: sha(documentText),
    decision: 'approved',
    reviewer: { id: actorId, display_name: 'Named Founder' },
    reviewed_at: '2026-09-30T12:02:00.000Z',
  });
  fixture.rows('reports').push({
    id: reportId,
    tenant_id: tenant,
    engagement_id: engagementId,
    kind: 'auditor',
    title,
    status: 'approved',
    generated_by_agent: 'statutory-report-builder',
    content_text: documentText,
    content_sha256: sha(documentText),
    reviewed_content_hash: sha(documentText),
    released_archive_hash: null,
  });
  fixture
    .rows('statutory_report_requests')
    .push({ id: requestId, tenant_id: tenant, report_id: reportId, assessment_run_id: runId });
  fixture.rows('statutory_request_sources').push({
    tenant_id: tenant,
    request_id: requestId,
    source_text: sourceText,
    source_sha256: sha(sourceText),
  });
  fixture.rows('report_reviews').push({
    id: randomUUID(),
    tenant_id: tenant,
    report_id: reportId,
    decision: 'approved',
    content_sha256: sha(documentText),
    review_text: reviewText,
    review_sha256: sha(reviewText),
    reviewed_at: '2026-09-30T12:02:00.000Z',
  });

  const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(600, 65)]);
  const renderPdf = vi.fn(async () => ({
    pdfBuffer: pdfBytes,
    sha256: sha(pdfBytes),
    byteLength: pdfBytes.length,
    renderer: 'chromium' as const,
  }));
  const vault = fixture.vault;
  vault.seal.mockImplementation(async (input) => ({
    ...fixture.verified,
    bucket: input.bucket,
    key: input.key,
    byteSize: Buffer.byteLength(input.body),
    contentHash: sha(Buffer.from(input.body)),
    versionId: `version-${input.contentType}`,
    retainUntil: input.retainUntil!,
    readbackAt: new Date().toISOString(),
  }));
  vault.verifyReceipt.mockImplementation(async (input) => ({
    ...fixture.verified,
    bucket: input.bucket,
    key: input.key,
    contentHash: input.contentHash,
    byteSize: input.byteSize,
    versionId: input.versionId,
    retainUntil: input.retainUntil,
    readbackAt: new Date().toISOString(),
  }));
  vault.retrieve.mockImplementation(async () => ({
    body: pdfBytes,
    contentHash: sha(pdfBytes),
    metadata: {},
    contentType: 'application/pdf',
    retainUntil: new Date('2034-01-01T00:00:00Z'),
    lockMode: 'COMPLIANCE',
    versionId: 'version-application/pdf',
    encryption: 'AES256',
  }));

  const calls: string[] = [];
  const db = {
    ...fixture.db,
    rpc: ((name: string, args: Record<string, unknown>) => {
      calls.push(name);
      if (name === 'begin_statutory_artifact_build') {
        const build = {
          id: randomUUID(),
          tenant_id: tenant,
          report_id: reportId,
          operation_key: operationKey,
          status: 'pending',
          request: args.p_request,
          retain_until: '2034-01-01T00:00:00.000Z',
          correlation_id: args.p_correlation_id,
          last_error_code: null,
        };
        fixture.rows('statutory_artifact_builds').push(build);
        return abortableResult(
          Promise.resolve({ data: { buildId: build.id, replayed: false }, error: null }),
        );
      }
      if (name === 'settle_statutory_artifact_version') {
        const receipt = args.p_receipt as Record<string, unknown>;
        fixture.rows('statutory_artifact_versions').push({
          id: randomUUID(),
          tenant_id: tenant,
          build_id: args.p_build_id,
          artifact_kind: args.p_artifact_kind,
          provider: receipt.provider,
          bucket: receipt.bucket,
          object_key: receipt.object_key,
          version_id: receipt.version_id,
          content_hash: receipt.content_hash,
          byte_size: receipt.byte_size,
          retain_until: receipt.retain_until,
          legal_hold: false,
          encryption: receipt.encryption,
        });
        if (fixture.rows('statutory_artifact_versions').length === 2)
          fixture.rows('statutory_artifact_builds')[0]!.status = 'settled';
        return abortableResult(
          Promise.resolve({
            data: { status: fixture.rows('statutory_artifact_builds')[0]!.status },
            error: null,
          }),
        );
      }
      if (name === 'note_statutory_artifact_failure')
        return abortableResult(Promise.resolve({ data: { status: 'pending' }, error: null }));
      throw new Error(`Unexpected RPC ${name}`);
    }) as unknown as EvidenceDatabase['rpc'],
  } as EvidenceDatabase;
  const service = new StatutoryArtifactService(db, () => ({ vault, config }), renderPdf, db);
  return { fixture, service, vault, calls, renderPdf, pdfBytes };
}

describe('statutory auditor artifact provider boundary', () => {
  it('returns 404 for legacy unsourced statutory output before any vault lookup', async () => {
    const { fixture, service, vault } = setup();
    fixture.rows('reports')[0]!.generated_by_agent = 'prativedan';
    fixture.rows('reports')[0]!.content_text = null;
    await expect(service.pdf(tenant, actorId, reportId)).rejects.toMatchObject({
      code: 'report_not_found',
      status: 404,
    });
    expect(vault.verifyReceipt).not.toHaveBeenCalled();
    expect(vault.retrieve).not.toHaveBeenCalled();
  });

  it('returns 404 for historical technical output without producer metadata', async () => {
    const { fixture, service, vault } = setup();
    fixture.rows('reports')[0]!.kind = 'technical';
    delete fixture.rows('reports')[0]!.generated_by_agent;
    await expect(service.pdf(tenant, actorId, reportId)).rejects.toMatchObject({
      code: 'report_not_found',
      status: 404,
    });
    expect(vault.verifyReceipt).not.toHaveBeenCalled();
  });

  it('projects exact version metadata to the founder without leaking storage coordinates', async () => {
    const { fixture, service } = setup();
    const managerId = randomUUID();
    fixture.rows('tenant_users').push({ tenant_id: tenant, user_id: managerId, role: 'owner' });
    fixture.rows('statutory_report_requests')[0]!.requested_by = managerId;
    const buildId = randomUUID();
    fixture.rows('statutory_artifact_builds').push({
      id: buildId,
      tenant_id: tenant,
      report_id: reportId,
      operation_key: operationKey,
      status: 'pending',
      retain_until: '2033-09-30T12:00:00.000Z',
      last_error_code: null,
    });
    fixture.rows('statutory_artifact_versions').push({
      id: randomUUID(),
      tenant_id: tenant,
      report_id: reportId,
      build_id: buildId,
      artifact_kind: 'source_json',
      version_id: 'exact-source-version',
      content_hash: 'a'.repeat(64),
      byte_size: 100,
      retain_until: '2033-09-30T12:00:00.000Z',
      bucket: 'private-bucket',
      object_key: 'private/source/key',
      provider: 's3',
    });
    const founder = await service.status(tenant, actorId, reportId);
    expect(founder).toMatchObject({
      reportStatus: 'approved',
      status: 'pending',
      operationKey,
      source: { sha256: 'a'.repeat(64), versionId: 'exact-source-version' },
      pdf: null,
    });
    expect(JSON.stringify(founder)).not.toMatch(/private-bucket|private\/source\/key|provider/);
    const manager = await service.status(tenant, managerId, reportId);
    expect(manager).toMatchObject({ reportStatus: 'approved', source: null, operationKey: null });
    fixture.rows('reports')[0]!.status = 'published';
    expect(await service.status(tenant, managerId, reportId)).toMatchObject({
      reportStatus: 'published',
      source: { versionId: 'exact-source-version' },
    });
    await expect(service.status(tenant, randomUUID(), reportId)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
  it('stores and read-verifies both exact versions, then serves only the published PDF bytes', async () => {
    const { fixture, service, vault, calls, renderPdf, pdfBytes } = setup();
    expect(await service.build(tenant, actorId, reportId, operationKey)).toMatchObject({
      status: 'settled',
      replayed: false,
    });
    expect(renderPdf).toHaveBeenCalledWith(expect.any(String), {
      requireChromium: true,
      timeoutMs: 30_000,
      documentDate: '2026-09-30T12:02:00.000Z',
    });
    expect(vault.seal).toHaveBeenCalledTimes(2);
    expect(calls.filter((name) => name === 'settle_statutory_artifact_version')).toHaveLength(2);
    expect(await service.build(tenant, actorId, reportId, operationKey)).toMatchObject({
      status: 'settled',
      replayed: true,
    });
    expect(vault.seal).toHaveBeenCalledTimes(2);
    const report = fixture.rows('reports')[0]!;
    report.status = 'published';
    report.released_archive_hash = sha(pdfBytes);
    const result = await service.pdf(tenant, actorId, reportId);
    expect(result.pdfBuffer).toEqual(pdfBytes);
    expect(vault.retrieve).toHaveBeenCalledWith(
      config.bucket,
      expect.stringContaining('/statutory_pdf/'),
      'version-application/pdf',
      expect.objectContaining({ maxBytes: 32 * 1024 * 1024 }),
    );
  });

  it('keeps a partial upload pending and reconciles the exact missing version without another PUT', async () => {
    const { service, vault } = setup();
    vault.seal.mockRejectedValueOnce(new Error('provider uncertain'));
    expect(await service.build(tenant, actorId, reportId, operationKey)).toMatchObject({
      status: 'pending',
    });
    expect(vault.seal).toHaveBeenCalledTimes(1);
    vault.findEvidenceVersion
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ versionId: 'source-version' })
      .mockResolvedValueOnce({ versionId: 'pdf-version' });
    expect(await service.reconcile(tenant, actorId, reportId, operationKey)).toMatchObject({
      status: 'pending',
    });
    expect(await service.reconcile(tenant, actorId, reportId, operationKey)).toMatchObject({
      status: 'settled',
    });
    expect(vault.seal).toHaveBeenCalledTimes(1);
  });

  it('allows only an explicit founder retry after the provider confirms absence', async () => {
    const { service, vault } = setup();
    vault.seal.mockRejectedValueOnce(new Error('upload response uncertain'));
    expect(await service.build(tenant, actorId, reportId, operationKey)).toMatchObject({
      status: 'pending',
    });
    vault.findEvidenceVersion.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    expect(await service.retryMissing(tenant, actorId, reportId, operationKey)).toMatchObject({
      status: 'settled',
    });
    expect(vault.seal).toHaveBeenCalledTimes(3);
    for (const [input] of vault.seal.mock.calls) expect(input.createOnly).toBe(true);
  });

  it('does not issue another PUT when the exact-key provider lookup is uncertain', async () => {
    const { service, vault } = setup();
    vault.seal.mockRejectedValueOnce(new Error('upload response uncertain'));
    await service.build(tenant, actorId, reportId, operationKey);
    vault.findEvidenceVersion.mockRejectedValueOnce(new Error('provider unavailable'));
    expect(await service.retryMissing(tenant, actorId, reportId, operationKey)).toMatchObject({
      status: 'pending',
    });
    expect(vault.seal).toHaveBeenCalledTimes(1);
  });

  it('refuses corrupted provider bytes and access revoked during a PDF read', async () => {
    const { fixture, service, vault, pdfBytes } = setup();
    await service.build(tenant, actorId, reportId, operationKey);
    const report = fixture.rows('reports')[0]!;
    report.status = 'published';
    report.released_archive_hash = sha(pdfBytes);
    vault.retrieve.mockResolvedValueOnce({
      body: Buffer.from('%PDF-corrupt'),
      contentHash: sha('%PDF-corrupt'),
      metadata: {},
      contentType: 'application/pdf',
      retainUntil: new Date('2034-01-01T00:00:00Z'),
      lockMode: 'COMPLIANCE',
      versionId: 'version-application/pdf',
      encryption: 'AES256',
    });
    await expect(service.pdf(tenant, actorId, reportId)).rejects.toMatchObject({
      code: 'provider_verification_failed',
    });
    vault.retrieve.mockImplementationOnce(async () => {
      fixture.rows('tenant_users').length = 0;
      return {
        body: pdfBytes,
        contentHash: sha(pdfBytes),
        metadata: {},
        contentType: 'application/pdf',
        retainUntil: new Date('2034-01-01T00:00:00Z'),
        lockMode: 'COMPLIANCE',
        versionId: 'version-application/pdf',
        encryption: 'AES256',
      };
    });
    await expect(service.pdf(tenant, actorId, reportId)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('refuses concurrent Chromium builds before opening a second heavy renderer', async () => {
    const { service, renderPdf, pdfBytes } = setup();
    let release: (() => void) | undefined;
    renderPdf.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              pdfBuffer: pdfBytes,
              sha256: sha(pdfBytes),
              byteLength: pdfBytes.length,
              renderer: 'chromium',
            });
        }),
    );
    const first = service.build(tenant, actorId, reportId, operationKey);
    await vi.waitFor(() => expect(renderPdf).toHaveBeenCalledTimes(1));
    await expect(service.build(tenant, actorId, reportId, operationKey)).rejects.toMatchObject({
      code: 'report_capacity_unavailable',
    });
    expect(renderPdf).toHaveBeenCalledTimes(1);
    release?.();
    expect(await first).toMatchObject({ status: 'settled' });
  });
});
