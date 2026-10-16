import { test, expect, type Browser, type Page } from '@playwright/test';
import { generateTotp } from '@axiom/mfa';
import {
  createMfaAccount,
  freshTotpCode,
  satisfyLoginMfaWithSecret,
  selectTenant,
  signInAs,
  state,
} from '../fixtures';
import { acceptanceTarget } from '../target';

/**
 * Founder-led MFA recovery (0152/0153) through real GoTrue sessions.
 *
 * The SQL suite proves the fence against a stubbed auth.sessions. This proves
 * it against the real one: that opening a case ends the subject's live
 * browser session (its still-unexpired JWT is refused by the BFF), that a
 * password sign-in afterwards lands on the recovery panel rather than a code
 * prompt the lost factor cannot satisfy, that both people see the same
 * session fingerprint, and that the new authenticator then passes ordinary
 * login MFA.
 *
 * It designates two fresh internal accounts as platform founders, so it runs
 * only against the harness-owned stack, never a deployed acceptance target.
 */

test.skip(Boolean(acceptanceTarget), 'Designates platform founders; harness-owned stack only');

async function designateFounder(userId: string): Promise<void> {
  const res = await fetch(`${state.supabaseUrl}/rest/v1/rpc/designate_platform_founder`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      apikey: state.publishableKey,
      Authorization: `Bearer ${state.serviceKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      p_user_id: userId,
      p_designated_by: 'e2e founder-mfa-recovery',
      p_reason: 'browser recovery journey',
    }),
  });
  if (res.status !== 204 && res.status !== 200) {
    throw new Error(`founder designation: ${res.status} — ${(await res.text()).slice(0, 300)}`);
  }
}

/** The browser session's current access token, read from its Supabase cookie. */
async function accessToken(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const chunks = cookies
    .filter((c) => /-auth-token(\.\d+)?$/.test(c.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
    .map((c) => c.value)
    .join('');
  const raw = decodeURIComponent(chunks);
  const json = raw.startsWith('base64-') ? Buffer.from(raw.slice(7), 'base64').toString() : raw;
  const token = (JSON.parse(json) as { access_token?: string }).access_token;
  if (!token) throw new Error('no access token in the browser session');
  return token;
}

/**
 * Straight to the BFF with a captured bearer token. Through the web proxy a
 * dead session is redirected to /login and the redirect followed, which would
 * hide whether the BFF itself refuses the still-unexpired JWT.
 */
async function bffDirect(token: string): Promise<number> {
  const res = await fetch(
    `http://127.0.0.1:${process.env.AXIOM_E2E_BFF_PORT ?? '4000'}/v1/mfa/status`,
    {
      headers: { Authorization: `Bearer ${token}`, 'X-Tenant-Id': state.tenantA.id },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    },
  );
  return res.status;
}

async function freshContextPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  return context.newPage();
}

test('a founder recovers another founder who lost their authenticator', async ({ browser }) => {
  test.setTimeout(420_000);
  const actor = await createMfaAccount('recovery-actor', {
    withFactor: true,
    isInternal: true,
    role: 'founder',
  });
  const subject = await createMfaAccount('recovery-subject', {
    withFactor: true,
    isInternal: true,
    role: 'founder',
  });
  await designateFounder(actor.id);
  await designateFounder(subject.id);

  // The subject's existing, MFA-verified browser session.
  const oldSubject = await freshContextPage(browser);
  await signInAs(oldSubject, subject.email, subject.password);
  await selectTenant(oldSubject, 'a');
  await satisfyLoginMfaWithSecret(oldSubject, subject.totpSecret!);
  const oldToken = await accessToken(oldSubject);
  expect(await bffDirect(oldToken)).toBe(200);

  // The actor opens the case with a fresh step-up.
  const founder = await freshContextPage(browser);
  await signInAs(founder, actor.email, actor.password);
  await selectTenant(founder, 'a');
  await satisfyLoginMfaWithSecret(founder, actor.totpSecret!);
  await founder.goto('/settings/security', { waitUntil: 'domcontentloaded' });
  const consolePanel = founder.getByTestId('mfa-recovery-console');
  await consolePanel.getByRole('button', { name: 'Open recovery console' }).click();
  await consolePanel.getByLabel('Founder to recover').selectOption(subject.id);
  await consolePanel
    .getByLabel('How you verified their identity')
    .fill('Video call on the known number, e2e journey');
  await consolePanel
    .getByLabel('Your authenticator code')
    .first()
    .fill(await freshTotpCode(founder, actor.totpSecret!));
  await consolePanel.getByRole('button', { name: 'Open recovery' }).click();
  await expect(consolePanel.getByRole('status')).toContainText('signed out everywhere');

  // The old session's JWT has not expired, and the BFF refuses it; the browser
  // tab itself is sent back to sign-in.
  expect(await bffDirect(oldToken)).toBe(401);
  await oldSubject.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(oldSubject).toHaveURL(/\/login/);

  // A fresh password sign-in lands on the recovery panel, not /verify.
  const newSubject = await freshContextPage(browser);
  await signInAs(newSubject, subject.email, subject.password);
  await selectTenant(newSubject, 'a');
  await newSubject.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(newSubject).toHaveURL(/\/settings\/security\?recovery=1/);
  const panel = newSubject.getByTestId('mfa-recovery-beneficiary');
  await panel.getByRole('button', { name: 'Bind this sign-in' }).click();
  const fingerprint = (await panel.getByTestId('session-fingerprint').innerText()).trim();
  expect(fingerprint).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);

  // The actor sees the same fingerprint and confirms that exact session.
  await consolePanel.getByRole('button', { name: 'Refresh' }).first().click();
  const caseCard = consolePanel.getByTestId('mfa-recovery-case').filter({ hasText: subject.email });
  await expect(caseCard).toContainText(fingerprint);
  await caseCard
    .getByLabel('Your authenticator code')
    .fill(await freshTotpCode(founder, actor.totpSecret!));
  await caseCard.getByRole('button', { name: 'Codes match — confirm' }).click();
  await expect(consolePanel.getByRole('status')).toContainText('15 minutes');

  // The subject enrols a new authenticator on the bound session.
  await panel.getByRole('button', { name: 'Check whether the founder has confirmed' }).click();
  await panel.getByRole('button', { name: 'Set up new authenticator' }).click();
  const grouped = await panel.getByTestId('recovery-setup-key').innerText();
  const newSecret = grouped.replace(/\s+/g, '');
  expect(newSecret.length).toBeGreaterThan(15);
  await panel.getByLabel('Code from the new authenticator').fill(generateTotp(newSecret));
  await panel.getByRole('button', { name: 'Complete recovery' }).click();
  await expect(panel.getByTestId('recovery-code-list')).toBeVisible();

  // Ordinary login MFA now works with the new authenticator only.
  await newSubject.waitForTimeout(
    (Math.floor(Date.now() / 30_000) + 1) * 30_000 - Date.now() + 100,
  );
  await satisfyLoginMfaWithSecret(newSubject, newSecret);
  expect(await bffDirect(await accessToken(newSubject))).toBe(200);
  expect(await bffDirect(oldToken)).toBe(401);
  await newSubject.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(newSubject).toHaveURL(/\/dashboard/);

  for (const page of [oldSubject, founder, newSubject]) await page.context().close();
});
