import { test, expect } from '@playwright/test';
import { signIn, selectTenant, signInFreshAnalyst, state } from '../fixtures';

test('owner declares, edits and archives an estate and system', async ({ page }) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const name = `India estate ${suffix}`;
  await signIn(page, 'owner');
  await selectTenant(page, 'a');
  await page.goto('/estate');
  const create = page.locator('form').filter({ has: page.locator('input[name=slug]') });
  await create.getByLabel('Estate name', { exact: true }).fill(name);
  await create.getByLabel('Estate slug').fill(`india-${suffix}`);
  let lostKey: string | undefined;
  await page.route(
    '**/api/bff/v1/estates',
    async (route) => {
      lostKey = route.request().headers()['idempotency-key'];
      await route.fetch(); // Commit succeeded, but its response never reaches the browser.
      await route.abort('connectionfailed');
    },
    { times: 1 },
  );
  await create.getByRole('button', { name: 'Create estate', exact: true }).click();
  await expect(create.getByRole('button', { name: 'Retry same request' })).toBeVisible();
  const retry = page.waitForRequest('**/api/bff/v1/estates');
  await create.getByRole('button', { name: 'Retry same request' }).click();
  expect((await retry).headers()['idempotency-key']).toBe(lostKey);
  const estate = page
    .locator('div.rounded-xl.border')
    .filter({ has: page.getByText(name, { exact: true }) })
    .first();
  await expect(estate).toBeVisible();
  await estate.getByText('Add a system', { exact: true }).click();
  const systemForm = estate
    .locator('form')
    .filter({ has: page.getByRole('button', { name: 'Add system', exact: true }) });
  await systemForm.getByLabel('System name').fill(`CRM ${suffix}`);
  await systemForm.getByLabel('Declared categories').fill('contact, identity');
  await systemForm.getByRole('button', { name: 'Add system', exact: true }).click();
  await expect(estate.getByText(`CRM ${suffix}`, { exact: true })).toBeVisible();
  await expect(estate.getByText('Declared: contact, identity')).toBeVisible();
  await estate.getByText('Edit system', { exact: true }).click();
  const edit = estate
    .locator('form')
    .filter({ has: page.getByRole('button', { name: 'Save system', exact: true }) });
  await edit.getByLabel('Status', { exact: true }).selectOption('archived');
  await edit.getByRole('button', { name: 'Save system', exact: true }).click();
  await expect(estate.getByText('database · archived')).toBeVisible();
  const intakeTitle = `Scope confirmation ${suffix}`;
  const created = await page.evaluate(
    async ({ tenantId, libraryVersion, title }) => {
      const res = await fetch('/api/bff/v1/engagements', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': tenantId,
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ libraryVersion, title }),
      });
      return { status: res.status, id: (await res.json()).id };
    },
    { tenantId: state.tenantA.id, libraryVersion: state.libraryVersion, title: intakeTitle },
  );
  expect(created.status).toBe(201);
  await page.reload();
  await estate.getByText('Assign an unassigned assessment', { exact: true }).click();
  const assign = estate
    .locator('form')
    .filter({ has: page.getByRole('button', { name: 'Assign assessment', exact: true }) });
  await assign.getByLabel('Assessment', { exact: true }).selectOption(created.id);
  await assign.getByRole('checkbox').check();
  await assign.getByRole('button', { name: 'Assign assessment', exact: true }).click();
  await expect(estate.getByRole('option', { name: intakeTitle, exact: true })).toHaveCount(0);
  await estate.getByText('Edit estate', { exact: true }).click();
  const editEstate = estate
    .locator('form')
    .filter({ has: page.getByRole('button', { name: 'Save estate', exact: true }) });
  await editEstate.getByLabel('Status', { exact: true }).selectOption('archived');
  await editEstate.getByRole('button', { name: 'Save estate', exact: true }).click();
  await expect(estate.getByText(`india-${suffix} · archived`)).toBeVisible();
  await expect(estate.getByText('Add a system', { exact: true })).toHaveCount(0);
});

for (const role of ['viewer', 'analyst'] as const) {
  test(`${role} can read estate inventory but cannot edit it`, async ({ page }) => {
    if (role === 'analyst') await signInFreshAnalyst(page, 'estate-reader');
    else await signIn(page, role);
    await selectTenant(page, 'a');
    await page.goto('/estate');
    await expect(page.getByRole('heading', { name: 'Client estate', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create estate', exact: true })).toHaveCount(0);
    await expect(page.getByText('Edit estate', { exact: true })).toHaveCount(0);
    await expect(
      page.getByText('Estate inventory could not be loaded. Refresh to try again.'),
    ).toHaveCount(0);
  });
}
