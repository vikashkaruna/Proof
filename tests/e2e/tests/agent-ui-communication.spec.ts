/**
 * E2E: Agent ↔ UI communication.
 *
 * Verifies that the Web UI renders the agent fleet and cockpit.
 *
 * ── Why this is `fixme` and not deleted ──────────────────────────────
 *
 * `/workbench` needs `WORKBENCH_ACCESS`, which only `founder` and
 * `axiom_analyst` hold. Both are in `ALWAYS_MFA_REQUIRED`, so a tenant cannot
 * exempt them and they are held at enrolment until a TOTP factor is enrolled
 * and a challenge satisfied. Satisfying it needs a running BFF, which this
 * harness does not yet start — the same gap Doc 11 Revision 16 records as the
 * next W1 piece, where an approver carries an approval through to a signed
 * token in a browser.
 *
 * Until then these assertions cannot be made honestly. They previously
 * "passed" only in the sense that they never ran: `tests/e2e` was missing from
 * the pnpm workspace, so `@playwright/test` was never installed. Marking them
 * fixme keeps them visible as outstanding work rather than deleting real
 * coverage or leaving a red suite.
 */

import { test, expect } from '@playwright/test';

test.describe.fixme('Agent ↔ UI communication', () => {
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
