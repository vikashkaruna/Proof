import { expect, test } from '@playwright/test';
import { selectTenant, signIn } from '../fixtures';

test('a viewer can inspect the approval queue without a Pramaan destination', async ({ page }) => {
  await signIn(page, 'viewer');
  await selectTenant(page, 'a');
  await page.goto('/dashboard');
  await expect(page.getByRole('link', { name: /Approval Queue/ }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /Statutory Proof Dossiers/ })).toHaveCount(0);
  await page.getByRole('link', { name: /Awaiting approval/ }).click();
  await expect(page).toHaveURL(/\/approval$/);
  await expect(page.getByRole('main', { name: 'Approval queue' })).toBeVisible();
  await page.goto('/reports?tab=pramaan');
  await expect(page.getByRole('button', { name: 'Closure dossiers' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Working reports and registers' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.locator('header').first().getByText('Working Reports & Registers')).toBeVisible();
});

test('an owner reaches Pramaan and standalone routes show their own shell titles', async ({
  page,
}) => {
  await signIn(page, 'owner');
  await selectTenant(page, 'a');
  await page.goto('/reports?tab=pramaan');
  await expect(page.getByRole('button', { name: 'Closure dossiers' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  for (const [route, title] of [
    ['/portal', 'Client Portal'],
    ['/engagements', 'Engagements'],
    ['/onboarding', 'Enterprise Onboarding'],
  ] as const) {
    await page.goto(route);
    await expect(page.locator('header').first().getByText(title, { exact: true })).toBeVisible();
  }
});
