import { expect, test, type Page, type Locator } from '@playwright/test';
import { z } from 'zod';
import {
  createMfaAccount,
  selectTenant,
  signIn,
  signInAs,
  signInFreshFounder,
  signInFreshOwner,
  state,
} from '../fixtures';
import { marketingUrl } from '../target';

async function expectNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
}

async function tabTo(page: Page, link: Locator) {
  for (let step = 0; step < 80; step++) {
    await page.keyboard.press('Tab');
    if (await link.evaluate((element) => element === document.activeElement)) break;
  }
  await expect(link).toBeFocused();
}

test('WEB-01-P/B: public entry links require a session before private records', async ({
  page,
}) => {
  for (const [name, href] of [
    ['Sign in', '/login'],
    ['Open App', '/start'],
    ['Open Workbench', '/workbench'],
    ['Client Portal', '/portal'],
  ] as const) {
    await page.goto('/');
    const link = page.getByRole('link', { name, exact: true });
    await expect(link).toHaveAttribute('href', href);
    await link.click();
    await expect(page).toHaveURL(/\/login(?:\?|$)/);
    await expect(page.getByLabel(/^Password/)).toBeVisible();
    await expect(page.getByText(state.planA.title, { exact: true })).toHaveCount(0);
  }
});

test('WEB-01-R: keyboard entry and browser history work at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  const link = page.getByRole('link', { name: 'Sign in', exact: true });
  await tabTo(page, link);
  expect(await link.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/login$/);
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Axiom Proof', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.goForward();
  await expect(page.getByLabel(/^Password/)).toBeVisible();
});

test('WEB-16-P/B: engagement details bind findings and plans to the active company', async ({
  page,
}) => {
  await signInFreshOwner(page, 'manual-engagement-detail');
  await selectTenant(page, 'a');
  await page.goto('/engagements');
  const detail = page.locator(`a[href="/engagements/${state.engagementA}"]`).first();
  await expect(detail).toBeVisible();
  await detail.click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: new RegExp(state.planA.title) })).toHaveAttribute(
    'href',
    `/plans/${state.planA.id}`,
  );
  await expect(page.getByText(state.planB.title, { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText(state.libraryVersion, { exact: false }).first()).toBeVisible();
  const foreignPlan = await fetch(
    `${state.supabaseUrl}/rest/v1/remediation_plans?id=eq.${state.planB.id}&select=engagement_id`,
    {
      headers: {
        apikey: state.publishableKey,
        Authorization: `Bearer ${state.serviceKey}`,
      },
      signal: AbortSignal.timeout(10_000),
    },
  );
  expect(foreignPlan.status).toBe(200);
  const foreign = z
    .array(z.object({ engagement_id: z.uuid() }))
    .length(1)
    .parse(await foreignPlan.json());
  await page.goto(`/engagements/${foreign[0]!.engagement_id}`);
  await expect(page.getByRole('heading', { name: /not found|404/i })).toBeVisible();
  await expect(page.getByText(state.planB.title, { exact: true })).toHaveCount(0);
  const missing = await page.goto(`/engagements/${crypto.randomUUID()}`);
  expect(missing?.status()).toBe(404);
  await expect(page.getByText(state.planA.title, { exact: true })).toHaveCount(0);
  await page.context().clearCookies();
  await page.goto(`/engagements/${state.engagementA}`);
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
});

test('WEB-16-B: malformed engagement identifiers are not found', async ({ page }) => {
  await signInFreshOwner(page, 'manual-engagement-invalid');
  await selectTenant(page, 'a');
  await page.goto('/engagements/not-a-uuid');
  await expect(page.getByRole('heading', { name: /not found|404/i })).toBeVisible();
});

test('BR2-0157-02: dry-run detail is read-only and rejects malformed action IDs', async ({
  page,
}) => {
  await signIn(page, 'viewer');
  await selectTenant(page, 'a');
  await page.goto(`/plans/${state.planA.id}/actions/${state.planA.actionId}`);
  await expect(page.getByRole('heading', { name: /Approval readiness/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Recorded dry run/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Rollback/ }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /edit|approve|execute|save/i })).toHaveCount(0);
  expect((await page.goto(`/plans/${state.planA.id}/actions/not-a-uuid`))?.status()).toBe(404);
});

test('RPT-ACC-01: unconfigured drafting is explicit and ordinary roles cannot draft', async ({
  page,
}) => {
  await signInFreshFounder(page, 'manual-accounted-draft');
  await selectTenant(page, 'a');
  await page.goto('/reports/accounted-drafts');
  await expect(page.getByRole('heading', { name: 'Accounted assessment draft' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('not configured');
  await expect(page.getByRole('button', { name: /generate|retain|release/i })).toHaveCount(0);
  await page.context().clearCookies();
  await signIn(page, 'viewer');
  await selectTenant(page, 'a');
  await page.goto('/reports/accounted-drafts');
  await expect(
    page.getByText('A current internal founder session is required.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /generate|retain|release/i })).toHaveCount(0);
  await page.context().clearCookies();
  await signInFreshOwner(page, 'manual-accounted-draft-owner');
  await selectTenant(page, 'a');
  await page.goto('/reports/accounted-drafts');
  await expect(
    page.getByText('A current internal founder session is required.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /generate|retain|release/i })).toHaveCount(0);
});

test('DFD-174-01: disabled declarations remain read-only after refresh', async ({ page }) => {
  await signIn(page, 'viewer');
  await selectTenant(page, 'a');
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/bff/v1/data-flows') && request.method() !== 'GET')
      writes.push(request.method());
  });
  for (let visit = 0; visit < 2; visit++) {
    await page.goto('/datamap/flows');
    await expect(
      page.getByRole('heading', { name: 'Reviewed data flow declarations' }),
    ).toBeVisible();
    await expect(
      page.getByText(/Data flow declarations are disabled or unavailable/),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /prepare|approve|reject|withdraw/i }),
    ).toHaveCount(0);
  }
  expect(writes).toEqual([]);
});

test('STANDING-UI-01: unavailable delegation grants no authority and viewers cannot open it', async ({
  page,
}) => {
  await signInFreshOwner(page, 'manual-standing-unavailable');
  await selectTenant(page, 'a');
  await page.goto('/approvals/standing');
  await expect(
    page.getByText(/Standing approval delegation is disabled or unavailable/),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /approve|retain|issue|execute/i })).toHaveCount(0);
  await page.context().clearCookies();
  await signIn(page, 'viewer');
  await selectTenant(page, 'a');
  await page.goto('/approvals/standing');
  await expect(page).toHaveURL(/\/portal\?error=forbidden/);
});

test('SCOV-175-UI-02 boundary: unavailable coverage cannot authorize a fire', async ({ page }) => {
  await signInFreshOwner(page, 'manual-coverage-unavailable');
  await selectTenant(page, 'a');
  await page.goto('/monitoring/scheduled-assessments');
  await expect(page.getByRole('heading', { name: 'Scheduled coverage assessments' })).toBeVisible();
  await expect(
    page.getByRole('alert').filter({
      hasText:
        /Scheduled assessment delegation is disabled or unavailable|Current eligible sources and scope history could not be read/,
    }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /authorize|retain|revoke/i })).toHaveCount(0);
  await expect(page.getByText(/Every business\/questionnaire fact remains Unknown/)).toBeVisible();
});

for (const [route, heading] of [
  ['/', /Agents do the work/i],
  ['/about', /About Axiom Proof/],
  ['/agents', /agent roster/i],
  ['/pricing', /pricing/i],
  ['/privacy', /privacy/i],
  ['/terms', /terms/i],
  ['/contact', /Talk to the founder/i],
] as const) {
  test(`public ${route}: phone layout, keyboard navigation and history`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${marketingUrl}${route}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(heading);
    await expectNoHorizontalOverflow(page);
    const destination = route === '/privacy' ? '/terms' : '/privacy';
    const link = page
      .getByRole('link', { name: route === '/privacy' ? /Terms/ : /Privacy/ })
      .first();
    await tabTo(page, link);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${marketingUrl}${destination}`);
    await page.goBack();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(heading);
    await page.reload();
    await expectNoHorizontalOverflow(page);
  });
}

test('recovery form explains the identity note requirement and does not submit a short note', async ({
  page,
}) => {
  await signInFreshFounder(page, 'manual-recovery-guidance');
  await selectTenant(page, 'a');
  await page.goto('/settings/security');
  const panel = page.getByTestId('mfa-recovery-console');
  await panel.getByRole('button', { name: 'Open recovery console' }).click();
  await panel.getByLabel('Account to recover').selectOption(state.accounts.owner.id);
  const note = panel.getByLabel('How you verified their identity');
  await expect(note).toHaveAttribute('required', '');
  await expect(note).toHaveAttribute('minlength', '10');
  await expect(note).toHaveAttribute('maxlength', '1000');
  await expect(panel.locator('#recoveryReasonHint')).toHaveText(
    'Required: at least 10 characters (0 so far).',
  );
  let recoveryPosts = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/mfa\/recovery\/cases(?:\?|$)/.test(request.url()))
      recoveryPosts++;
  });
  await note.fill('too short');
  await panel.getByLabel('Your authenticator code').first().fill('123456');
  const open = panel.getByRole('button', { name: 'Open recovery', exact: true });
  await expect(open).toBeDisabled();
  await expect(panel.locator('#recoveryOpenMissing')).toHaveText(
    'Still needed: a verification note of at least 10 characters.',
  );
  await expect(panel.locator('#recoveryReasonHint')).toHaveText(
    'Required: at least 10 characters (9 so far).',
  );
  await note.fill('Known call');
  await expect(open).toBeEnabled();
  await expect(panel.locator('#recoveryOpenMissing')).toHaveCount(0);
  // Never submit: identity verification and the actor's current code are human inputs.
  expect(recoveryPosts).toBe(0);
});

// Each journey owns this approver; other foreign-tenant denial fixtures stay intact.
test('approver switches organizations from a plan detail to the new plan list', async ({
  page,
}) => {
  const who = await createMfaAccount('plan-organization-switch', {
    role: 'approver',
    withFactor: true,
  });
  const membership = await fetch(`${state.supabaseUrl}/rest/v1/tenant_users`, {
    method: 'POST',
    headers: {
      apikey: state.publishableKey,
      Authorization: `Bearer ${state.serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      tenant_id: state.tenantB.id,
      user_id: who.id,
      role: 'approver',
      approval_scopes: [],
    }),
    signal: AbortSignal.timeout(10000),
  });
  expect(membership.status).toBe(201);
  await selectTenant(page, 'a');
  await signInAs(page, who.email, who.password, who.totpSecret);
  await page.goto(`/plans/${state.planA.id}`);
  await expect(page.getByRole('heading', { name: state.planA.title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Switch organization' }).click();
  await page.getByRole('button', { name: new RegExp(state.tenantB.name) }).click();
  await expect(page).toHaveURL(/\/plans$/);
  await expect(page.locator(`a[href="/plans/${state.planB.id}"]`)).toBeVisible();
  await page.reload();
  await page.locator(`a[href="/plans/${state.planB.id}"]`).click();
  await expect(page.getByRole('heading', { name: state.planB.title, exact: true })).toBeVisible();
  const foreign = await page.goto(`/plans/${state.planA.id}`);
  expect(foreign?.status()).toBe(404);
  await expect(page.getByText(state.planA.title, { exact: true })).toHaveCount(0);
});
