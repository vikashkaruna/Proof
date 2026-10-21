import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { config, evidenceFixture, foreign, tenant } from '../test/evidence-fixture.js';
import { StatutoryArtifactService } from './statutory-artifacts.js';
import { DpbArtifactService } from './dpb-artifacts.js';
import { TechnicalArtifactService } from './technical-artifacts.js';
import { StatutoryReportService } from './statutory-reports.js';
import { DpbReportService } from './dpb-reports.js';
import { TechnicalReportService } from './technical-reports.js';

const families = [
  { kind: 'auditor', prefix: 'statutory', agent: 'statutory-report-builder', pdf: 'statutory_pdf' },
  { kind: 'dpb', prefix: 'dpb', agent: 'dpb-report-builder', pdf: 'dpb_pdf' },
  {
    kind: 'technical',
    prefix: 'technical',
    agent: 'technical-report-builder',
    pdf: 'technical_pdf',
  },
] as const;
type Family = (typeof families)[number];
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** Transport fixtures deliberately leave the requesting founder unrelated to the report creator. */
function setup(family: Family) {
  const fixture = evidenceFixture();
  const actorId = randomUUID(),
    creatorId = randomUUID(),
    reportId = randomUUID();
  const requestId = randomUUID(),
    buildId = randomUUID(),
    operationKey = randomUUID();
  const sourceText = JSON.stringify({ immutable: 'historical source bytes' });
  const sourceBytes = Buffer.from(sourceText),
    pdfBytes = Buffer.from('%PDF-1.7\nretained synthetic PDF');
  const retainUntil = '2034-01-01T00:00:00.000Z';
  fixture.rows('users').push({ id: actorId, is_axiom_internal: true });
  fixture.rows('platform_founders').push({ user_id: actorId, revoked_at: null });
  fixture.rows('reports').push({
    id: reportId,
    tenant_id: tenant,
    engagement_id: randomUUID(),
    kind: family.kind,
    title: 'Different creator retained report',
    status: 'approved',
    created_by: creatorId,
    generated_by_agent: family.agent,
    content_text: '{}',
    content_sha256: sha('{}'),
    reviewed_content_hash: sha('{}'),
    released_archive_hash: null,
  });
  fixture.rows(`${family.prefix}_report_requests`).push({
    id: requestId,
    tenant_id: tenant,
    report_id: reportId,
    requested_by: creatorId,
    kind: family.kind,
    engagement_id: randomUUID(),
    assessment_run_id: randomUUID(),
    breach_id: randomUUID(),
    notification_id: randomUUID(),
    plan_id: randomUUID(),
    title: 'Different creator request',
    status: 'drafted',
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  });
  fixture.rows(`${family.prefix}_request_sources`).push({
    tenant_id: tenant,
    request_id: requestId,
    source_text: sourceText,
    source_sha256: sha(sourceText),
  });
  const artifacts = [
    {
      kind: 'source_json',
      object_key: 'retained/source',
      content_hash: sha(sourceBytes),
      byte_size: sourceBytes.length,
    },
    {
      kind: family.pdf,
      object_key: 'retained/pdf',
      content_hash: sha(pdfBytes),
      byte_size: pdfBytes.length,
    },
  ];
  fixture.rows(`${family.prefix}_artifact_builds`).push({
    id: buildId,
    tenant_id: tenant,
    report_id: reportId,
    operation_key: operationKey,
    status: 'settled',
    retain_until: retainUntil,
    correlation_id: randomUUID(),
    last_error_code: null,
    request: { ...config, artifacts },
  });
  for (const artifact of artifacts)
    fixture.rows(`${family.prefix}_artifact_versions`).push({
      id: randomUUID(),
      tenant_id: tenant,
      report_id: reportId,
      build_id: buildId,
      artifact_kind: artifact.kind,
      ...config,
      object_key: artifact.object_key,
      version_id: `historical-${artifact.kind}-version`,
      content_hash: artifact.content_hash,
      byte_size: artifact.byte_size,
      retain_until: retainUntil,
      legal_hold: false,
      encryption: 'AES256',
    });
  const template = awaitableReadback(fixture);
  fixture.vault.retrieve.mockImplementation(async (_bucket, key) => ({
    ...template,
    body: key === 'retained/source' ? sourceBytes : pdfBytes,
    contentHash: key === 'retained/source' ? sha(sourceBytes) : sha(pdfBytes),
  }));
  const storage = vi.fn(() => ({ config, vault: fixture.vault }));
  const artifactsService =
    family.kind === 'auditor'
      ? new StatutoryArtifactService(fixture.db, storage)
      : family.kind === 'dpb'
        ? new DpbArtifactService(fixture.db, storage)
        : new TechnicalArtifactService(fixture.db, storage);
  const reportService =
    family.kind === 'auditor'
      ? new StatutoryReportService(fixture.db)
      : family.kind === 'dpb'
        ? new DpbReportService(fixture.db)
        : new TechnicalReportService(fixture.db);
  const list = () =>
    reportService instanceof StatutoryReportService
      ? reportService.listAuditorRequests(tenant, actorId, 20, 0)
      : reportService.listRequests(tenant, actorId, 20, 0);
  return {
    fixture,
    actorId,
    creatorId,
    reportId,
    requestId,
    operationKey,
    sourceText,
    pdfBytes,
    artifactsService,
    reportService,
    storage,
    list,
  };
}
function awaitableReadback(fixture: ReturnType<typeof evidenceFixture>) {
  return {
    contentHash: '',
    metadata: {},
    contentType: 'application/pdf',
    retainUntil: new Date(fixture.verified.retainUntil),
    lockMode: 'COMPLIANCE' as const,
    versionId: 'historical-exact-version',
    encryption: 'AES256' as const,
  };
}

describe.each(families)('$kind global founder retained readers', (family) => {
  it.each(['absent', 'viewer', 'owner'] as const)(
    'reads another creator’s unpublished metadata, queue and exact PDF with %s membership',
    async (membership) => {
      const ctx = setup(family);
      if (membership !== 'absent')
        ctx.fixture.rows('tenant_users').push({
          tenant_id: tenant,
          user_id: ctx.actorId,
          role: membership,
        });
      const before = structuredClone(ctx.fixture.rows('reports'));
      expect((await ctx.list()).requests).toHaveLength(1);
      const status = await ctx.artifactsService.status(tenant, ctx.actorId, ctx.reportId);
      expect(status).toMatchObject({
        status: 'settled',
        operationKey: ctx.operationKey,
        pdf: { sha256: sha(ctx.pdfBytes), versionId: `historical-${family.pdf}-version` },
      });
      expect(JSON.stringify(status)).not.toContain('retained/pdf');
      const pdf = await ctx.artifactsService.pdf(tenant, ctx.actorId, ctx.reportId);
      expect(pdf.pdfBuffer).toEqual(ctx.pdfBytes);
      expect(ctx.fixture.vault.retrieve).toHaveBeenCalledWith(
        config.bucket,
        'retained/pdf',
        `historical-${family.pdf}-version`,
        expect.any(Object),
      );
      if (!(ctx.reportService instanceof StatutoryReportService)) {
        expect(await ctx.reportService.source(tenant, ctx.actorId, ctx.requestId)).toEqual({
          sourceText: ctx.sourceText,
          sourceSha256: sha(ctx.sourceText),
        });
      }
      expect(ctx.fixture.rows('reports')).toEqual(before);
      expect(ctx.fixture.calls).toEqual([]);
    },
  );

  it.each(['revoked', 'external', 'ordinary', 'internal-undesignated'] as const)(
    'denies %s cross-organization authority before vault reads',
    async (authority) => {
      const ctx = setup(family);
      ctx.fixture
        .rows('tenant_users')
        .push({ tenant_id: foreign, user_id: ctx.actorId, role: 'owner' });
      if (authority === 'revoked')
        ctx.fixture.rows('platform_founders')[0]!.revoked_at = '2026-10-01T00:00:00.000Z';
      if (authority === 'external') ctx.fixture.rows('users')[0]!.is_axiom_internal = false;
      if (authority === 'ordinary' || authority === 'internal-undesignated')
        ctx.fixture.rows('platform_founders').length = 0;
      if (authority === 'ordinary') ctx.fixture.rows('users')[0]!.is_axiom_internal = false;
      for (const operation of [
        ctx.list,
        () => ctx.artifactsService.status(tenant, ctx.actorId, ctx.reportId),
        () => ctx.artifactsService.pdf(tenant, ctx.actorId, ctx.reportId),
      ])
        await expect(operation()).rejects.toMatchObject({ code: 'forbidden', status: 403 });
      if (!(ctx.reportService instanceof StatutoryReportService))
        await expect(
          ctx.reportService.source(tenant, ctx.actorId, ctx.requestId),
        ).rejects.toMatchObject({ code: 'forbidden', status: 403 });
      expect(ctx.storage).not.toHaveBeenCalled();
      expect(ctx.fixture.vault.retrieve).not.toHaveBeenCalled();
    },
  );

  it('retains ordinary member access only to the released exact PDF', async () => {
    const ctx = setup(family);
    ctx.fixture.rows('platform_founders').length = 0;
    ctx.fixture.rows('users')[0]!.is_axiom_internal = false;
    ctx.fixture
      .rows('tenant_users')
      .push({ tenant_id: tenant, user_id: ctx.actorId, role: 'viewer' });
    await expect(ctx.artifactsService.pdf(tenant, ctx.actorId, ctx.reportId)).rejects.toMatchObject(
      { code: 'forbidden', status: 403 },
    );
    const report = ctx.fixture.rows('reports')[0]!;
    report.status = 'published';
    report.released_archive_hash = sha(ctx.pdfBytes);
    expect((await ctx.artifactsService.pdf(tenant, ctx.actorId, ctx.reportId)).pdfBuffer).toEqual(
      ctx.pdfBytes,
    );
    report.released_archive_hash = '0'.repeat(64);
    await expect(ctx.artifactsService.pdf(tenant, ctx.actorId, ctx.reportId)).rejects.toMatchObject(
      { code: 'report_artifact_unverified', status: 409 },
    );
  });

  it('fails closed when founder designation is revoked during provider readback', async () => {
    const ctx = setup(family);
    const retrieve = ctx.fixture.vault.retrieve.getMockImplementation()!;
    ctx.fixture.vault.retrieve.mockImplementation(async (...args) => {
      const result = await retrieve(...args);
      ctx.fixture.rows('platform_founders')[0]!.revoked_at = '2026-10-01T00:00:00.000Z';
      return result;
    });
    await expect(ctx.artifactsService.pdf(tenant, ctx.actorId, ctx.reportId)).rejects.toMatchObject(
      { code: 'forbidden', status: 403 },
    );
  });
});
