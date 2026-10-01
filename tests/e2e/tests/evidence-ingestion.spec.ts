import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { test, expect } from '@playwright/test';
import { selectTenant, signIn, state } from '../fixtures';
import { acceptanceTarget, repoRoot } from '../target';
import { localRoleBearer } from '../local-writer';
import { EvidenceVault } from '../../../packages/evidence/src/index';

const execFileAsync = promisify(execFile);
async function providerAction(action: '--pause-provider' | '--resume-provider') {
  const directory = process.env.AXIOM_EVIDENCE_FIXTURE_DIRECTORY;
  if (!directory || acceptanceTarget) throw new Error('Owned local evidence fixture required');
  await execFileAsync(
    'python3',
    [`${repoRoot}/scripts/test-evidence-storage.py`, '--directory', directory, action],
    { cwd: repoRoot, timeout: 100_000 },
  );
}

/** Simulate real crash boundaries after begin or Put/readback, before settlement.
 * The fixture invokes the sanctioned manager-authorized begin RPC and real
 * vault seal; no table writes, fabricated receipt, provider mock or settlement.
 */
async function pendingEvidence(sealObject: boolean) {
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
    throw new Error('Synthetic local storage and Auth fixture required');
  const operationKey = crypto.randomUUID();
  const description = `Pending provider acceptance ${operationKey}`;
  const filename = `pending-${operationKey}.bin`;
  const bytes = Buffer.from(`Synthetic post-upload crash boundary ${operationKey}\n`);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const key = `tenants/${state.tenantA.id}/evidence-ingestions/${operationKey}/${hash}`;
  const response = await fetch(`${state.supabaseUrl}/rest/v1/rpc/begin_evidence_ingest`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      apikey: state.publishableKey,
      authorization: `Bearer ${localRoleBearer('evidence_ingestion_writer', state)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      p_tenant_id: state.tenantA.id,
      p_actor_id: state.accounts.owner.id,
      p_operation_key: operationKey,
      p_correlation_id: crypto.randomUUID(),
      p_request: {
        content_hash: hash,
        byte_size: bytes.length,
        mime_type: 'application/octet-stream',
        filename,
        evidence_type: 'document',
        description,
        control_ids: [],
        engagement_id: null,
        collected_by_agent: 'human',
        provider: 's3-compatible',
        bucket,
        object_key: key,
        retention_policy: 'seven_years',
        legal_hold: false,
      },
    }),
  });
  if (!response.ok) throw new Error('Synthetic pending ingestion begin refused');
  const operation = (await response.json()) as {
    operation_id?: string;
    status?: string;
    retain_until?: string;
    replayed?: boolean;
  };
  if (
    !operation.operation_id ||
    operation.status !== 'pending' ||
    !operation.retain_until ||
    operation.replayed !== false
  )
    throw new Error('Synthetic pending ingestion was not created');
  if (!sealObject) return { operationKey, filename, description, bytes, hash, versionId: null };
  const vault = new EvidenceVault('ap-south-1', endpoint, { accessKeyId, secretAccessKey });
  try {
    const sealed = await vault.seal({
      bucket,
      key,
      body: bytes,
      contentType: 'application/octet-stream',
      retentionDays: 2555,
      retainUntil: operation.retain_until,
      tenantId: state.tenantA.id,
      collectedByAgent: 'human',
      operationId: operation.operation_id,
    });
    return { operationKey, filename, description, bytes, hash, versionId: sealed.versionId };
  } finally {
    vault.close();
  }
}

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
    test.setTimeout(240_000);
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
    const review = upload.getByRole('checkbox', {
      name: 'I reviewed this file and authorize its seven-year retention.',
      exact: true,
    });
    const submit = upload.getByRole('button', { name: 'Upload evidence', exact: true });
    await review.check();
    await upload.getByLabel('Evidence file (maximum 8 MiB)', { exact: true }).setInputFiles({
      ...file,
      name: `replacement-${filename}`,
      buffer: Buffer.from('Synthetic replacement requiring another review'),
    });
    await expect(review).not.toBeChecked();
    await expect(submit).toBeDisabled();
    await upload.getByLabel('Evidence file (maximum 8 MiB)', { exact: true }).setInputFiles(file);
    await review.check();
    await upload.getByLabel('Evidence type', { exact: true }).selectOption('config');
    await expect(review).not.toBeChecked();
    await expect(submit).toBeDisabled();
    await upload.getByLabel('Evidence type', { exact: true }).selectOption('document');
    for (const [label, changed, restored] of [
      ['Description', `${description} revised`, description],
      ['Control IDs (comma separated)', 'synthetic-review-change', ''],
      ['Engagement ID (optional)', state.engagementA, ''],
    ]) {
      await review.check();
      await upload.getByLabel(label!, { exact: true }).fill(changed!);
      await expect(review).not.toBeChecked();
      await expect(submit).toBeDisabled();
      await upload.getByLabel(label!, { exact: true }).fill(restored!);
    }
    await review.check();
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
    await filters
      .getByLabel('Search description or evidence ID', { exact: true })
      .fill(description);
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

    // A real provider outage must replace the previous successful check with
    // an honest refusal. Pause preserves the exact endpoint and stored data.
    try {
      await providerAction('--pause-provider');
      await inspector.getByRole('button', { name: 'Verify provider receipt', exact: true }).click();
      await expect(
        inspector.getByText(/Stored-byte integrity and provider retention verified at/),
      ).toHaveCount(0);
      await expect(
        page.getByRole('alert').filter({ hasText: 'provider_verification_failed' }),
      ).toBeVisible({ timeout: 45_000 });
      await expect(
        inspector.getByText(/Stored-byte integrity and provider retention verified at/),
      ).toHaveCount(0);
    } finally {
      await providerAction('--resume-provider');
    }
    await inspector.getByRole('button', { name: 'Verify provider receipt', exact: true }).click();
    await expect(
      inspector.getByText(/Stored-byte integrity and provider retention verified at/),
    ).toContainText(record.object_version.version_id);

    const pending = await pendingEvidence(true);
    await page.reload();
    const operationRow = page
      .getByRole('region', { name: 'Upload operations', exact: true })
      .locator('div.rounded')
      .filter({ hasText: pending.operationKey });
    await expect(operationRow).toContainText('pending');
    await expect(operationRow).not.toContainText('Evidence:');
    const reconciledResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/bff/v1/evidence/ingestions/${pending.operationKey}/reconcile` &&
        response.request().method() === 'POST',
    );
    await operationRow.getByRole('button', { name: 'Reconcile upload', exact: true }).click();
    const reconciled = await reconciledResponse;
    expect(reconciled.status()).toBe(200);
    const settled = (await reconciled.json()).data as { status: string; evidenceId: string };
    expect(settled.status).toBe('settled');
    await expect(
      page.getByText('Upload reconciled; receipt recorded.', { exact: true }),
    ).toBeVisible();
    const recoveredDetail = await page.request.get(`/api/bff/v1/evidence/${settled.evidenceId}`, {
      headers,
    });
    expect(recoveredDetail.status()).toBe(200);
    expect((await recoveredDetail.json()).data).toMatchObject({
      content_hash: pending.hash,
      byte_size: pending.bytes.length,
      assurance: 'verified_at_ingest',
      object_version: { version_id: pending.versionId },
    });
    await filters
      .getByLabel('Search description or evidence ID', { exact: true })
      .fill(pending.description);
    await filters.getByRole('button', { name: 'Apply filters', exact: true }).click();
    await records.getByRole('button').filter({ hasText: pending.filename }).click();
    await expect(inspector.getByText(`Exact version: ${pending.versionId}`)).toBeVisible();
    const recoveredDownloadPromise = page.waitForEvent('download');
    await inspector.getByRole('button', { name: 'Download exact version', exact: true }).click();
    const recoveredDownload = await recoveredDownloadPromise;
    expect(await recoveredDownload.failure()).toBeNull();
    const recoveredPath = await recoveredDownload.path();
    expect(recoveredPath).not.toBeNull();
    expect((await readFile(recoveredPath!)).equals(pending.bytes)).toBe(true);

    // Begin committed, but no storage write ever happened. Reconciliation
    // must not fabricate a version or evidence row, and the UI explains why.
    const missing = await pendingEvidence(false);
    await page.reload();
    const missingRow = page
      .getByRole('region', { name: 'Upload operations', exact: true })
      .locator('div.rounded')
      .filter({ hasText: missing.operationKey });
    await expect(missingRow).toContainText('pending');
    const missingResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/bff/v1/evidence/ingestions/${missing.operationKey}/reconcile` &&
        response.request().method() === 'POST',
    );
    await missingRow.getByRole('button', { name: 'Reconcile upload', exact: true }).click();
    const unresolved = await missingResponse;
    expect(unresolved.status()).toBe(202);
    expect((await unresolved.json()).data).toMatchObject({
      status: 'pending',
      evidenceId: null,
      errorCode: 'object_version_not_found',
    });
    await expect(missingRow).toContainText('Reconciliation cannot create a missing object.');
    await expect(missingRow).toContainText(
      'operation remains pending and is not verified evidence.',
    );
    await expect(missingRow).not.toContainText('Evidence:');
    const missingOperation = await page.request.get(
      `/api/bff/v1/evidence/ingestions/${missing.operationKey}`,
      { headers },
    );
    expect(missingOperation.status()).toBe(200);
    expect((await missingOperation.json()).data).toMatchObject({
      status: 'pending',
      evidenceId: null,
      errorCode: 'object_version_not_found',
    });
    const missingSearch = await page.request.get(
      `/api/bff/v1/evidence?q=${encodeURIComponent(missing.description)}`,
      { headers },
    );
    expect(missingSearch.status()).toBe(200);
    expect((await missingSearch.json()).data).toEqual([]);

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
