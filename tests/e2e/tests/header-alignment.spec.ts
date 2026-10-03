import { expect, test } from '@playwright/test';
import { createMfaAccount, selectTenant, signInAs } from '../fixtures';

const routes = [
  '/estate',
  '/plans',
  '/approval',
  '/execution',
  '/evidence',
  '/dsars',
  '/consent',
  '/breaches',
  '/monitoring',
  '/regwatch',
  '/reports',
  '/reports?tab=pramaan',
  '/connectors',
  '/policies',
] as const;

test('module pages and report views use the branded header with one accessible page title', async ({
  page,
}) => {
  test.setTimeout(5 * 60_000);
  const account = await createMfaAccount('header-review', { role: 'admin' });
  await signInAs(page, account.email, account.password);
  await selectTenant(page, 'a');

  await page.goto('/controls');
  const reference = page.locator('[class*="bg-gradient-to-br"]').filter({
    has: page.getByRole('heading', { level: 1, name: 'Control Library' }),
  });
  const referenceGradient = await reference.evaluate(
    (element) => getComputedStyle(element).backgroundImage,
  );
  expect(referenceGradient).toContain('gradient');

  for (const route of routes) {
    await page.goto(route);
    await expect(page).toHaveURL(new RegExp(route.split('?')[0]!));
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading, route).toHaveCount(1);
    const header = page.locator('header').filter({ has: heading });
    await expect(header, route).toBeVisible();
    await expect
      .poll(async () => header.evaluate((element) => getComputedStyle(element).backgroundImage))
      .toBe(referenceGradient);
    await expect(header.getByTestId('module-bar'), route).toBeVisible();
    await expect(header.locator('[lang="hi"]'), route).toBeVisible();
  }

  await page.goto('/reports?tab=pramaan');
  await expect(page.getByTestId('related-agents')).toContainText('pramaan');
  await page.getByRole('button', { name: 'Working reports and registers' }).click();
  await expect(page).toHaveURL(/\/reports(?:$|\?)/);
  await expect(page.getByRole('heading', { level: 1, name: 'Reports and evidence' })).toBeVisible();
  await expect(page.getByTestId('related-agents')).toContainText('prativedan');
  await page.getByRole('button', { name: 'Closure dossiers' }).click();
  await expect(page).toHaveURL(/\/reports\?tab=pramaan/);
  await expect(page.getByRole('heading', { level: 1, name: 'Reports and evidence' })).toBeVisible();
  await expect(page.getByTestId('related-agents')).toContainText('pramaan');

  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of ['/estate', '/breaches', '/consent', '/reports?tab=pramaan']) {
    await page.goto(route);
    const header = page.locator('header').filter({ has: page.getByRole('heading', { level: 1 }) });
    await expect(header, `${route} at mobile width`).toBeVisible();
    expect(
      await header.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      `${route} header content fits mobile width`,
    ).toBe(true);
  }
});
