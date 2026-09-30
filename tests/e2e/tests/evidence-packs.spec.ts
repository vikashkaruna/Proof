import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  createMfaAccount,
  selectTenant,
  signIn,
  signInAs,
  satisfyLoginMfaWithSecret,
  state,
} from '../fixtures';
import { repoRoot, acceptanceTarget } from '../target';
import { EvidenceVault } from '../../../packages/evidence/src/index';
const execFileAsync = promisify(execFile);
async function providerAction(action: '--pause-provider' | '--resume-provider') {
  const directory = process.env.AXIOM_EVIDENCE_FIXTURE_DIRECTORY;
  if (!directory) throw new Error('Owned evidence fixture required');
  await execFileAsync(
    'python3',
    [`${repoRoot}/scripts/test-evidence-storage.py`, '--directory', directory, action],
    { cwd: repoRoot, timeout: 100_000 },
  );
}
async function post(page: Page, path: string, body: unknown, tenantId = state.tenantA.id) {
  return page.request.post(`/api/bff/v1${path}`, {
    headers: { 'x-tenant-id': tenantId, 'idempotency-key': crypto.randomUUID() },
    data: body,
  });
}
async function upload(page: Page) {
  const id = crypto.randomUUID();
  const filename = `pack-member-${id}.txt`;
  const bytes = Buffer.from(`Synthetic human evidence for pack ${id}\n`);
  const response = await post(page, '/evidence/ingestions', {
    operationKey: id,
    filename,
    contentType: 'text/plain',
    evidenceType: 'document',
    description: `Pack member ${id}`,
    controlIds: [],
    engagementId: null,
    contentBase64: bytes.toString('base64'),
  });
  expect(response.status()).toBe(201);
  const { data } = (await response.json()) as { data: { evidenceId: string } };
  return { filename, bytes, evidenceId: data.evidenceId };
}
async function openReport(page: Page, title: string) {
  await page.goto('/reports');
  await page
    .getByRole('region', { name: 'Recorded reports' })
    .getByRole('button', { name: new RegExp(title) })
    .click();
  const detail = page.getByRole('region', { name: 'Report detail' });
  await expect(detail.getByRole('heading', { name: title, exact: true })).toBeVisible();
  return detail;
}
async function founder(page: Page, label: string) {
  const account = await createMfaAccount(label, {
    role: 'founder',
    isInternal: true,
    withFactor: true,
  });
  await signInAs(page, account.email, account.password);
  await selectTenant(page, 'a');
  await satisfyLoginMfaWithSecret(page, account.totpSecret!);
}

/** Board acceptance adds real engagements. Find the seeded one through the
 * same bounded picker a human uses instead of assuming it remains on page 1. */
async function selectEngagement(form: Locator, id: string) {
  const select = form.getByLabel('Engagement scope');
  const next = form.getByRole('button', { name: 'Next engagements' });
  for (let page = 0; page < 100; page++) {
    await expect(select).toBeEnabled();
    if (await select.locator(`option[value="${id}"]`).count()) {
      await select.selectOption(id);
      return;
    }
    if (!(await next.isEnabled())) break;
    const before = (await select.locator('option').allTextContents()).join('|');
    await next.click();
    await expect
      .poll(async () => (await select.locator('option').allTextContents()).join('|'))
      .not.toBe(before);
  }
  throw new Error('Seeded engagement is absent from every displayed engagement page');
}

/** Real crash boundary: sanctioned build intent + optional real provider PUT,
 * deliberately no settlement. All credentials remain private synthetic fixture state. */
async function pendingArchive(
  page: Page,
  packId: string,
  member: Awaited<ReturnType<typeof upload>>,
  seal: boolean,
) {
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
    !secretAccessKey
  )
    throw new Error('Owned local synthetic fixture required');
  const response = await page.request.get(`/api/bff/v1/evidence-packs/${packId}`);
  expect(response.status()).toBe(200);
  const { data: pack } = (await response.json()) as {
    data: {
      manifestText: string;
      manifestHash: string;
      review: { reviewText: string; reviewHash: string };
    };
  };
  const directory = await mkdtemp(join(tmpdir(), 'axiom-pack-fixture-'));
  let archive: { archive: Buffer; archiveSha256: string; byteSize: number };
  try {
    const inputPath = join(directory, 'input.json');
    const outputPath = join(directory, 'archive.zip');
    await writeFile(
      inputPath,
      JSON.stringify({
        manifestText: pack.manifestText,
        expectedManifestSha256: pack.manifestHash,
        reviewText: pack.review.reviewText,
        expectedReviewSha256: pack.review.reviewHash,
        evidenceId: member.evidenceId,
        contentBase64: member.bytes.toString('base64'),
      }),
      { mode: 0o600 },
    );
    const built = await execFileAsync(
      'pnpm',
      [
        'exec',
        'tsx',
        `${repoRoot}/tests/e2e/fixtures/build-evidence-pack.mts`,
        inputPath,
        outputPath,
      ],
      { cwd: repoRoot, timeout: 30_000 },
    );
    const metadata = JSON.parse(built.stdout) as { archiveSha256: string; byteSize: number };
    archive = { ...metadata, archive: await readFile(outputPath) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const operationKey = crypto.randomUUID();
  const key = `tenants/${state.tenantA.id}/evidence-packs/${packId}/${operationKey}/${archive.archiveSha256}`;
  const begun = await fetch(`${state.supabaseUrl}/rest/v1/rpc/begin_evidence_pack_build`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      apikey: state.publishableKey,
      authorization: `Bearer ${state.serviceKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      p_tenant_id: state.tenantA.id,
      p_actor_id: state.accounts.owner.id,
      p_pack_id: packId,
      p_operation_key: operationKey,
      p_correlation_id: crypto.randomUUID(),
      p_request: {
        provider: 's3-compatible',
        bucket,
        object_key: key,
        content_hash: archive.archiveSha256,
        byte_size: archive.byteSize,
        manifest_sha256: pack.manifestHash,
        review_sha256: pack.review.reviewHash,
        retention_policy: 'seven_years',
        legal_hold: false,
      },
    }),
  });
  expect(begun.status).toBe(200);
  const intent = (await begun.json()) as {
    build_id: string;
    retain_until: string;
    status: string;
    replayed: boolean;
  };
  expect(intent).toMatchObject({ status: 'pending', replayed: false });
  const vault = new EvidenceVault('ap-south-1', endpoint, { accessKeyId, secretAccessKey });
  try {
    const stored = seal
      ? await vault.seal({
          bucket,
          key,
          body: archive.archive,
          contentType: 'application/zip',
          retentionDays: 2555,
          retainUntil: intent.retain_until,
          tenantId: state.tenantA.id,
          engagementId: state.engagementA,
          collectedByAgent: 'evidence-pack-builder',
          operationId: intent.build_id,
        })
      : null;
    return {
      operationKey,
      archiveHash: archive.archiveSha256,
      byteSize: archive.byteSize,
      versionId: stored?.versionId ?? null,
      bucket,
      key,
      buildId: intent.build_id,
    };
  } finally {
    vault.close();
  }
}

/** Provider observation, not a DB-state proxy: zero versions or exactly the
 * original version. findEvidenceVersion refuses multiple exact-key versions,
 * delete markers and truncated results before checking protected metadata. */
async function assertProviderVersionUnchanged(intent: Awaited<ReturnType<typeof pendingArchive>>) {
  const endpoint = process.env.AXIOM_STORAGE_ENDPOINT;
  const accessKeyId = process.env.AXIOM_STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AXIOM_STORAGE_SECRET_ACCESS_KEY;
  if (
    acceptanceTarget ||
    !process.env.AXIOM_EVIDENCE_FIXTURE_DIRECTORY ||
    !endpoint ||
    new URL(endpoint).hostname !== '127.0.0.1' ||
    !accessKeyId ||
    !secretAccessKey
  )
    throw new Error('Owned local synthetic fixture required');
  const vault = new EvidenceVault('ap-south-1', endpoint, { accessKeyId, secretAccessKey });
  try {
    const found = await vault.findEvidenceVersion(
      intent.bucket,
      intent.key,
      {
        tenantId: state.tenantA.id,
        engagementId: state.engagementA,
        collectedByAgent: 'evidence-pack-builder',
        operationId: intent.buildId,
        contentHash: intent.archiveHash,
        byteSize: intent.byteSize,
      },
      { timeoutMs: 10_000, maxBytes: 64 * 1024 * 1024 },
    );
    expect(found).toEqual(intent.versionId ? { versionId: intent.versionId } : null);
  } finally {
    vault.close();
  }
}

test.describe('retained evidence pack acceptance', () => {
  test.skip(
    process.env.AXIOM_EVIDENCE_STORAGE_ACCEPTANCE !== 'true',
    'Requires the owned Object Lock provider fixture.',
  );
  test('manager prepares, founder reviews, archive is retained and released bytes verify independently', async ({
    page,
    browser,
  }, testInfo) => {
    test.setTimeout(240_000);
    await signIn(page, 'owner');
    await selectTenant(page, 'a');
    const member = await upload(page);
    const title = `Auditor pack ${crypto.randomUUID()}`;
    await page.goto('/reports');
    await page.locator('summary').filter({ hasText: 'Prepare evidence pack' }).click();
    const finder = page.getByRole('form', { name: 'Find pack evidence' });
    await finder.getByLabel('Description or evidence UUID').fill(member.evidenceId);
    await finder.getByRole('button', { name: 'Find evidence', exact: true }).click();
    await page.getByLabel('Available evidence versions').getByRole('checkbox').check();
    const form = page.getByRole('form', { name: 'Prepare pack', exact: true });
    await form.getByLabel('Pack title', { exact: true }).fill(title);
    await selectEngagement(form, state.engagementA);
    await form.getByRole('checkbox').check();
    // Metadata edits revoke approval of the selection before any write.
    await form.getByLabel('Pack title', { exact: true }).fill(`${title} revised`);
    await expect(form.getByRole('checkbox')).not.toBeChecked();
    await form.getByLabel('Pack title', { exact: true }).fill(title);
    await selectEngagement(form, state.engagementA);
    await form.getByRole('checkbox').check();
    const prepareResponse = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === '/api/bff/v1/evidence-packs' &&
        r.request().method() === 'POST',
    );
    await form.getByRole('button', { name: 'Prepare pack for review', exact: true }).click();
    const prepared = await prepareResponse;
    expect(prepared.status()).toBe(201);
    const { data: pack } = (await prepared.json()) as {
      data: { id: string; reportId: string; manifestHash: string };
    };
    const initial = page.getByRole('region', { name: 'Report detail' });
    await expect(initial.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(initial.getByRole('button', { name: 'Approve reviewed content' })).toHaveCount(0);
    expect(
      (
        await post(page, `/reports/${pack.reportId}/review`, {
          decision: 'approved',
          expectedContentHash: pack.manifestHash,
        })
      ).status(),
    ).toBe(403);
    expect((await page.request.get(`/api/bff/v1/evidence-packs/${pack.id}/content`)).status()).toBe(
      409,
    );
    const viewerContext = await browser.newContext();
    const viewer = await viewerContext.newPage();
    await signIn(viewer, 'viewer');
    await selectTenant(viewer, 'a');
    expect((await viewer.request.get(`/api/bff/v1/reports/${pack.reportId}`)).status()).toBe(404);
    const founderContext = await browser.newContext();
    const founderPage = await founderContext.newPage();
    try {
      await founder(founderPage, 'pack-release');
      const detail = await openReport(founderPage, title);
      await expect(detail.getByRole('link', { name: member.filename })).toBeVisible();
      expect(
        (
          await post(founderPage, `/reports/${pack.reportId}/review`, {
            decision: 'approved',
            expectedContentHash: 'f'.repeat(64),
          })
        ).status(),
      ).toBe(409);
      await detail
        .getByRole('checkbox', { name: 'I reviewed the exact content and SHA-256 shown above.' })
        .check();
      await detail.getByRole('button', { name: 'Approve reviewed content' }).click();
      await expect(detail.getByText(/approved by/)).toBeVisible();
      expect(
        (
          await post(founderPage, `/reports/${pack.reportId}/release`, {
            expectedContentHash: pack.manifestHash,
            expectedArchiveHash: null,
          })
        ).status(),
      ).toBe(409);
      const ownerDetail = await openReport(page, title);
      await ownerDetail
        .getByRole('checkbox', {
          name: 'I authorize building and retaining these approved pack bytes for seven years.',
        })
        .check();
      const buildResponse = page.waitForResponse(
        (r) => new URL(r.url()).pathname === `/api/bff/v1/evidence-packs/${pack.id}/build`,
      );
      await ownerDetail.getByRole('button', { name: 'Build retained archive' }).click();
      const built = await buildResponse;
      expect(built.status()).toBe(200);
      const { data: builtPack } = (await built.json()) as {
        data: { archive: { contentHash: string; byteSize: number } };
      };
      await expect(ownerDetail.getByText(/Retained archive ·/)).toBeVisible();
      expect(
        (await page.request.get(`/api/bff/v1/evidence-packs/${pack.id}/content`)).status(),
      ).toBe(409);
      await detail.getByRole('button', { name: 'Refresh report detail' }).click();
      await expect(detail.getByText(/Archive SHA-256:/)).toBeVisible();
      expect(
        (
          await post(founderPage, `/reports/${pack.reportId}/release`, {
            expectedContentHash: pack.manifestHash,
            expectedArchiveHash: 'e'.repeat(64),
          })
        ).status(),
      ).toBe(409);
      await detail
        .getByRole('checkbox', {
          name: 'I reviewed this content and its recorded artifact hash and authorize release to this tenant.',
        })
        .check();
      await detail.getByRole('button', { name: 'Release reviewed report' }).click();
      await expect(detail.getByRole('button', { name: 'Download released pack' })).toBeVisible();
      await ownerDetail.getByRole('button', { name: 'Refresh report detail' }).click();
      const downloadEvent = page.waitForEvent('download');
      await ownerDetail.getByRole('button', { name: 'Download released pack' }).click();
      const download = await downloadEvent;
      const archivePath = testInfo.outputPath('released-pack.zip');
      await download.saveAs(archivePath);
      const archive = await readFile(archivePath);
      expect(archive.length).toBe(builtPack.archive.byteSize);
      expect(createHash('sha256').update(archive).digest('hex')).toBe(
        builtPack.archive.contentHash,
      );
      const args = [
        `${repoRoot}/packages/report-kit/python/verify_evidence_pack.py`,
        archivePath,
        '--expected-archive-sha256',
        builtPack.archive.contentHash,
        '--expected-manifest-sha256',
        pack.manifestHash,
      ];
      const verified = await execFileAsync('python3', args, { cwd: repoRoot, timeout: 30_000 });
      expect(verified.stdout).toContain('verified');
      archive[Math.floor(archive.length / 2)]! ^= 1;
      const corrupt = testInfo.outputPath('corrupt-pack.zip');
      await writeFile(corrupt, archive);
      await expect(
        execFileAsync('python3', [args[0]!, corrupt, ...args.slice(2)], {
          cwd: repoRoot,
          timeout: 30_000,
        }),
      ).rejects.toThrow();
      expect((await viewer.request.get(`/api/bff/v1/reports/${pack.reportId}`)).status()).toBe(200);
      expect(
        (await viewer.request.get(`/api/bff/v1/evidence-packs/${pack.id}/content`)).status(),
      ).toBe(403);
      await providerAction('--pause-provider');
      try {
        await ownerDetail.getByRole('button', { name: 'Download released pack' }).click();
        await expect(ownerDetail.getByRole('alert')).toBeVisible({ timeout: 75_000 });
        await expect(ownerDetail).not.toContainText(
          'Downloaded bytes match the recorded release hash.',
        );
      } finally {
        await providerAction('--resume-provider');
      }
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        390,
      );
      await page.screenshot({ path: testInfo.outputPath('pack-mobile.png'), fullPage: true });
    } finally {
      await founderContext.close();
      await viewerContext.close();
    }
  });

  test('prepare uncertainty replays one pack; read failures and reviewer rejection stay honest', async ({
    page,
    browser,
  }) => {
    test.setTimeout(180_000);
    await signIn(page, 'owner');
    await selectTenant(page, 'a');
    const member = await upload(page);
    const title = `Rejected pack ${crypto.randomUUID()}`;
    let body!: {
      operationKey: string;
      title: string;
      evidenceReceiptIds: string[];
      engagementId: string;
    };
    let pack!: { id: string; reportId: string; manifestHash: string };
    await page.goto('/reports');
    await page.locator('summary').filter({ hasText: 'Prepare evidence pack' }).click();
    const finder = page.getByRole('form', { name: 'Find pack evidence' });
    await finder.getByLabel('Description or evidence UUID').fill(member.evidenceId);
    await finder.getByRole('button', { name: 'Find evidence', exact: true }).click();
    await page.getByLabel('Available evidence versions').getByRole('checkbox').check();
    const form = page.getByRole('form', { name: 'Prepare pack', exact: true });
    await form.getByLabel('Pack title', { exact: true }).fill(title);
    await selectEngagement(form, state.engagementA);
    await form.getByRole('checkbox').check();
    // The real server commits; only its response is deliberately lost.
    await page.route(
      '**/api/bff/v1/evidence-packs',
      async (route) => {
        body = route.request().postDataJSON() as typeof body;
        const committed = await route.fetch();
        expect(committed.status()).toBe(201);
        pack = (await committed.json()).data as typeof pack;
        await route.abort('failed');
      },
      { times: 1 },
    );
    await form.getByRole('button', { name: 'Prepare pack for review', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText('outcome is uncertain');
    await page.getByRole('button', { name: 'Refresh reports', exact: true }).click();
    await expect(
      page
        .getByRole('region', { name: 'Recorded reports' })
        .getByRole('button', { name: new RegExp(title) }),
    ).toBeVisible();
    const repeat = await post(page, '/evidence-packs', body);
    expect(repeat.status()).toBe(201);
    expect((await repeat.json()).data.id).toBe(pack.id);
    expect(
      (await post(page, '/evidence-packs', { ...body, title: 'Changed selection' })).status(),
    ).toBe(409);
    await page.route('**/api/bff/v1/reports?*', (route) => route.abort('failed'));
    await page.goto('/reports');
    const list = page.getByRole('region', { name: 'Recorded reports' });
    await expect(list.getByRole('alert')).toBeVisible();
    await expect(list).not.toContainText('No reports recorded');
    await page.unroute('**/api/bff/v1/reports?*');
    await list.getByRole('button', { name: 'Refresh reports' }).click();
    await expect(list.getByRole('button', { name: new RegExp(body.title) })).toBeVisible();
    const context = await browser.newContext();
    const reviewer = await context.newPage();
    try {
      await founder(reviewer, 'pack-reject');
      const detail = await openReport(reviewer, body.title);
      await detail
        .getByRole('checkbox', { name: 'I reviewed the exact content and SHA-256 shown above.' })
        .check();
      await detail.getByLabel('Review note (required for rejection)').fill('  ');
      await expect(detail.getByRole('button', { name: 'Reject with reason' })).toBeDisabled();
      await detail
        .getByLabel('Review note (required for rejection)')
        .fill('Source scope needs a revised submission.');
      await detail.getByRole('button', { name: 'Reject with reason' }).click();
      await expect(
        detail.getByText('Review note: Source scope needs a revised submission.'),
      ).toBeVisible();
      await expect(detail.getByRole('button', { name: 'Build retained archive' })).toHaveCount(0);
      expect(
        (
          await post(page, `/evidence-packs/${pack.id}/build`, {
            operationKey: crypto.randomUUID(),
          })
        ).status(),
      ).toBe(409);
    } finally {
      await context.close();
    }
  });
  test('lost archive settlement reconciles exact bytes while begin-only storage stays pending', async ({
    page,
    browser,
  }) => {
    test.setTimeout(180_000);
    await signIn(page, 'owner');
    await selectTenant(page, 'a');
    const member = await upload(page);
    const evidence = await page.request.get(`/api/bff/v1/evidence?q=${member.evidenceId}`);
    const { data: rows } = (await evidence.json()) as {
      data: { object_version: { id: string } }[];
    };
    const context = await browser.newContext();
    const reviewer = await context.newPage();
    try {
      await founder(reviewer, 'pack-recovery');
      for (const seal of [true, false]) {
        const title = `${seal ? 'Interrupted archive' : 'No object archive'} ${crypto.randomUUID()}`;
        const prepared = await post(page, '/evidence-packs', {
          operationKey: crypto.randomUUID(),
          title,
          evidenceReceiptIds: [rows[0]!.object_version.id],
          engagementId: state.engagementA,
        });
        expect(prepared.status()).toBe(201);
        const { data: pack } = (await prepared.json()) as {
          data: { id: string; reportId: string; manifestHash: string };
        };
        expect(
          (
            await post(reviewer, `/reports/${pack.reportId}/review`, {
              decision: 'approved',
              expectedContentHash: pack.manifestHash,
            })
          ).status(),
        ).toBe(200);
        const intent = await pendingArchive(page, pack.id, member, seal);
        await assertProviderVersionUnchanged(intent);
        const detail = await openReport(page, title);
        await expect(detail.getByRole('button', { name: 'Build retained archive' })).toHaveCount(0);
        const reconciling = page.waitForResponse(
          (r) =>
            new URL(r.url()).pathname ===
            `/api/bff/v1/evidence-packs/${pack.id}/builds/${intent.operationKey}/reconcile`,
        );
        await detail.getByRole('button', { name: 'Reconcile archive storage' }).click();
        const result = await reconciling;
        expect(result.status()).toBe(seal ? 200 : 202);
        const { data: reconciled } = (await result.json()) as {
          data: {
            build: { status: string };
            archive: null | { contentHash: string; versionId: string };
          };
        };
        if (seal) {
          expect(reconciled.archive).toMatchObject({
            contentHash: intent.archiveHash,
            versionId: intent.versionId,
          });
          await expect(detail.getByText(/Retained archive ·/)).toBeVisible();
        } else {
          expect(reconciled.archive).toBeNull();
          expect(reconciled.build.status).toBe('pending');
          await expect(detail).toContainText('cannot create an object that was never uploaded');
        }
        const replay = await post(page, `/evidence-packs/${pack.id}/build`, {
          operationKey: intent.operationKey,
        });
        expect(replay.status()).toBe(seal ? 200 : 202);
        const replayed = (await replay.json()).data;
        if (seal)
          expect(replayed.archive).toMatchObject({
            contentHash: intent.archiveHash,
            versionId: intent.versionId,
          });
        else expect(replayed.archive).toBeNull();
        // COMPLIANCE prevents deleting an extra retained version to hide a PUT.
        // This checks committed provider versions; unit call counts cover attempts.
        await assertProviderVersionUnchanged(intent);
        expect(
          (await page.request.get(`/api/bff/v1/evidence-packs/${pack.id}/content`)).status(),
        ).toBe(409);
      }
    } finally {
      await context.close();
    }
  });
});
