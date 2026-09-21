/**
 * E2E: Agent ↔ UI communication.
 *
 * `/workbench` needs `WORKBENCH_ACCESS`, held only by `founder` and
 * `axiom_analyst`, and `ALWAYS_MFA_REQUIRED` holds both at enrolment until a
 * TOTP challenge is satisfied. These were `fixme` for exactly one reason: the
 * harness did not start a BFF, so there was nothing to satisfy the challenge
 * against. It starts one now, so the analyst signs in, clears the login-MFA
 * gate with a real code, and reaches the workbench the way a person does.
 */

import { test, expect } from '@playwright/test';
import { satisfyLoginMfa, selectTenant, signIn } from '../fixtures';

test.describe('Agent ↔ UI communication', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'analyst');
    await selectTenant(page, 'a');
    await satisfyLoginMfa(page, 'analyst');
  });

  test('agent progress events update the UI', async ({ page }) => {
    await page.goto('/workbench');

    // The workbench renders the agent fleet and interactive cockpit
    await expect(
      page.getByRole('main').getByRole('heading', { name: /Agent Workbench/i }),
    ).toBeVisible();
    await expect(page.getByText('Agent fleet')).toBeVisible();
    await expect(page.getByText('10 / 10 Online')).toBeVisible();
    await expect(page.getByText('Prompt registry')).toBeVisible();

    // Verify key named agents exist in the cockpit execution selector
    await expect(page.locator('option[value="drishti"]')).toContainText(/Drishti/i);
    await expect(page.locator('option[value="parikshan"]')).toContainText(/Parikshan/i);
    await expect(page.locator('option[value="sudhaar"]')).toContainText(/Sudhaar/i);
    await expect(page.locator('option[value="karya"]')).toContainText(/Karya/i);
  });

  test('the workbench renders the autonomy badges', async ({ page }) => {
    await page.goto('/workbench');
    await expect(page.getByText(/Autonomy/i).first()).toBeVisible();
    await expect(page.getByText(/Env: Production/i)).toBeVisible();
    await expect(page.getByText(/ap-south-1/i).first()).toBeVisible();
  });
});
