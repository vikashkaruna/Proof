/** Real GoTrue, founder UI, PostgreSQL source RPCs and retained Object Lock versions.
 * Requires the combined ordered 0088–0094 migration chain and the owned provider.
 */
import { createHash } from 'node:crypto';
import { test, expect, type APIResponse, type Page, type Route } from '@playwright/test';
import {
  createMfaAccount,
  selectTenant,
  signIn,
  signInAs,
  satisfyLoginMfaWithSecret,
  state,
} from '../fixtures';
import { acceptanceTarget } from '../target';
import { insertLocalFixtureRow } from '../local-db';
import { EvidenceVault } from '../../../packages/evidence/src/index';
import { unzipSync } from 'fflate';

type Format = 'dpb' | 'technical';
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const digest = /^[0-9a-f]{64}$/;

function localFixture() {
  const endpoint = process.env.AXIOM_STORAGE_ENDPOINT;
  const bucket = process.env.AXIOM_EVIDENCE_BUCKET;
  const accessKeyId = process.env.AXIOM_STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AXIOM_STORAGE_SECRET_ACCESS_KEY;
  if (
    acceptanceTarget ||
    !endpoint ||
    new URL(endpoint).hostname !== '127.0.0.1' ||
    new URL(state.supabaseUrl).hostname !== '127.0.0.1' ||
    !bucket ||
    !accessKeyId ||
    !secretAccessKey ||
    !process.env.AXIOM_EVIDENCE_FIXTURE_DIRECTORY
  )
    throw new Error('Owned local retained-provider fixture required');
  return { endpoint, bucket, accessKeyId, secretAccessKey };
}

async function database(path: string) {
  const response = await fetch(`${state.supabaseUrl}/rest/v1/${path}`, {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      apikey: state.publishableKey,
      authorization: `Bearer ${state.serviceKey}`,
    },
  });
  if (!response.ok) throw new Error(`Fixture read ${path}: HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}

async function post(page: Page, path: string, body: unknown) {
  return page.request.post(`/api/bff/v1${path}`, {
    headers: { 'x-tenant-id': state.tenantA.id, 'idempotency-key': crypto.randomUUID() },
    data: body,
  });
}

async function successful(response: APIResponse, expected: number) {
  expect(response.status(), await response.text()).toBe(expected);
  return response.json() as Promise<Record<string, unknown>>;
}

async function technicalSource() {
  // Synthetic source setup only. The plan never asserts dry-run, rollback,
  // approval or execution; request/draft/review/release use sanctioned RPCs.
  // Plans and actions are not writable through the service credential (0099).
  const seed = insertLocalFixtureRow;
  const planId = crypto.randomUUID();
  await seed('remediation_plans', {
    id: planId,
    tenant_id: state.tenantA.id,
    engagement_id: state.engagementA,
    library_version: state.libraryVersion,
    title: `Synthetic technical plan ${planId}`,
    status: 'draft',
  });
  await seed('remediation_actions', {
    id: crypto.randomUUID(),
    tenant_id: state.tenantA.id,
    plan_id: planId,
    sequence: 1,
    action_type: 'data.mask',
    parameters: { columns: ['synthetic_email'] },
    description: 'Proposed mask of a synthetic email field; not executed.',
    risk_score: 10,
    rollback_definition: { restore: 'synthetic-snapshot' },
    rollback_validated: false,
  });
  return { sourceId: planId, title: `Technical register ${crypto.randomUUID()}` };
}

async function dpbSource(owner: Page, founder: Page) {
  const breach = await successful(
    await post(owner, '/breaches', {
      title: `DPB provider breach ${crypto.randomUUID()}`,
      description: 'Synthetic breach for reviewed notification source acceptance.',
      severity: 'medium',
      dataCategories: ['synthetic-email'],
      affectedCount: 2,
    }),
    201,
  );
  const breachId = (breach.data as { breachId: string }).breachId;
  const draft = await successful(
    await post(owner, `/breaches/${breachId}/notifications`, {
      kind: 'dpb',
      language: 'en',
      subject: 'Synthetic DPB notification for provider acceptance',
      body: 'The recorded synthetic breach concerns two test data principals. This is a reviewed draft, not a regulator filing.',
    }),
    201,
  );
  const notificationId = (draft.data as { notificationId: string }).notificationId;
  const unreviewed = await post(owner, '/reports/dpb/request', {
    breachId,
    notificationId,
    title: 'Unreviewed notification must fail',
    operationKey: crypto.randomUUID(),
  });
  expect(unreviewed.status()).toBe(409);
  expect((await unreviewed.json()).error.code).toBe('notification_not_reviewed');
  const selfReview = await post(owner, `/breach-notifications/${notificationId}/review`, {});
  expect(selfReview.status()).toBe(409);
  await successful(await post(founder, `/breach-notifications/${notificationId}/review`, {}), 200);
  return {
    sourceId: notificationId,
    breachId,
    title: `DPB review pack ${crypto.randomUUID()}`,
  };
}

async function exactRetainedVersions(
  format: Format,
  reportId: string,
  buildId: string,
  sourceText: string,
) {
  const kind = format === 'dpb' ? 'dpb_pdf' : 'technical_pdf';
  const rows = (await database(
    `${format}_artifact_versions?build_id=eq.${buildId}&select=artifact_kind,bucket,object_key,version_id,content_hash,byte_size,retain_until&order=artifact_kind.asc`,
  )) as Array<{
    artifact_kind: string;
    bucket: string;
    object_key: string;
    version_id: string;
    content_hash: string;
    byte_size: number;
    retain_until: string;
  }>;
  expect(rows.map((row) => row.artifact_kind)).toEqual([kind, 'source_json'].sort());
  const config = localFixture();
  const vault = new EvidenceVault('ap-south-1', config.endpoint, config);
  try {
    for (const row of rows) {
      const retained = await vault.retrieve(row.bucket, row.object_key, row.version_id, {
        maxBytes: 32 * 1024 * 1024,
        timeoutMs: 30_000,
      });
      expect(retained.body.length).toBe(row.byte_size);
      expect(sha(retained.body)).toBe(row.content_hash);
      if (row.artifact_kind === 'source_json')
        expect(retained.body.toString('utf8')).toBe(sourceText);
      else expect(retained.body.subarray(0, 5).toString()).toBe('%PDF-');
      expect(new Date(row.retain_until).getTime()).toBeGreaterThan(
        Date.now() + 6 * 365 * 86400_000,
      );
    }
  } finally {
    vault.close();
  }
  const pdf = rows.find((row) => row.artifact_kind === kind)!;
  expect(pdf.object_key).toContain(reportId);
  return pdf;
}

for (const format of ['technical', 'dpb'] as const) {
  test(`real-provider ${format} source, founder UI review, retained versions and guarded release`, async ({
    browser,
  }) => {
    test.setTimeout(420_000);
    localFixture();
    const ownerContext = await browser.newContext();
    const founderContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    try {
      const owner = await ownerContext.newPage();
      await signIn(owner, 'owner');
      await selectTenant(owner, 'a');
      const founder = await founderContext.newPage();
      const founderAccount = await createMfaAccount(`${format}-source-founder`, {
        role: 'founder',
        isInternal: true,
        withFactor: true,
      });
      await signInAs(founder, founderAccount.email, founderAccount.password);
      await selectTenant(founder, 'a');
      await satisfyLoginMfaWithSecret(founder, founderAccount.totpSecret!);
      const input =
        format === 'technical' ? await technicalSource() : await dpbSource(owner, founder);
      if (format === 'technical') {
        const absent = await post(owner, '/reports/technical/request', {
          planId: crypto.randomUUID(),
          title: 'Missing recorded plan must fail',
          operationKey: crypto.randomUUID(),
        });
        expect(absent.status()).toBe(409);
        expect((await absent.json()).error.code).toBe('plan_not_found');
      }
      const pagePath =
        format === 'technical' ? '/execution/technical-reviews' : '/breaches/dpb-reviews';
      await owner.goto(pagePath);
      await expect(
        owner.getByRole('heading', {
          name:
            format === 'technical'
              ? 'Recorded technical remediation registers'
              : 'DPB notification review packs',
        }),
      ).toBeVisible();
      await owner.locator('select').selectOption(input.sourceId);
      await owner
        .getByLabel(
          format === 'technical'
            ? 'Register title'
            : 'Internal reference title (not printed in the PDF)',
        )
        .fill(input.title);
      await owner.getByRole('button', { name: 'Freeze source' }).click();
      const ownerCard = owner.locator('article').filter({ hasText: input.title });
      await expect(ownerCard).toBeVisible();
      const requests = (await database(
        `${format}_report_requests?tenant_id=eq.${state.tenantA.id}&title=eq.${encodeURIComponent(input.title)}&select=id,report_id`,
      )) as Array<{ id: string; report_id: string | null }>;
      expect(requests).toHaveLength(1);
      const requestId = requests[0]!.id;
      const deniedDraft = await post(
        owner,
        `/reports/${format}/requests/${requestId}/generate`,
        {},
      );
      expect(deniedDraft.status()).toBe(403);
      const sourceRows = (await database(
        `${format}_request_sources?request_id=eq.${requestId}&select=source_text,source_sha256`,
      )) as Array<{ source_text: string; source_sha256: string }>;
      expect(sourceRows).toHaveLength(1);
      const source = sourceRows[0]!;
      expect(sha(source.source_text)).toBe(source.source_sha256);
      const frozen = JSON.parse(source.source_text) as {
        request_id: string;
        tenant_id: string;
        kind: string;
        plan?: { id: string };
        actions?: Array<{ id: string; dry_run: unknown; execution: unknown }>;
        breach?: { id: string };
        notification?: { id: string; status: string; reviewed_at: string };
        limitations: string[];
      };
      expect(frozen.request_id).toBe(requestId);
      expect(frozen.tenant_id).toBe(state.tenantA.id);
      expect(frozen.kind).toBe(
        format === 'technical' ? 'technical_plan_source' : 'dpb_breach_source',
      );
      expect(frozen.limitations).toHaveLength(3);
      if (format === 'technical') {
        expect(frozen.plan?.id).toBe(input.sourceId);
        expect(frozen.actions).toHaveLength(1);
        expect(frozen.actions?.[0]?.dry_run).toBeNull();
        expect(frozen.actions?.[0]?.execution).toBeNull();
      } else {
        expect(frozen.notification?.id).toBe(input.sourceId);
        expect(frozen.notification?.status).toBe('reviewed');
        expect(frozen.notification?.reviewed_at).toBeTruthy();
        expect('breachId' in input).toBe(true);
        if ('breachId' in input) expect(frozen.breach?.id).toBe(input.breachId);
      }

      await founder.goto(pagePath);
      const card = founder.locator('article').filter({ hasText: input.title });
      await expect(card).toBeVisible();
      await card.getByRole('button', { name: 'Create deterministic draft' }).click();
      await expect(card.getByRole('button', { name: 'Inspect frozen source' })).toBeVisible();
      const reportRows = (await database(
        `${format}_report_requests?id=eq.${requestId}&select=report_id`,
      )) as Array<{ report_id: string }>;
      const reportId = reportRows[0]!.report_id;
      const reports = (await database(
        `reports?id=eq.${reportId}&select=kind,status,content_text,content_sha256`,
      )) as Array<{
        kind: string;
        status: string;
        content_text: string;
        content_sha256: string;
      }>;
      const report = reports[0]!;
      expect(report.kind).toBe(format);
      expect(sha(report.content_text)).toBe(report.content_sha256);
      const manifest = JSON.parse(report.content_text) as {
        kind: string;
        source_sha256: string;
        request_id: string;
      };
      expect(manifest.kind).toBe(
        format === 'technical' ? 'technical_recorded_register' : 'dpb_notification_review_pack',
      );
      expect(manifest.source_sha256).toBe(source.source_sha256);
      expect(manifest.request_id).toBe(requestId);
      const prematurePdf = await founder.request.get(
        `/api/bff/v1/reports/${format}/${reportId}/pdf`,
      );
      expect(prematurePdf.status()).toBe(409);
      const prematureRelease = await post(founder, `/reports/${format}/${reportId}/release`, {
        contentHash: report.content_sha256,
        pdfHash: '0'.repeat(64),
      });
      expect(prematureRelease.status()).toBe(409);
      await card.getByRole('button', { name: 'Inspect frozen source' }).click();
      await expect(card.getByText('Frozen source, verified against its SHA-256')).toBeVisible();
      await card.getByRole('checkbox', { name: /I reviewed this source/ }).check();
      await card.getByRole('button', { name: 'Approve exact draft' }).click();
      await expect(card.getByRole('button', { name: 'Build retained versions' })).toBeVisible();
      let staleReadCompleted = false;
      const staleListMatch = (url: URL) =>
        format === 'dpb' &&
        url.pathname === '/api/bff/v1/reports/dpb/requests' &&
        url.searchParams.get('limit') === '50';
      const staleList = await founder.request.get(
        `/api/bff/v1/reports/${format}/requests?limit=50`,
        {
          headers: { 'x-tenant-id': state.tenantA.id },
        },
      );
      expect(staleList.status()).toBe(200);
      const staleListBody = await staleList.text();
      if (format === 'dpb') {
        const snapshot = JSON.parse(staleListBody) as {
          requests: Array<{ reportId: string; artifact: { status: string } | null }>;
        };
        expect(
          snapshot.requests.find((request) => request.reportId === reportId)?.artifact?.status,
        ).toBe('not_started');
      }
      const returnStaleList = async (route: Route) => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        await route.fulfill({ status: 200, contentType: 'application/json', body: staleListBody });
        staleReadCompleted = true;
      };
      if (format === 'dpb') await founder.route(staleListMatch, returnStaleList);
      const buildResponsePromise = founder.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.url().includes(`/reports/${format}/${reportId}/artifacts`),
      );
      await card.getByRole('button', { name: 'Build retained versions' }).click();
      const buildResponse = await buildResponsePromise;
      expect(buildResponse.status(), await buildResponse.text()).toBe(200);
      expect(((await buildResponse.json()) as { status: string }).status).toBe('settled');
      if (format === 'dpb') await expect.poll(() => staleReadCompleted).toBe(true);
      try {
        await expect(card.getByText('Retained artifacts: settled')).toBeVisible();
      } catch (cause) {
        if (format === 'dpb') await founder.unroute(staleListMatch, returnStaleList);
        const listResponse = await founder.request.get(
          `/api/bff/v1/reports/${format}/requests?limit=50`,
          {
            headers: { 'x-tenant-id': state.tenantA.id },
          },
        );
        const list = (await listResponse.json()) as {
          requests?: Array<{ reportId: string; artifact?: { status: string } }>;
        };
        const observed = list.requests?.find((request) => request.reportId === reportId);
        throw new Error(
          `Settled card did not refresh: list HTTP ${listResponse.status()}, artifact ${observed?.artifact?.status ?? 'missing'}`,
          { cause },
        );
      }
      if (format === 'dpb') await founder.unroute(staleListMatch, returnStaleList);
      const builds = (await database(
        `${format}_artifact_builds?report_id=eq.${reportId}&select=id,status`,
      )) as Array<{ id: string; status: string }>;
      expect(builds).toHaveLength(1);
      expect(builds[0]!.status).toBe('settled');
      const pdf = await exactRetainedVersions(format, reportId, builds[0]!.id, source.source_text);
      expect(pdf.content_hash).toMatch(digest);
      const wrongRelease = await post(founder, `/reports/${format}/${reportId}/release`, {
        contentHash: report.content_sha256,
        pdfHash: 'f'.repeat(64),
      });
      expect(wrongRelease.status()).toBe(409);
      const viewer = await viewerContext.newPage();
      await signIn(viewer, 'viewer');
      await selectTenant(viewer, 'a');
      expect(
        (await viewer.request.get(`/api/bff/v1/reports/${format}/${reportId}/pdf`)).status(),
      ).toBe(403);
      await card.getByRole('checkbox', { name: /I authorize release/ }).check();
      await card.getByRole('button', { name: 'Release exact PDF' }).click();
      await expect(card.getByRole('button', { name: 'Download verified PDF' })).toBeVisible();
      await card.getByRole('button', { name: 'Download verified PDF' }).click();
      await expect(
        founder
          .getByRole('status')
          .getByText('The downloaded PDF matches the recorded retained version.'),
      ).toBeVisible();
      const released = await viewer.request.get(`/api/bff/v1/reports/${format}/${reportId}/pdf`);
      expect(released.status()).toBe(200);
      expect(released.headers()['x-report-sha256']).toBe(pdf.content_hash);
      expect(sha(Buffer.from(await released.body()))).toBe(pdf.content_hash);
      // Pramaan is a derivative of this already released pack, never a new
      // execution/filing attestation. The DPB report has no engagement.
      const dossierType = format === 'dpb' ? 'dpb_statutory' : 'technical_register';
      const preparePath =
        format === 'dpb'
          ? '/closure/pramaan/dpb'
          : `/engagements/${state.engagementA}/closure/pramaan`;
      const unsupported = await post(owner, preparePath, {
        dossierType,
        reportId: crypto.randomUUID(),
        title: 'Foreign source',
        operationKey: crypto.randomUUID(),
      });
      expect(unsupported.status()).toBe(409);
      const dossierTitle = `${format} retained derivative ${crypto.randomUUID()}`;
      const prepared = await successful(
        await post(owner, preparePath, {
          dossierType,
          reportId,
          title: dossierTitle,
          operationKey: crypto.randomUUID(),
        }),
        201,
      );
      expect(prepared.status).toBe('settled');
      const dossierId = prepared.dossierId as string;
      const detail = await successful(
        await founder.request.get(`/api/bff/v1/dossiers/${dossierId}`, {
          headers: { 'x-tenant-id': state.tenantA.id },
        }),
        200,
      );
      expect(detail.dossierType).toBe(dossierType);
      expect(detail.engagementId).toBe(format === 'dpb' ? null : state.engagementA);
      expect(detail.sourceBound).toBe(true);
      expect(detail.archiveVersionId).toBeTruthy();
      expect(
        (
          await post(owner, `/dossiers/${dossierId}/seal`, {
            expectedProofSeal: detail.proofSealHash,
          })
        ).status(),
      ).toBe(403);
      await successful(
        await post(founder, `/dossiers/${dossierId}/seal`, {
          expectedProofSeal: detail.proofSealHash,
        }),
        200,
      );
      const archiveResponse = await founder.request.get(
        `/api/bff/v1/dossiers/${dossierId}/archive`,
        {
          headers: { 'x-tenant-id': state.tenantA.id },
        },
      );
      expect(archiveResponse.status()).toBe(200);
      const archiveBytes = Buffer.from(await archiveResponse.body());
      expect(sha(archiveBytes)).toBe(detail.archiveHash);
      const files = unzipSync(archiveBytes);
      const sourcePath =
        format === 'dpb' ? 'source/recorded-breach-notification.json' : 'source/recorded-plan.json';
      const pdfPath =
        format === 'dpb' ? 'source/dpb-review-pack.pdf' : 'source/technical-review-pack.pdf';
      expect(Buffer.from(files[sourcePath]!).toString('utf8')).toBe(source.source_text);
      expect(sha(Buffer.from(files[pdfPath]!))).toBe(pdf.content_hash);
      const archiveManifest = JSON.parse(Buffer.from(files['manifest.json']!).toString('utf8')) as {
        kind: string;
        engagement_id: string | null;
        limitations: string[];
        source: { versionId: string };
        [key: string]: unknown;
      };
      expect(archiveManifest.kind).toBe(
        format === 'dpb'
          ? 'pramaan_dpb_recorded_notification_source_archive'
          : 'pramaan_technical_register_source_archive',
      );
      expect(archiveManifest.engagement_id).toBe(format === 'dpb' ? null : state.engagementA);
      expect(archiveManifest.limitations.join(' ')).toContain(
        format === 'dpb'
          ? 'does not verify regulator receipt'
          : 'does not independently certify execution',
      );
      const archiveRows = (await database(
        `pramaan_${format}_archives?dossier_id=eq.${dossierId}&select=bucket,object_key,version_id,content_hash,lock_mode`,
      )) as Array<{
        bucket: string;
        object_key: string;
        version_id: string;
        content_hash: string;
        lock_mode: string;
      }>;
      expect(archiveRows).toHaveLength(1);
      expect(archiveRows[0]!.version_id).toBe(detail.archiveVersionId);
      expect(archiveRows[0]!.lock_mode).toBe('COMPLIANCE');
      const vaultConfig = localFixture();
      const archiveVault = new EvidenceVault('ap-south-1', vaultConfig.endpoint, vaultConfig);
      try {
        const exact = await archiveVault.retrieve(
          archiveRows[0]!.bucket,
          archiveRows[0]!.object_key,
          archiveRows[0]!.version_id,
          { maxBytes: 64 * 1024 * 1024, timeoutMs: 30_000 },
        );
        expect(exact.body).toEqual(archiveBytes);
        expect(sha(exact.body)).toBe(archiveRows[0]!.content_hash);
      } finally {
        archiveVault.close();
      }
      await founder.goto('/reports?tab=pramaan');
      await expect(founder.getByText('Source-bound closure dossiers')).toBeVisible();
      await expect(
        founder.locator('#pramaan-report option').filter({ hasText: input.title }),
      ).toHaveCount(1);
      const dossierRow = founder.getByRole('listitem').filter({ hasText: dossierTitle });
      await expect(dossierRow).toBeVisible();
      await dossierRow.getByRole('button', { name: 'View record' }).click();
      await expect(
        founder.getByText(
          format === 'dpb'
            ? /does not verify regulator receipt, acceptance, or statutory filing/
            : /does not independently certify execution, rollback, verification, or closure/,
        ),
      ).toBeVisible();
      if (format === 'dpb')
        await expect(founder.getByText('Tenant-level breach record')).toBeVisible();
      expect(
        (
          await post(owner, '/reports/email/dispatch', {
            dossierId,
            recipientEmail: 'audit@example.invalid',
          })
        ).status(),
      ).toBe(409);
    } finally {
      await Promise.all([ownerContext.close(), founderContext.close(), viewerContext.close()]);
    }
  });
}
