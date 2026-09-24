import { test, expect, type Browser, type Page } from '@playwright/test';
import { createMfaAccount, selectTenant, signInAs, state } from '../fixtures';

// C-W1-3: an admin invites by email; only that signed-in, confirmed address can
// accept, and acceptance is what grants membership. Delivery stays disabled in
// acceptance, so the one-time link is shared out of band.

async function authAccount(label: string) {
  const email = `invitee-${label}-${crypto.randomUUID().slice(0, 8)}@example.invalid`;
  const password = `Pw-${crypto.randomUUID()}`;
  // Like a real sign-up: an auth identity only — no profile row and no membership.
  const res = await fetch(`${state.supabaseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: state.publishableKey,
      Authorization: `Bearer ${state.serviceKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  expect(res.status).toBe(200);
  const { id } = (await res.json()) as { id: string };
  return { id, email, password };
}

async function invite(page: Page, email: string, role = 'viewer') {
  await page.goto('/settings/members');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Role', { exact: true }).selectOption(role);
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('status')).toContainText('Invitation created');
  await expect(page.getByRole('status')).toContainText('Email not configured');
  const link = await page.getByTestId('invite-link').inputValue();
  expect(link).toMatch(/\/invite#token=[A-Za-z0-9_-]{43}$/);
  return link;
}

async function openAsInvitee(
  browser: Browser,
  origin: string,
  link: string,
  who: { email: string; password: string },
) {
  const context = await browser.newContext({ baseURL: origin });
  const page = await context.newPage();
  await page.goto(link);
  // The token leaves the address bar immediately.
  await expect(page).toHaveURL(/\/invite$/);
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page).toHaveURL(/\/login\?redirect=%2Finvite|\/login\?redirect=\/invite/);
  await page.fill('input[name="email"]', who.email);
  await page.fill('input[name="password"]', who.password);
  await Promise.all([
    page.waitForURL(/\/invite$/, { timeout: 30_000 }),
    page.click('button[type="submit"]'),
  ]);
  return { context, page };
}

test('an admin invites a person who accepts after signing in as the invited address', async ({
  page,
  browser,
}) => {
  const admin = await createMfaAccount('invite-admin', { role: 'admin' });
  await signInAs(page, admin.email, admin.password);
  await selectTenant(page, 'a');
  const invitee = await authAccount('accept');
  const link = await invite(page, invitee.email);
  await expect(page.getByTestId(`invitation-state-${invitee.email}`)).toContainText('Open');

  const origin = new URL(page.url()).origin;
  const { context, page: invited } = await openAsInvitee(browser, origin, link, invitee);
  try {
    await invited.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(invited).toHaveURL(/\/dashboard/, { timeout: 20_000 });
    const tenants = await invited.request.get('/api/bff/v1/user/tenants');
    expect(tenants.status()).toBe(200);
    expect(JSON.stringify(await tenants.json())).toContain(state.tenantA.id);
    // The link is single-use for anyone else, and replay by the invitee is harmless.
    await invited.goto(link);
    await invited.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(invited).toHaveURL(/\/dashboard/, { timeout: 20_000 });
  } finally {
    await context.close();
  }
  await page.reload();
  await expect(page.getByTestId(`invitation-state-${invitee.email}`)).toContainText('Accepted');
  await expect(page.getByTestId('member-list')).toContainText(invitee.email);
});

test('another account cannot accept, and a revoked invitation grants nothing', async ({
  page,
  browser,
}) => {
  const admin = await createMfaAccount('invite-revoke', { role: 'admin' });
  await signInAs(page, admin.email, admin.password);
  await selectTenant(page, 'a');
  const intended = await authAccount('intended');
  const intruder = await authAccount('intruder');
  const link = await invite(page, intended.email);
  // Admins cannot mint owners.
  await expect(
    page.getByLabel('Role', { exact: true }).locator('option[value="owner"]'),
  ).toHaveCount(0);

  const origin = new URL(page.url()).origin;
  const wrong = await openAsInvitee(browser, origin, link, intruder);
  try {
    await wrong.page.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(wrong.page.getByTestId('invite-accept').getByRole('alert')).toContainText(
      'Sign in with the email address this invitation was sent to',
    );
  } finally {
    await wrong.context.close();
  }

  await page.reload();
  await page.getByRole('button', { name: `Revoke ${intended.email}` }).click();
  await expect(page.getByTestId(`invitation-state-${intended.email}`)).toContainText('Revoked');

  const right = await openAsInvitee(browser, origin, link, intended);
  try {
    await right.page.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(right.page.getByTestId('invite-accept').getByRole('alert')).toContainText(
      'revoked',
    );
    const tenants = await right.page.request.get('/api/bff/v1/user/tenants');
    expect(JSON.stringify(await tenants.json())).not.toContain(state.tenantA.id);
  } finally {
    await right.context.close();
  }
});
