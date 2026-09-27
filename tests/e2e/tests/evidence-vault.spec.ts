import { createHash } from 'node:crypto';
import { test, expect, type Page, type Request } from '@playwright/test';
import { selectTenant, signIn, state } from '../fixtures';

// Real GoTrue -> browser bridge -> BFF reads. These fixtures are explicitly
// legacy records: their hashes are real, but no object is uploaded and no
// provider version/retention receipt is fabricated.
async function legacyEvidence(options: {
  tenantId?: string;
  description: string;
  source?: string;
  controlIds?: string[];
}) {
  const id = crypto.randomUUID();
  const filename = `legacy-${id}.txt`;
  const bytes = Buffer.from(`Synthetic evidence fixture ${id}\n`, 'utf8');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const response = await fetch(`${state.supabaseUrl}/rest/v1/evidence`, {
    method: 'POST',
    headers: {
      apikey: state.publishableKey,
      Authorization: `Bearer ${state.serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id,
      tenant_id: options.tenantId ?? state.tenantA.id,
      content_hash: hash,
      storage_uri: `fixture://unverified-evidence/${id}`,
      filename,
      mime_type: 'text/plain',
      byte_size: bytes.length,
      evidence_type: 'document',
      description: options.description,
      collected_by_agent: options.source ?? 'controlled-browser-fixture',
      demonstrates_control_ids: options.controlIds ?? [],
      collected_at: '2026-09-22T12:00:00.000Z',
      // A claimed legacy date must never turn into verified provider assurance.
      worm_lock_until: '2033-09-22T12:00:00.000Z',
    }),
  });
  expect(response.status).toBe(201);
  return { id, filename, bytes, hash };
}

async function openVault(page: Page, role: 'owner' | 'viewer', evidenceId?: string) {
  await signIn(page, role);
  await selectTenant(page, 'a');
  const loaded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/bff/v1/evidence' &&
      response.request().method() === 'GET',
  );
  await page.goto(evidenceId ? `/evidence?q=${encodeURIComponent(evidenceId)}` : '/evidence');
  expect((await loaded).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Evidence vault', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Evidence records' })).not.toContainText(
    'Loading evidence',
  );
}

async function applyFilters(page: Page) {
  const filtered = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/bff/v1/evidence' &&
      response.request().method() === 'GET',
  );
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  expect((await filtered).status()).toBe(200);
  await expect(page.getByRole('region', { name: 'Evidence records' })).not.toContainText(
    'Loading evidence',
  );
}

function apiHeaders() {
  return { 'x-tenant-id': state.tenantA.id, 'idempotency-key': crypto.randomUUID() };
}

test('legacy evidence stays unverified and local hash comparison never uploads the file', async ({
  page,
}) => {
  const marker = `legacy-compare-${crypto.randomUUID()}`;
  const fixture = await legacyEvidence({ description: marker });
  await openVault(page, 'owner', fixture.id);
  await expect(page.getByLabel('Search description or evidence ID', { exact: true })).toHaveValue(
    fixture.id,
  );
  await expect(page.getByRole('region', { name: 'Evidence records' })).toContainText(
    '1 matching records',
  );
  await expect(page.getByRole('region', { name: 'Evidence records' })).toContainText(fixture.id);
  await page.getByLabel('Search description or evidence ID', { exact: true }).fill(marker);
  await applyFilters(page);
  const records = page.getByRole('region', { name: 'Evidence records' });
  await expect(records).toContainText('1 matching records');
  await expect(records).toContainText('Legacy record — storage unverified');
  await records.getByRole('button', { name: new RegExp(fixture.filename) }).click();
  const inspector = page.getByRole('region', { name: 'Evidence inspector' });
  await expect(inspector.getByText(fixture.id, { exact: true })).toBeVisible();
  await expect(inspector.getByText(fixture.hash, { exact: true })).toBeVisible();
  await expect(inspector).toContainText('no immutable object-version receipt');
  await expect(inspector).toContainText('Retention and stored-byte integrity are unverified.');
  await expect(inspector).toContainText('None recorded');
  await expect(inspector.getByRole('link')).toHaveCount(0);
  await expect(inspector.getByRole('button', { name: 'Verify provider receipt' })).toBeDisabled();
  await expect(inspector.getByRole('button', { name: 'Download exact version' })).toBeDisabled();
  await expect(page.getByRole('form', { name: 'Upload evidence' })).toBeVisible();

  const mutations: string[] = [];
  const recordMutation = (request: Request) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()))
      mutations.push(`${request.method()} ${new URL(request.url()).pathname}`);
  };
  page.on('request', recordMutation);
  try {
    await inspector.getByLabel('Local file to verify').setInputFiles({
      name: fixture.filename,
      mimeType: 'text/plain',
      buffer: fixture.bytes,
    });
    await expect(inspector.getByRole('status')).toContainText('Hash matches the recorded digest.');
    await expect(inspector.getByRole('status')).toContainText(fixture.hash);
    await expect(inspector.getByRole('status')).toContainText('Size matches');
    const altered = Buffer.from(fixture.bytes);
    altered[0] = altered[0]! ^ 1;
    await inspector.getByLabel('Local file to verify').setInputFiles({
      name: fixture.filename,
      mimeType: 'text/plain',
      buffer: altered,
    });
    await expect(inspector.getByRole('status')).toContainText(
      'Hash mismatch: this file differs from the recorded digest.',
    );
    await expect(inspector.getByRole('status')).toContainText('Size matches');
    expect(mutations).toEqual([]);
  } finally {
    page.off('request', recordMutation);
  }
  // Even after a local match the legacy provider operations remain unavailable.
  await expect(inspector.getByRole('button', { name: 'Verify provider receipt' })).toBeDisabled();
  for (const endpoint of ['content', 'verify']) {
    const response =
      endpoint === 'content'
        ? await page.request.get(`/api/bff/v1/evidence/${fixture.id}/content`, {
            headers: apiHeaders(),
          })
        : await page.request.post(`/api/bff/v1/evidence/${fixture.id}/verify`, {
            headers: apiHeaders(),
            data: {},
          });
    expect(response.status()).toBe(409);
    expect((await response.json()).error.code).toBe('evidence_version_unavailable');
  }
});

test('real evidence search and combined filters show honest empty results', async ({ page }) => {
  const marker = `filter-evidence-${crypto.randomUUID()}`;
  const fixture = await legacyEvidence({
    description: `${marker} first`,
    source: 'evidence-filter-fixture',
    controlIds: ['DPDPA-CNS-001'],
  });
  await legacyEvidence({
    description: `${marker} second`,
    source: 'other-filter-fixture',
    controlIds: ['DPDPA-SEC-001'],
  });
  await openVault(page, 'owner');
  const records = page.getByRole('region', { name: 'Evidence records' });
  await page.getByLabel('Search description or evidence ID', { exact: true }).fill(marker);
  await applyFilters(page);
  await expect(records).toContainText('2 matching records');
  await page.getByLabel('Control ID', { exact: true }).fill('DPDPA-CNS-001');
  await page.getByLabel('Source', { exact: true }).fill('evidence-filter-fixture');
  await page.getByLabel('Collected from (UTC)', { exact: true }).fill('2026-09-01');
  await page.getByLabel('Collected to (UTC)', { exact: true }).fill('2026-09-30');
  await applyFilters(page);
  await expect(records).toContainText('1 matching records');
  await records.getByRole('button', { name: new RegExp(fixture.filename) }).click();
  await expect(
    page.getByRole('region', { name: 'Evidence inspector' }).getByRole('link', {
      name: 'DPDPA-CNS-001',
      exact: true,
    }),
  ).toHaveAttribute('href', '/controls?q=DPDPA-CNS-001');
  // A real no-match response must clear the old selection and show no demo rows.
  await page.getByLabel('Source', { exact: true }).fill(`absent-${crypto.randomUUID()}`);
  await applyFilters(page);
  await expect(records).toContainText('0 matching records');
  await expect(records).toContainText('No evidence matches these filters.');
  await expect(records.locator('button[aria-pressed]')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Evidence inspector' })).toHaveCount(0);
  await expect(records.getByRole('button', { name: 'Previous records' })).toBeDisabled();
  await expect(records.getByRole('button', { name: 'Next records' })).toBeDisabled();
  await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toHaveCount(0);
});

test('viewer reads tenant evidence without upload affordances or foreign tenant access', async ({
  page,
}) => {
  const marker = `viewer-evidence-${crypto.randomUUID()}`;
  const own = await legacyEvidence({ description: marker });
  const foreign = await legacyEvidence({ tenantId: state.tenantB.id, description: marker });
  await openVault(page, 'viewer');
  await page.getByLabel('Search description or evidence ID', { exact: true }).fill(marker);
  await applyFilters(page);
  const records = page.getByRole('region', { name: 'Evidence records' });
  await expect(records).toContainText('1 matching records');
  await expect(records).not.toContainText(foreign.id);
  await records.getByRole('button', { name: new RegExp(own.filename) }).click();
  await expect(page.getByRole('form', { name: 'Upload evidence' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Upload operations' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download exact version' })).toHaveCount(0);
  await expect(page.getByLabel('Local file to verify')).toBeEnabled();
  for (const path of ['/ingestions', `/ingestions/${crypto.randomUUID()}/reconcile`]) {
    const refused = await page.request.post(`/api/bff/v1/evidence${path}`, {
      headers: apiHeaders(),
      data: {},
    });
    expect(refused.status()).toBe(403);
  }
  const exportRefused = await page.request.get(`/api/bff/v1/evidence/${own.id}/content`, {
    headers: apiHeaders(),
  });
  expect(exportRefused.status()).toBe(403);
  const foreignId = await page.request.get(`/api/bff/v1/evidence/${foreign.id}`, {
    headers: apiHeaders(),
  });
  expect(foreignId.status()).toBe(404);
  expect((await foreignId.json()).error.code).toBe('evidence_not_found');
  const foreignTenant = await page.request.get('/api/bff/v1/evidence', {
    headers: { 'x-tenant-id': state.tenantB.id },
  });
  expect(foreignTenant.status()).toBe(403);
});
