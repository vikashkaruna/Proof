import { test, expect, type Page } from '@playwright/test';
import {
  createMfaAccount,
  registerWorkload,
  selectTenant,
  signIn,
  signInAs,
  state,
} from '../fixtures';

// C-W3-5: the resumable onboarding checklist. Each step is saved server-side,
// readiness is recomputed from live inventory, and the wizard never issues
// agent grants or claims a registered connector is a live connection.

async function seedEstate(page: Page, suffix: string) {
  const created = await page.request.post('/api/bff/v1/estates', {
    data: { name: `Setup estate ${suffix}`, slug: `setup-${suffix}` },
  });
  expect(created.status()).toBe(201);
  const { data: estate } = (await created.json()) as { data: { id: string } };
  for (const [name, category] of [
    [`Setup CRM ${suffix}`, 'contact'],
    [`Setup HR ${suffix}`, 'employment'],
  ]) {
    const system = await page.request.post(`/api/bff/v1/estates/${estate.id}/systems`, {
      data: { name, systemKind: 'saas', dataCategories: [category] },
    });
    expect(system.status()).toBe(201);
  }
  return `Setup estate ${suffix}`;
}

/** Submit a step, wait for the server to accept it, then for the checklist to show `next`. */
async function advance(page: Page, button: string, next: RegExp) {
  const accepted = page.waitForResponse(
    (r) => /\/onboarding\/wizard\/[^/]+\/steps$/.test(r.url()) && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: button }).click();
  expect((await accepted).status()).toBe(200);
  await page.getByRole('button', { name: next }).click();
  await expect(page.getByRole('button', { name: next })).toHaveAttribute('aria-current', 'step');
}

test('an admin completes onboarding step by step and can resume between steps', async ({
  page,
}) => {
  const admin = await createMfaAccount('setup-admin', { role: 'admin' });
  await signInAs(page, admin.email, admin.password);
  await selectTenant(page, 'a');
  const suffix = crypto.randomUUID().slice(0, 8);
  const estateName = await seedEstate(page, suffix);

  await page.goto('/estate/setup');
  const wizard = page.getByTestId('setup-wizard');
  await expect(wizard).toBeVisible();
  const start = page.getByRole('button', { name: /Start (re-)?onboarding/ });
  const steps = page.getByRole('list', { name: 'Onboarding steps' });
  await expect(steps.or(start)).toBeVisible();
  if (await start.count()) await start.click();
  await expect(steps).toBeVisible();

  // Company profile (always revisitable).
  await page.getByRole('button', { name: /1\. Company profile/ }).click();
  await page.getByLabel('Data Protection Officer name').fill('Asha Rao');
  await page.getByLabel('DPO email').fill('dpo@example.invalid');
  await advance(page, 'Save company profile', /2\. Estate/);

  // Choosing a fresh estate resets any later steps from an earlier attempt.
  await page.getByRole('button', { name: /2\. Estate/ }).click();
  await page.getByLabel('Assessment boundary').selectOption({ label: estateName });
  await advance(page, 'Use this estate', /3\. System inventory/);

  // Resume: a reload lands on the next incomplete step.
  await page.reload();
  await expect(page.getByRole('button', { name: /3\. System inventory/ })).toHaveAttribute(
    'aria-current',
    'step',
  );
  await expect(page.getByTestId('inventory-list')).toContainText(`Setup CRM ${suffix}: contact`);
  await advance(page, 'Confirm inventory', /4\. Connection path/);

  // Neither system has a connector: recording no path is refused.
  await page.getByRole('button', { name: 'Record connection path' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Register a connector for each system' }),
  ).toBeVisible();
  for (const name of [`Setup CRM ${suffix}`, `Setup HR ${suffix}`])
    await page.getByLabel(new RegExp(`${name}: no connector`)).check();
  await advance(page, 'Record connection path', /5\. Access grant review/);

  await expect(page.getByTestId('grant-counts')).toContainText('0 read, 0 write');
  await page.getByLabel('I have reviewed agent access for this estate').check();
  await advance(page, 'Record grant review', /6\. Readiness/);

  const checks = page.getByTestId('readiness-checks');
  await expect(checks.locator('[data-ok="false"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Confirm readiness' }).click();
  await expect(page.getByTestId('setup-complete')).toBeVisible();

  const stored = await page.request.get('/api/bff/v1/onboarding/wizard');
  const body = (await stored.json()) as { data: { status: string }; readiness: { ready: boolean } };
  expect(body.data.status).toBe('completed');
  expect(body.readiness.ready).toBe(true);

  // C-W3-6: a system added after onboarding shows as drift against the baseline.
  await expect(page.getByTestId('drift-status')).toContainText('No changes since');
  const estates = (await (await page.request.get('/api/bff/v1/estates')).json()) as {
    data: { id: string; name: string }[];
  };
  const estateId = estates.data.find((e) => e.name === estateName)!.id;
  const added = await page.request.post(`/api/bff/v1/estates/${estateId}/systems`, {
    data: { name: `Setup Late ${suffix}`, systemKind: 'other', dataCategories: ['contact'] },
  });
  expect(added.status()).toBe(201);
  await page.reload();
  await expect(page.getByTestId('drift-added')).toContainText(`Setup Late ${suffix}`);
});

test('a viewer sees progress but cannot start or change onboarding', async ({ page }) => {
  await signIn(page, 'viewer');
  await selectTenant(page, 'a');
  await page.goto('/estate/setup');
  await expect(page.getByTestId('setup-wizard')).toBeVisible();
  await expect(page.getByRole('button', { name: /Start (re-)?onboarding/ })).toHaveCount(0);
  const refused = await page.request.post('/api/bff/v1/onboarding/wizard', { data: {} });
  expect(refused.status()).toBe(403);
});

async function service(path: string, row: Record<string, unknown>) {
  const res = await fetch(`${state.supabaseUrl}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: state.publishableKey,
      Authorization: `Bearer ${state.serviceKey}`,
      'content-type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }[])[0]!.id;
}

test('an owner re-attests agent access: keep schedules the next review, revoke removes it', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  await signIn(page, 'owner');
  await selectTenant(page, 'a');
  const estate = (await (
    await page.request.post('/api/bff/v1/estates', {
      data: { name: `Access estate ${suffix}`, slug: `access-${suffix}` },
    })
  ).json()) as { data: { id: string } };
  const system = (await (
    await page.request.post(`/api/bff/v1/estates/${estate.data.id}/systems`, {
      data: { name: `Access CRM ${suffix}`, systemKind: 'saas', dataCategories: ['contact'] },
    })
  ).json()) as { data: { id: string } };
  const connector = await page.request.post('/api/bff/v1/connectors', {
    data: {
      systemId: system.data.id,
      descriptorId: '41410000-0000-4000-8000-000000000002',
      name: `Access reader ${suffix}`,
      endpointRef: `access_${suffix}`,
    },
  });
  expect(connector.status()).toBe(201);
  const connectorId = ((await connector.json()) as { data: { id: string } }).data.id;
  const enabled = await page.request.patch(`/api/bff/v1/connectors/${connectorId}`, {
    data: { operation: 'transition', expectedVersion: 1, status: 'active' },
  });
  expect(enabled.status()).toBe(200);
  // Workload registration uses the reviewed W4.3 lifecycle RPC.
  const identity = await registerWorkload('drishti', `access-${suffix}`);

  // W4.4: one grant through the page, one through the API; both are audited issues.
  await page.goto('/estate/setup');
  const issue = page.getByTestId('issue-grant');
  await issue.locator('summary').click();
  await issue.getByLabel('Connector').selectOption({ label: `Access reader ${suffix}` });
  await issue.getByLabel('Agent workload').selectOption(identity);
  await issue.getByLabel('Target scopes (comma separated)').fill('crm.read');
  const issued = page.waitForResponse(
    (r) => r.url().endsWith('/api/bff/v1/connector-grants') && r.request().method() === 'POST',
  );
  await issue.getByRole('button', { name: 'Issue access' }).click();
  const first = (await (await issued).json()) as { data: { id: string } };
  const duplicate = await page.request.post('/api/bff/v1/connector-grants', {
    data: {
      connectorId,
      workloadIdentityId: identity,
      scope: 'connector.read',
      targetScopes: ['crm.read'],
      ttlDays: 30,
    },
  });
  expect(duplicate.status()).toBe(409);
  const writeRefused = await page.request.post('/api/bff/v1/connector-grants', {
    data: {
      connectorId,
      workloadIdentityId: identity,
      scope: 'connector.write',
      targetScopes: ['crm.write'],
      ttlDays: 30,
    },
  });
  expect(writeRefused.status()).toBe(403);
  const second = await service('connector_grants', {
    tenant_id: state.tenantA.id,
    connector_id: connectorId,
    workload_identity_id: identity,
    agent_name: 'drishti',
    internal_scope: 'connector.read',
    target_scopes: ['crm.read'],
    expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });
  const grants = [first.data.id, second];

  await page.goto('/estate/setup');
  const [kept, revoked] = grants.map((id) => page.getByTestId(`grant-${id}`));
  await expect(kept!).toContainText(`drishti · read · Access reader ${suffix}`);
  const keep = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/connector-grants/${grants[0]}/attestations`) &&
      r.request().method() === 'POST',
  );
  await kept!.getByRole('button', { name: 'Keep access' }).click();
  expect((await keep).status()).toBe(201);
  await expect(kept!).toBeVisible();
  await revoked!.getByRole('button', { name: 'Revoke access' }).click();
  await expect(revoked!).toHaveCount(0);
  const queue = (await (await page.request.get('/api/bff/v1/connector-grants/review')).json()) as {
    data: { id: string; lastAttestedAt: string | null }[];
  };
  expect(queue.data.find((g) => g.id === grants[0])?.lastAttestedAt).toBeTruthy();
  expect(queue.data.some((g) => g.id === grants[1])).toBe(false);

  // W4.5: register a read tool version through the page; it is listed with its pin.
  const tools = page.getByTestId('tool-registry');
  await tools.getByLabel('Tool connector').selectOption({ label: `Access reader ${suffix}` });
  await tools.locator('summary').click();
  await tools.getByLabel('Tool name').fill(`crm.lookup_${suffix}`);
  await tools.getByLabel('Version').fill('1.0.0');
  await tools.getByLabel('Description (pinned by hash)').fill('Looks up a contact by id.');
  const registered = page.waitForResponse(
    (r) => r.url().endsWith(`/connectors/${connectorId}/tools`) && r.request().method() === 'POST',
  );
  await tools.getByRole('button', { name: 'Register tool' }).click();
  expect((await registered).status()).toBe(201);
  await expect(tools.getByRole('list', { name: 'Registered tools' })).toContainText(
    `crm.lookup_${suffix}@1.0.0 · read · pinned`,
  );
  // Write tools cannot be registered on a reference binding.
  const writeTool = await page.request.post(`/api/bff/v1/connectors/${connectorId}/tools`, {
    data: {
      toolName: `crm.update_${suffix}`,
      toolVersion: '1.0.0',
      operationClass: 'write',
      description: 'Updates a contact.',
      inputSchema: { type: 'object' },
    },
  });
  expect(writeTool.status()).toBe(409);
});
