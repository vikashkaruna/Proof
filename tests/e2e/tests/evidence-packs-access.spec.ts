import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import {
  createMfaAccount,
  selectTenant,
  signInAs,
  satisfyLoginMfaWithSecret,
  state,
} from '../fixtures';
import { acceptanceTarget } from '../target';

async function post(page: Page, path: string, body: unknown, key = crypto.randomUUID()) {
  return page.request.post(`/api/bff/v1${path}`, {
    headers: { 'x-tenant-id': state.tenantA.id, 'idempotency-key': key },
    data: body,
  });
}

test('real pack access follows current membership and internal authority, including cached review and download', async ({
  page,
  browser,
}, testInfo) => {
  test.skip(
    process.env.AXIOM_EVIDENCE_STORAGE_ACCEPTANCE !== 'true',
    'Requires owned local Object Lock fixture.',
  );
  test.setTimeout(240_000);
  if (acceptanceTarget || new URL(state.supabaseUrl).hostname !== '127.0.0.1')
    throw new Error('Isolated local Auth/storage fixture required');
  const manager = await createMfaAccount('pack-access-manager', { role: 'admin' });
  const founder = await createMfaAccount('pack-access-founder', {
    role: 'founder',
    isInternal: true,
    withFactor: true,
  });
  const outsider = await createMfaAccount('pack-access-outsider', {
    role: 'founder',
    isInternal: true,
    withFactor: true,
  });
  const ownedAccounts = new Set([manager.id, founder.id, outsider.id]);
  // There is no membership-removal RPC. As in tenant-bridge acceptance, only
  // freshly created harness account authority is changed by fixture admin.
  // Evidence, reviews, build intents and receipts use their sanctioned paths.
  async function authority(id: string, kind: 'membership' | 'internal', body?: unknown) {
    if (!ownedAccounts.has(id)) throw new Error('Only isolated test accounts may change');
    const resource =
      kind === 'membership'
        ? `tenant_users?tenant_id=eq.${state.tenantA.id}&user_id=eq.${id}`
        : `users?id=eq.${id}`;
    const response = await fetch(`${state.supabaseUrl}/rest/v1/${resource}`, {
      method: body === undefined ? 'DELETE' : 'PATCH',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        apikey: state.publishableKey,
        authorization: `Bearer ${state.serviceKey}`,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.status).toBe(204);
  }
  await authority(outsider.id, 'membership');
  const foreignMembership = await fetch(`${state.supabaseUrl}/rest/v1/tenant_users`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      apikey: state.publishableKey,
      authorization: `Bearer ${state.serviceKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      tenant_id: state.tenantB.id,
      user_id: outsider.id,
      role: 'founder',
      approval_scopes: [],
    }),
  });
  expect(foreignMembership.status).toBe(201);
  await signInAs(page, manager.email, manager.password);
  await selectTenant(page, 'a');
  const memberKey = crypto.randomUUID();
  const title = `Pack authority ${memberKey}`;
  const uploaded = await post(page, '/evidence/ingestions', {
    operationKey: memberKey,
    filename: `${memberKey}.txt`,
    contentType: 'text/plain',
    evidenceType: 'document',
    description: title,
    controlIds: [],
    engagementId: null,
    contentBase64: Buffer.from(`Synthetic authority fixture ${memberKey}`).toString('base64'),
  });
  expect(uploaded.status()).toBe(201);
  const evidenceId = (await uploaded.json()).data.evidenceId as string;
  const evidence = await page.request.get(`/api/bff/v1/evidence?q=${evidenceId}`, {
    headers: { 'x-tenant-id': state.tenantA.id },
  });
  expect(evidence.status()).toBe(200);
  const receiptId = (await evidence.json()).data[0].object_version.id as string;
  const prepared = await post(page, '/evidence-packs', {
    operationKey: crypto.randomUUID(),
    title,
    evidenceReceiptIds: [receiptId],
    engagementId: state.engagementA,
  });
  expect(prepared.status()).toBe(201);
  const pack = (await prepared.json()).data as {
    id: string;
    reportId: string;
    manifestHash: string;
  };
  const founderContext = await browser.newContext();
  const outsiderContext = await browser.newContext();
  try {
    const reviewer = await founderContext.newPage();
    await signInAs(reviewer, founder.email, founder.password);
    await selectTenant(reviewer, 'a');
    await satisfyLoginMfaWithSecret(reviewer, founder.totpSecret!);
    const foreign = await outsiderContext.newPage();
    await signInAs(foreign, outsider.email, outsider.password);
    await selectTenant(foreign, 'b');
    await satisfyLoginMfaWithSecret(foreign, outsider.totpSecret!);
    for (const route of [`/reports/${pack.reportId}`, `/evidence-packs/${pack.id}/content`]) {
      expect(
        (
          await foreign.request.get(`/api/bff/v1${route}`, {
            headers: { 'x-tenant-id': state.tenantA.id },
          })
        ).status(),
      ).toBe(403);
      expect(
        (
          await foreign.request.get(`/api/bff/v1${route}`, {
            headers: { 'x-tenant-id': state.tenantB.id },
          })
        ).status(),
      ).toBe(404);
    }
    const reviewPath = `/reports/${pack.reportId}/review`;
    const reviewBody = { decision: 'approved', expectedContentHash: pack.manifestHash };
    const reviewKey = crypto.randomUUID();
    expect((await post(foreign, reviewPath, reviewBody)).status()).toBe(403);
    expect((await post(reviewer, reviewPath, reviewBody, reviewKey)).status()).toBe(200);
    await authority(founder.id, 'internal', { is_axiom_internal: false });
    // The identical idempotency key must not replay a cached success after revocation.
    expect((await post(reviewer, reviewPath, reviewBody, reviewKey)).status()).toBe(403);
    await authority(founder.id, 'internal', { is_axiom_internal: true });
    const built = await post(page, `/evidence-packs/${pack.id}/build`, {
      operationKey: crypto.randomUUID(),
    });
    expect(built.status()).toBe(200);
    const archiveHash = (await built.json()).data.archive.contentHash as string;
    expect(
      (
        await post(reviewer, `/reports/${pack.reportId}/release`, {
          expectedContentHash: pack.manifestHash,
          expectedArchiveHash: archiveHash,
        })
      ).status(),
    ).toBe(200);
    await page.goto('/reports');
    await page
      .getByRole('region', { name: 'Recorded reports' })
      .getByRole('button', { name: new RegExp(title) })
      .click();
    const detail = page.getByRole('region', { name: 'Report detail' });
    const downloaded = page.waitForEvent('download');
    await detail.getByRole('button', { name: 'Download released pack' }).click();
    const file = testInfo.outputPath('authority-released-pack.zip');
    await (await downloaded).saveAs(file);
    expect(
      createHash('sha256')
        .update(await readFile(file))
        .digest('hex'),
    ).toBe(archiveHash);
    await expect(detail).toContainText('Downloaded bytes match the recorded release hash.');
    await authority(manager.id, 'membership', { role: 'viewer' });
    let laterDownloads = 0;
    page.on('download', () => {
      laterDownloads++;
    });
    // Exercise the already rendered action, not just a new page with hidden controls.
    await detail.getByRole('button', { name: 'Download released pack' }).click();
    await expect(detail.getByRole('alert')).toBeVisible();
    await expect(detail).not.toContainText('Downloaded bytes match the recorded release hash.');
    expect(laterDownloads).toBe(0);
    expect(
      (
        await page.request.get(`/api/bff/v1/evidence-packs/${pack.id}/content`, {
          headers: { 'x-tenant-id': state.tenantA.id },
        })
      ).status(),
    ).toBe(403);
    await page.reload();
    await expect(page.getByRole('region', { name: 'Prepare evidence pack' })).toHaveCount(0);
    await page
      .getByRole('region', { name: 'Recorded reports' })
      .getByRole('button', { name: new RegExp(title) })
      .click();
    await expect(page.getByRole('button', { name: 'Download released pack' })).toHaveCount(0);
    expect(
      (
        await page.request.get(`/api/bff/v1/reports/${pack.reportId}`, {
          headers: { 'x-tenant-id': state.tenantA.id },
        })
      ).status(),
    ).toBe(200);
    await authority(manager.id, 'membership');
    expect(
      (
        await page.request.get(`/api/bff/v1/reports/${pack.reportId}`, {
          headers: { 'x-tenant-id': state.tenantA.id },
        })
      ).status(),
    ).toBe(403);
  } finally {
    await founderContext.close();
    await outsiderContext.close();
  }
});
