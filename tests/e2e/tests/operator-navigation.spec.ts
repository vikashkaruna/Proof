import { expect, test } from '@playwright/test';
import { selectTenant, signIn, signInFreshOwner } from '../fixtures';

test('an approver opens the approval queue but holds no kill switch; a viewer reads sealed Pramaan only', async ({
  page,
}) => {
  await signIn(page, 'approver');
  await selectTenant(page, 'a');
  await page.goto('/dashboard');
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: /Approval Queue/ })
    .click();
  await expect(page).toHaveURL(/\/approval$/);
  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Approval queue' })).toBeVisible();
  // Halting and resuming automation is the owner's and admin's, not the approver's.
  await expect(page.getByRole('button', { name: /Kill switch/i })).toHaveCount(0);
  await expect(
    page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', {
      name: /Breach & Incident/,
    }),
  ).toBeVisible();

  await page.context().clearCookies();
  await signIn(page, 'viewer');
  await selectTenant(page, 'a');
  await page.goto('/dashboard');
  await expect(page.getByRole('link', { name: /Approval Queue/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Statutory Proof Dossiers/ })).toHaveCount(0);
  await page.goto('/reports?tab=pramaan');
  await expect(page.getByRole('button', { name: 'Closure dossiers' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  // Read-only: no preparation form and no export of any kind.
  await expect(page.getByText('Prepare source-bound dossier')).toHaveCount(0);
  await page.getByRole('button', { name: 'Working reports and registers' }).click();
  await expect(page.getByText('Tenant Approval History Audit Export')).toHaveCount(0);
  await page.goto('/ledger');
  await expect(page.getByRole('button', { name: /Export recorded ledger entries/ })).toHaveCount(0);
});

test('an owner reaches Pramaan and standalone routes show their own shell titles', async ({
  page,
}) => {
  await signInFreshOwner(page, 'operator-navigation.spec-1');
  await selectTenant(page, 'a');
  await page.goto('/reports?tab=pramaan');
  await expect(page.getByRole('button', { name: 'Closure dossiers' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('main')).toHaveCount(1);
  for (const [route, title] of [
    ['/portal', 'Client Portal'],
    ['/engagements', 'Engagements'],
    ['/onboarding', 'Enterprise Onboarding'],
  ] as const) {
    await page.goto(route);
    await expect(page.locator('header').first().getByText(title, { exact: true })).toBeVisible();
    await expect(page.getByRole('main')).toHaveCount(1);
    if (route === '/engagements') {
      await expect(page.getByRole('link', { name: /Engagements/ }).first()).toHaveAttribute(
        'aria-current',
        'page',
      );
    }
  }
});
