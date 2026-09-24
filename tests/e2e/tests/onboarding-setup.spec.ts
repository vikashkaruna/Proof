import { test, expect, type Page } from '@playwright/test';
import { createMfaAccount, selectTenant, signInAs } from '../fixtures';

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
});

test('a viewer sees progress but cannot start or change onboarding', async ({ page }) => {
  const viewer = await createMfaAccount('setup-viewer', { role: 'viewer' });
  await signInAs(page, viewer.email, viewer.password);
  await selectTenant(page, 'a');
  await page.goto('/estate/setup');
  await expect(page.getByTestId('setup-wizard')).toBeVisible();
  await expect(page.getByRole('button', { name: /Start (re-)?onboarding/ })).toHaveCount(0);
  const refused = await page.request.post('/api/bff/v1/onboarding/wizard', { data: {} });
  expect(refused.status()).toBe(403);
});
