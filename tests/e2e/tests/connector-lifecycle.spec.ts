import { test, expect } from '@playwright/test';
import { signIn, selectTenant, state } from '../fixtures';

test('owner registers a connector without claiming connectivity and manages its lifecycle', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  await signIn(page, 'owner');
  await selectTenant(page, 'a');
  await page.goto('/estate');
  const system = await page.evaluate(
    async ({ tenantId, suffix }) => {
      async function post(path: string, body: unknown) {
        const result = await fetch(`/api/bff/v1${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Tenant-Id': tenantId,
            'Idempotency-Key': crypto.randomUUID(),
          },
          body: JSON.stringify(body),
        });
        if (!result.ok) throw new Error(`Setup failed ${result.status}`);
        return (await result.json()).data;
      }
      const estate = await post('/estates', {
        name: `Connector estate ${suffix}`,
        slug: `connector-${suffix}`,
      });
      return post(`/estates/${estate.id}/systems`, {
        name: `Connector CRM ${suffix}`,
        systemKind: 'database',
        dataCategories: ['contact'],
      });
    },
    { tenantId: state.tenantA.id, suffix },
  );
  await page.goto('/connectors');
  await expect(
    page.getByText('Connector execution is not yet available.', { exact: false }),
  ).toBeVisible();
  const create = page.getByRole('region', { name: 'Register connector', exact: true });
  await create.getByRole('combobox', { name: 'System', exact: true }).selectOption(system.id);
  await create
    .getByRole('combobox', { name: 'Descriptor', exact: true })
    .selectOption('41410000-0000-4000-8000-000000000002');
  await create.getByLabel('Registration name').fill(`Reference ${suffix}`);
  await create.getByLabel('Endpoint reference').fill(`crm_${suffix}`);
  let key: string | undefined;
  await page.route(
    '**/api/bff/v1/connectors',
    async (route) => {
      key = route.request().headers()['idempotency-key'];
      await route.fetch();
      await route.abort('connectionfailed');
    },
    { times: 1 },
  );
  await create.getByRole('button', { name: 'Create registration', exact: true }).click();
  await expect(create.getByRole('button', { name: 'Retry same request' })).toBeVisible();
  const retry = page.waitForRequest('**/api/bff/v1/connectors');
  await create.getByRole('button', { name: 'Retry same request' }).click();
  expect((await retry).headers()['idempotency-key']).toBe(key);
  const row = page.getByRole('region', { name: `Reference ${suffix}`, exact: true });
  await expect(row).toHaveCount(1);
  await expect(row.getByText('Health: Not checked', { exact: true })).toBeVisible();
  await expect(row.getByText('reference-mock · Non-production; writes prohibited')).toBeVisible();
  await row.getByRole('button', { name: 'Enable registration', exact: true }).click();
  await expect(row.getByText('Enabled registration', { exact: false })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Save registration' })).toHaveCount(0);
  await row.getByRole('button', { name: 'Disable registration', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Save registration' })).toBeVisible();
  await row.getByRole('button', { name: 'Archive registration', exact: true }).click();
  await expect(row.getByRole('button')).toHaveCount(0);
  await selectTenant(page, 'b');
  await page.goto('/connectors');
  // This owner belongs only to A; a forged B preference must not grant membership.
  await expect(row).toBeVisible();
  const foreign = await page.evaluate(async (tenantId) => {
    const response = await fetch('/api/bff/v1/connectors', {
      headers: { 'X-Tenant-Id': tenantId },
    });
    return response.status;
  }, state.tenantB.id);
  expect(foreign).toBe(403);
});

test('viewer reads real connector inventory without registration controls', async ({ page }) => {
  await signIn(page, 'viewer');
  await selectTenant(page, 'a');
  const catalogue = page.waitForResponse((r) =>
    r.url().endsWith('/api/bff/v1/connector-catalogue'),
  );
  await page.goto('/connectors');
  expect((await catalogue).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Connectors', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create registration' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Enable registration' })).toHaveCount(0);
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
});
