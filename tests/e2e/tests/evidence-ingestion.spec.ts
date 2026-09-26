import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { selectTenant, signIn, state } from '../fixtures';

// This journey requires the explicit Object Lock fixture and real GoTrue/BFF/DB.
// It never substitutes a provider mock or treats a legacy URI as a sealed receipt.
test.describe('real provider evidence ingestion', () => {
  test.skip(
    process.env.AXIOM_EVIDENCE_STORAGE_ACCEPTANCE !== 'true',
    'Enable only with the real Object Lock storage acceptance fixture.',
  );

  test('human upload, exact-version verification/download, replay and access controls', async ({
    page,
    browser,
  }) => {
    test.setTimeout(180_000);
    await signIn(page, 'owner');
    await selectTenant(page, 'a');
    await page.goto('/evidence');
    await expect(page.getByRole('heading', { name: 'Evidence vault', exact: true })).toBeVisible();

    const suffix = crypto.randomUUID();
    const filename = `provider-journey-${suffix}.bin`;
    const description = `Provider acceptance ${suffix}`;
    const bytes = Buffer.concat([
      Buffer.from(`Synthetic evidence ${suffix}\n`, 'utf8'),
      Buffer.from([0, 1, 127, 128, 254, 255]),
    ]);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const file = { name: filename, mimeType: 'application/octet-stream', buffer: bytes };
    const upload = page.getByRole('form', { name: 'Upload evidence', exact: true });
    await upload.getByLabel('Evidence file (maximum 8 MiB)', { exact: true }).setInputFiles(file);
    await upload.getByLabel('Evidence type', { exact: true }).selectOption('document');
    await upload.getByLabel('Description', { exact: true }).fill(description);
    await expect(
      upload.getByRole('button', { name: 'Upload evidence', exact: true }),
    ).toBeDisabled();
    await upload
      .getByRole('checkbox', {
        name: 'I reviewed this file and authorize its seven-year retention.',
        exact: true,
      })
      .check();
    const responsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/bff/v1/evidence/ingestions' &&
        response.request().method() === 'POST',
    );
    await upload.getByRole('button', { name: 'Upload evidence', exact: true }).click();
    const uploaded = await responsePromise;
    expect(uploaded.status()).toBe(201);
    const submitted = uploaded.request().postDataJSON() as {
      operationKey: string;
      filename: string;
      contentBase64: string;
    };
    const { data: operation } = (await uploaded.json()) as {
      data: { operationId: string; operationKey: string; status: string; evidenceId: string };
    };
    expect(operation).toMatchObject({ status: 'settled', operationKey: submitted.operationKey });
    expect(operation.evidenceId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(
      page.getByText('Evidence stored; its exact-version receipt is recorded.', { exact: true }),
    ).toBeVisible();

    const headers = { 'x-tenant-id': state.tenantA.id };
    const detailUrl = `/api/bff/v1/evidence/${operation.evidenceId}`;
    const detail = await page.request.get(detailUrl, { headers });
    expect(detail.status()).toBe(200);
    const { data: record } = (await detail.json()) as {
      data: {
        id: string;
        content_hash: string;
        byte_size: number;
        assurance: string;
        object_version: { id: string; version_id: string; lock_mode: string; retain_until: string };
      };
    };
    expect(record).toMatchObject({
      id: operation.evidenceId,
      content_hash: digest,
      byte_size: bytes.length,
      assurance: 'verified_at_ingest',
      object_version: { lock_mode: 'COMPLIANCE' },
    });
    expect(record.object_version.version_id).not.toBe('null');
    expect(record.object_version.version_id.length).toBeGreaterThan(0);
    expect(Date.parse(record.object_version.retain_until)).toBeGreaterThan(
      Date.now() + 6 * 365 * 24 * 60 * 60 * 1000,
    );

    // A new HTTP idempotency key reaches the durable operation replay path.
    // Receipt equality proves stable settlement; provider version enumeration
    // is a separate fixture assertion, not inferred from the application row.
    const replay = await page.request.post('/api/bff/v1/evidence/ingestions', {
      headers: { ...headers, 'idempotency-key': crypto.randomUUID() },
      data: submitted,
    });
    expect(replay.status()).toBe(201);
    expect((await replay.json()).data).toMatchObject(operation);
    const replayDetail = await page.request.get(detailUrl, { headers });
    expect(replayDetail.status()).toBe(200);
    expect((await replayDetail.json()).data.object_version).toEqual(record.object_version);

    const filters = page.getByRole('form', { name: 'Evidence filters', exact: true });
    await filters.getByLabel('Search description', { exact: true }).fill(description);
    await filters.getByLabel('Source', { exact: true }).fill('human');
    await filters.getByRole('button', { name: 'Apply filters', exact: true }).click();
    const records = page.getByRole('region', { name: 'Evidence records', exact: true });
    await expect(records.getByText('1 matching records', { exact: true })).toBeVisible();
    await records.getByRole('button').filter({ hasText: filename }).click();
    const inspector = page.getByRole('region', { name: 'Evidence inspector', exact: true });
    await expect(inspector.getByText(description, { exact: true })).toBeVisible();
    await expect(
      inspector.getByText(`Exact version: ${record.object_version.version_id}`),
    ).toBeVisible();
    await inspector.getByRole('button', { name: 'Verify provider receipt', exact: true }).click();
    await expect(
      inspector.getByText(/Stored-byte integrity and provider retention verified at/),
    ).toContainText(record.object_version.version_id);

    const downloadPromise = page.waitForEvent('download');
    await inspector.getByRole('button', { name: 'Download exact version', exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(filename);
    expect(await download.failure()).toBeNull();
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    const downloaded = await readFile(downloadPath!);
    expect(downloaded.equals(bytes)).toBe(true);
    expect(createHash('sha256').update(downloaded).digest('hex')).toBe(digest);
    await inspector.getByLabel('Local file to verify', { exact: true }).setInputFiles(file);
    await expect(
      inspector.getByText('Hash matches the recorded digest.', { exact: true }),
    ).toBeVisible();
    await expect(inspector.getByText(`SHA-256: ${digest}`, { exact: true })).toBeVisible();
    await expect(inspector.getByText(/bytes · Size matches/)).toBeVisible();

    // Owner has no tenant B membership; explicit foreign selection is refused.
    const foreign = await page.request.get(detailUrl, {
      headers: { 'x-tenant-id': state.tenantB.id },
    });
    expect(foreign.status()).toBe(403);
    const foreignUpload = await page.request.post('/api/bff/v1/evidence/ingestions', {
      headers: { 'x-tenant-id': state.tenantB.id, 'idempotency-key': crypto.randomUUID() },
      data: { ...submitted, operationKey: crypto.randomUUID() },
    });
    expect(foreignUpload.status()).toBe(403);

    const viewerContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
    try {
      const viewer = await viewerContext.newPage();
      await signIn(viewer, 'viewer');
      await selectTenant(viewer, 'a');
      await viewer.goto('/evidence');
      await expect(
        viewer.getByRole('heading', { name: 'Evidence vault', exact: true }),
      ).toBeVisible();
      await expect(viewer.getByRole('form', { name: 'Upload evidence', exact: true })).toHaveCount(
        0,
      );
      expect((await viewer.request.get(detailUrl, { headers })).status()).toBe(200);
      expect((await viewer.request.get(`${detailUrl}/content`, { headers })).status()).toBe(403);
      const viewerUpload = await viewer.request.post('/api/bff/v1/evidence/ingestions', {
        headers: { ...headers, 'idempotency-key': crypto.randomUUID() },
        data: { ...submitted, operationKey: crypto.randomUUID() },
      });
      expect(viewerUpload.status()).toBe(403);
      const viewerReconcile = await viewer.request.post(
        `/api/bff/v1/evidence/ingestions/${operation.operationKey}/reconcile`,
        { headers: { ...headers, 'idempotency-key': crypto.randomUUID() }, data: {} },
      );
      expect(viewerReconcile.status()).toBe(403);
    } finally {
      await viewerContext.close();
    }
  });
});
