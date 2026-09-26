import { test, expect } from '@playwright/test';
import { selectTenant, signIn, state } from '../fixtures';

// These journeys use real auth, BFF routes and database writes. Synthetic
// evidence below proves linkage only, not delivery or locked object storage.
test('DSAR intake, identity verification, refusal and evidence-bound completion', async ({
  page,
}) => {
  const suffix = crypto.randomUUID();
  const name = `Rights journey ${suffix}`;
  await signIn(page, 'owner');
  await selectTenant(page, 'a');
  await page.goto('/dsars');
  await page.getByRole('button', { name: 'Record request', exact: true }).click();
  await page.getByLabel('Principal name (optional)').fill(name);
  await page.getByLabel('Principal email', { exact: true }).fill(`dsar-${suffix}@example.test`);
  const intakeResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/bff/v1/dsars') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Record and start deadline' }).click();
  const intake = await intakeResponse;
  expect(intake.status()).toBe(201);
  const { data } = await intake.json();
  const card = page.locator('section').filter({ hasText: data.dsarId });
  await expect(card).toContainText(name);
  await expect(card).toContainText('Not verified');
  await expect(card.getByRole('button', { name: 'Start fulfilment', exact: true })).toHaveCount(0);
  await card.getByRole('button', { name: 'Record identity verification', exact: true }).click();
  await card
    .getByLabel('Verification method', { exact: true })
    .fill('Controlled fixture identity check');
  await card
    .getByRole('button', { name: 'Confirm record identity verification', exact: true })
    .click();
  await expect(card).toContainText('Verified: Controlled fixture identity check');
  await card.getByRole('button', { name: 'Start fulfilment', exact: true }).click();
  await card.getByRole('button', { name: 'Confirm start fulfilment', exact: true }).click();
  await expect(card).toContainText('in fulfilment');
  await card.getByRole('button', { name: 'Complete with evidence', exact: true }).click();
  await card.getByLabel('Fulfilment evidence UUID').fill(crypto.randomUUID());
  await card.getByRole('button', { name: 'Confirm complete with evidence', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'fulfilment_evidence_not_found' }),
  ).toHaveText('fulfilment_evidence_not_found');
  // A refused request leaves the editor and entered note intact.
  await expect(card.getByLabel('Fulfilment evidence UUID')).toBeVisible();
  const evidenceId = crypto.randomUUID();
  const response = await fetch(`${state.supabaseUrl}/rest/v1/evidence`, {
    method: 'POST',
    headers: {
      apikey: state.publishableKey,
      Authorization: `Bearer ${state.serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id: evidenceId,
      tenant_id: state.tenantA.id,
      content_hash: evidenceId.replaceAll('-', '').repeat(2),
      storage_uri: `fixture://dsar/${evidenceId}`,
      evidence_type: 'log',
      collected_by_agent: 'controlled-browser-fixture',
      description: 'Synthetic linkage fixture; no delivery or WORM assertion',
    }),
  });
  expect(response.status).toBe(201);
  await card.getByLabel('Fulfilment evidence UUID').fill(evidenceId);
  await card.getByRole('button', { name: 'Confirm complete with evidence', exact: true }).click();
  await expect(card).toContainText('completed');
  await expect(
    card.getByRole('button', { name: 'Complete with evidence', exact: true }),
  ).toHaveCount(0);
  const saved = await page.request.get('/api/bff/v1/dsars', {
    headers: { 'x-tenant-id': state.tenantA.id },
  });
  expect(saved.status()).toBe(200);
  const persisted = (await saved.json()).data.find(
    (record: { id: string }) => record.id === data.dsarId,
  );
  expect(persisted.status).toBe('completed');
  expect(persisted.identity_verified).toBe(true);
  expect(
    Math.abs(Date.parse(persisted.due_by) - Date.parse(persisted.received_at) - 30 * 86400000),
  ).toBeLessThan(5000);
});

test('viewer sees recorded rights requests but cannot mutate them', async ({ page }) => {
  await signIn(page, 'viewer');
  await selectTenant(page, 'a');
  await page.goto('/dsars');
  await expect(page.getByRole('heading', { name: 'Data subject requests' })).toBeVisible();
  await expect(page.getByText('Read-only access.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record request', exact: true })).toHaveCount(0);
  const refused = await page.request.post('/api/bff/v1/dsars', {
    headers: { 'x-tenant-id': state.tenantA.id, 'Idempotency-Key': crypto.randomUUID() },
    data: { kind: 'access', principalEmail: 'forbidden@example.test', dueDays: 30 },
  });
  expect(refused.status()).toBe(403);
});

test('uncertain DSAR intake retains its request key and form for a safe retry', async ({
  page,
}) => {
  const suffix = crypto.randomUUID();
  await signIn(page, 'owner');
  await selectTenant(page, 'a');
  await page.goto('/dsars');
  await page.getByRole('button', { name: 'Record request', exact: true }).click();
  await page.getByLabel('Principal email', { exact: true }).fill(`lost-${suffix}@example.test`);
  let recordedId: string | undefined;
  let firstKey: string | undefined;
  await page.route(
    '**/api/bff/v1/dsars',
    async (route) => {
      firstKey = route.request().headers()['idempotency-key'];
      const committed = await route.fetch();
      expect(committed.status()).toBe(201);
      recordedId = (await committed.json()).data.dsarId;
      await route.abort('connectionfailed');
    },
    { times: 1 },
  );
  await page.getByRole('button', { name: 'Record and start deadline' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Connection lost' })).toContainText(
    'Connection lost',
  );
  await expect(page.getByLabel('Principal email', { exact: true })).toHaveValue(
    `lost-${suffix}@example.test`,
  );
  const replayResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/bff/v1/dsars') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Record and start deadline' }).click();
  const replay = await replayResponse;
  expect(replay.request().headers()['idempotency-key']).toBe(firstKey);
  expect(replay.headers()['idempotency-replayed']).toBe('true');
  expect((await replay.json()).data.dsarId).toBe(recordedId);
  await expect(page.locator('section').filter({ hasText: recordedId })).toHaveCount(1);
});
