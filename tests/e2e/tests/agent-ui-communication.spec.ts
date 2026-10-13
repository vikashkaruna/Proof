/**
 * E2E: Agent ↔ UI communication.
 *
 * `/workbench` needs `WORKBENCH_ACCESS`, held only by the internal `founder`
 * (the analyst lost it on 2026-10-12), and `ALWAYS_MFA_REQUIRED` holds the
 * founder at enrolment until a TOTP challenge is satisfied. These were `fixme` for exactly one reason: the
 * harness did not start a BFF, so there was nothing to satisfy the challenge
 * against. It starts one now, so the analyst signs in, clears the login-MFA
 * gate with a real code, and reaches the workbench the way a person does.
 */

import { test, expect } from '@playwright/test';
import { signInFreshAnalyst, signInFreshFounder, state } from '../fixtures';

test.describe('Agent ↔ UI communication', () => {
  test.beforeEach(async ({ page }) => {
    await signInFreshFounder(page, 'workbench');
  });

  test('agent progress events update the UI', async ({ page }) => {
    await page.goto('/workbench');

    // The workbench renders the agent fleet and interactive cockpit
    await expect(
      page.getByRole('main').getByRole('heading', { name: /Agent Workbench/i }),
    ).toBeVisible();
    await expect(page.getByText('Agent fleet')).toBeVisible();
    // C-W0-7: no static fleet health or registry figures are presented as live data.
    await expect(page.getByText('Health not monitored here')).toBeVisible();
    await expect(page.getByText('10 / 10 Online')).toHaveCount(0);
    await expect(page.getByText('Prompt registry')).toBeVisible();
    await expect(page.getByTestId('workbench-prompt-registry')).toContainText('not implemented');
    await expect(page.getByTestId('workbench-ledger-today')).toHaveText(/^\d+$/);
    await expect(page.getByTestId('workbench-awaiting-review')).toHaveText(/^\d+$/);

    // Verify key named agents exist in the cockpit execution selector
    await expect(page.locator('option[value="drishti"]')).toContainText(/Drishti/i);
    await expect(page.locator('option[value="parikshan"]')).toContainText(/Parikshan/i);
    await expect(page.locator('option[value="sudhaar"]')).toContainText(/Sudhaar/i);
    await expect(page.locator('option[value="karya"]')).toContainText(/Karya/i);
  });

  test('the workbench renders the autonomy badges', async ({ page }) => {
    await page.goto('/workbench');
    await expect(page.getByText(/Autonomy/i).first()).toBeVisible();
    // The badge states a configured target, not a verified residency (W9).
    await expect(page.getByText(/Env: \S+ · configured region target: ap-south-1/)).toBeVisible();
    await expect(page.getByText(/ap-south-1/i).first()).toBeVisible();
  });
});

// UI protocol tests use explicit injected BFF responses after real sign-in.
// These do not claim an isolated worker or a live connector executed.
test('workbench refuses absent/failed statuses and shows only confirmed success', async ({
  page,
}) => {
  await signInFreshFounder(page, 'workbench-outcomes');
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
  const run = page.getByRole('button', { name: 'Run drishti', exact: true });
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
  // The default persona library deliberately has zero controls. Give this
  // invocation-only test a complete synthetic baseline so the button has a
  // real owned assessment; runtime responses below remain explicit fixtures.
  const engagement = crypto.randomUUID();
  const library = `ui-invocation-${engagement}`;
  async function seed(table: string, body: unknown) {
    const response = await fetch(`${state.supabaseUrl}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        apikey: state.publishableKey,
        Authorization: `Bearer ${state.serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(201);
  }
  await seed('control_libraries', {
    version: library,
    published_at: new Date().toISOString(),
    published_by: 'browser-fixture',
    change_log: 'Invocation fixture only',
    control_count: 1,
    is_current: false,
  });
  await seed('controls', {
    id: 'UI-FIXTURE-01',
    library_version: library,
    title: 'Invocation fixture',
    obligation: 'Fixture only',
    domain: 'SEC',
    severity: 'low',
    citations: [],
    evidence_required: [],
    assessment_questions: [],
    scoring: {},
    remediation_patterns: [],
    introduced_in_version: library,
  });
  await seed('engagements', {
    id: engagement,
    tenant_id: state.tenantA.id,
    library_version: library,
    title: 'Invocation UI fixture',
  });
  let release: (() => void) | undefined;
  let mode: 'failure' | 'accepted' = 'failure';
  let original: Record<string, unknown> | null = null;
  let posts = 0;
  const runId = crypto.randomUUID();
  await page.route('**/api/bff/v1/assessment/jobs', async (route) => {
    posts++;
    const input = route.request().postDataJSON() as Record<string, unknown>;
    expect(input.engagementId).toBe(engagement);
    expect(input.answers).toEqual({});
    expect(input.applicability).toEqual({
      sdfSelfAttested: null,
      processesChildren: null,
      processesHealth: null,
    });
    expect(route.request().headers()['idempotency-key']).toBe(input.operationKey);
    expect(route.request().headers()['x-expected-actor-id']).toMatch(/^[0-9a-f-]{36}$/);
    if (original) expect(input).toEqual(original);
    else original = input;
    if (mode === 'failure') {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.fulfill({
        status: 503,
        json: { error: { code: 'assessment_request_unconfirmed' } },
      });
    } else
      await route.fulfill({
        status: 202,
        json: {
          jobId: input.operationKey,
          runId,
          expiresAt: new Date(Date.now() + 300000).toISOString(),
          status: 'accepted',
          statusUrl: `/api/bff/v1/assessment/jobs/${input.operationKey}`,
        },
      });
  });
  await page.route('**/api/bff/v1/assessment/jobs/*', async (route) => {
    expect(route.request().method()).toBe('GET');
    expect(original).not.toBeNull();
    await route.fulfill({
      status: 200,
      json: {
        jobId: original!.operationKey,
        runId,
        engagementId: engagement,
        correlationId: original!.operationKey,
        libraryVersion: library,
        recordedRunStatus: 'queued',
        schedulingStatus: 'pending',
        createdAt: new Date().toISOString(),
        claimedAt: null,
        allAgentEndToEndAccepted: false,
        status: 'unconfirmed',
        phase: 'queued',
        finalization: null,
      },
    });
  });
  await page.goto(`/assessment?engagement=${engagement}`);
  const summary = await page.getByTestId('assessment-summary').innerText();
  await page.clock.install();
  await page.getByRole('checkbox', { name: /every answer and applicability flag/ }).check();
  await page
    .getByRole('button', { name: 'Request unknown-answer assessment', exact: true })
    .click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.clock.fastForward(7000);
  await expect(page.getByTestId('pipeline-parikshan')).toHaveAttribute('data-state', 'not-run');
  expect(await page.getByTestId('assessment-summary').innerText()).toBe(summary);
  release!();
  const requestPanel = page.getByRole('region', { name: 'Request a saved assessment' });
  await expect(requestPanel.getByRole('alert')).toContainText('assessment_request_unconfirmed');
  expect(posts).toBe(1);
  await page.reload();
  await expect(requestPanel.getByRole('button', { name: 'Check retained request' })).toBeVisible();
  expect(posts).toBe(1);
  await requestPanel.getByRole('button', { name: 'Check retained request' }).click();
  await expect(requestPanel.getByRole('status')).toContainText('Completion is not yet confirmed');
  mode = 'accepted';
  await requestPanel.getByRole('button', { name: 'Retry original request' }).click();
  await expect(requestPanel.getByRole('status')).toContainText('Original request accepted');
  expect(posts).toBe(2);
  await expect(page.getByTestId('pipeline-parikshan')).toHaveAttribute('data-state', 'not-run');
  for (const agent of ['drishti', 'vibhaag', 'saakshi', 'prativedan'])
    await expect(page.getByTestId(`pipeline-${agent}`)).toHaveAttribute('data-state', 'not-run');
  expect(await page.getByTestId('assessment-summary').innerText()).toBe(summary);
});
