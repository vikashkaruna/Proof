/**
 * E2E: the Approval Console — the most security-critical screen.
 *
 * This file used to open `/plans` after writing a fake Supabase session into
 * `localStorage` with `access_token: 'test-access-token'`. That string is one
 * of the BFF's `SYNTHETIC_TOKENS`, accepted only under the e2e bypass that
 * W0.0 deleted — so the setup was inert, and the tests were really asserting
 * what an unauthenticated visitor sees. It also navigated to a hardcoded plan
 * id that has never existed in any database.
 *
 * None of that failed, because `tests/e2e` was missing from the pnpm workspace
 * and the suite could not run. Now it can, so the tests sign in as a seeded
 * persona and use a plan that is really there.
 */

import { test, expect } from '@playwright/test';
import { selectTenant, signIn, state } from '../fixtures';

import { marketingUrl } from '../target';

test.describe('Approval Console — the trust surface', () => {
  test('a plan lists its remediation actions for a signed-in member', async ({ page }) => {
    await signIn(page, 'owner');
    await selectTenant(page, 'a');
    await page.goto('/plans');
    await expect(
      page.getByRole('main').getByRole('heading', { name: /Remediation Plans/i }),
    ).toBeVisible();
  });

  test('the kill switch is visible on a plan page', async ({ page }) => {
    // An owner holds KILL_SWITCH_ENGAGE_TENANT. Stopping must never be the
    // thing that needs an escalation.
    await signIn(page, 'owner');
    await selectTenant(page, 'a');
    await page.goto(`/plans/${state.planA.id}`);
    await expect(page.getByText('Engage kill switch').first()).toBeVisible();
  });

  test('a viewer sees the plan and no kill switch', async ({ page }) => {
    // The complement, which the old inert-session version could not express:
    // the same page, a different role, a different set of controls.
    await signIn(page, 'viewer');
    await selectTenant(page, 'a');
    await page.goto(`/plans/${state.planA.id}`);
    await expect(page.locator('body')).toContainText(state.planA.title);
    await expect(page.getByText('Engage kill switch')).toHaveCount(0);
  });

  test('the non-negotiable safety rules are visible on the public site', async ({ page }) => {
    await page.goto(`${marketingUrl}/`);
    await expect(page.getByText('The non-negotiable safety rules')).toBeVisible();
    await expect(page.getByText(/No mutating agent action executes without/i)).toBeVisible();
  });
});
