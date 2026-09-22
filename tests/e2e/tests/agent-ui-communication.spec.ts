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
import { signInFreshAnalyst } from '../fixtures';

test.describe('Agent ↔ UI communication', () => {
  test.beforeEach(async ({ page }) => {
    await signInFreshAnalyst(page, 'workbench');
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

// UI protocol tests use explicit injected BFF responses after real sign-in.
// These do not claim an isolated worker or a live connector executed.
test('workbench refuses absent/failed statuses and shows only confirmed success', async ({
  page,
}) => {
  await signInFreshAnalyst(page, 'workbench-outcomes');
  let mode: 'missing' | 'failed' | 'success' = 'missing';
  let sent: Record<string, unknown> = {};
  await page.route('**/api/bff/v1/agents/drishti/run', async (route) => {
    sent = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      json: {
        agent: 'drishti',
        correlation_id: sent.correlation_id,
        ...(mode === 'missing' ? {} : { status: mode === 'success' ? 'succeeded' : 'failed' }),
        latency_ms: 10,
        error: null,
        output: {},
        ledger_entry_ids: ['1', '2'],
      },
    });
  });
  await page.goto('/workbench');
  const run = page.getByRole('button', { name: '⚡ Run drishti', exact: true });
  await run.click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('could not be confirmed');
  await expect(page.getByText(/Execution completed/)).toHaveCount(0);
  expect(sent.scope).toBe('workbench');
  expect(sent.correlation_id).toEqual(expect.any(String));
  mode = 'failed';
  await run.click();
  await expect(page.getByRole('main').getByRole('alert')).toBeVisible();
  await expect(page.getByText(/Execution completed/)).toHaveCount(0);
  mode = 'success';
  await run.click();
  await expect(page.getByRole('status').filter({ hasText: 'Execution completed' })).toBeVisible();
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
});

test('assessment waits for confirmation and never invents score improvements or other stages', async ({
  page,
}) => {
  await signInFreshAnalyst(page, 'assessment-outcomes');
  let release: (() => void) | undefined;
  let mode: 'failure' | 'success' = 'failure';
  await page.route('**/api/bff/v1/agents/parikshan/run', async (route) => {
    const input = route.request().postDataJSON() as Record<string, unknown>;
    if (mode === 'failure') {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.fulfill({
        status: 503,
        json: {
          error: {
            code: 'agent_completion_unconfirmed',
            message: 'Inspect this run before retrying.',
          },
        },
      });
    } else
      await route.fulfill({
        status: 200,
        json: {
          agent: 'parikshan',
          correlation_id: input.correlation_id,
          status: 'succeeded',
          error: null,
          output: {},
          latency_ms: 1,
          ledger_entry_ids: ['1', '2'],
        },
      });
  });
  await page.goto('/assessment');
  const summary = await page.getByTestId('assessment-summary').innerText();
  await page.clock.install();
  await page.getByRole('button', { name: 'Run Parikshan', exact: true }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.clock.fastForward(7000);
  await expect(page.getByTestId('pipeline-parikshan')).toHaveAttribute('data-state', 'running');
  await expect(page.getByText('Parikshan invocation completed.', { exact: false })).toHaveCount(0);
  expect(await page.getByTestId('assessment-summary').innerText()).toBe(summary);
  release!();
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    'Inspect this run before retrying.',
  );
  await expect(page.getByTestId('pipeline-parikshan')).toHaveAttribute('data-state', 'not-run');
  expect(await page.getByTestId('assessment-summary').innerText()).toBe(summary);
  mode = 'success';
  await page.getByRole('button', { name: 'Run Parikshan', exact: true }).click();
  await expect(page.getByTestId('pipeline-parikshan')).toHaveAttribute('data-state', 'completed');
  for (const agent of ['drishti', 'vibhaag', 'saakshi', 'prativedan'])
    await expect(page.getByTestId(`pipeline-${agent}`)).toHaveAttribute('data-state', 'not-run');
  expect(await page.getByTestId('assessment-summary').innerText()).toBe(summary);
});
