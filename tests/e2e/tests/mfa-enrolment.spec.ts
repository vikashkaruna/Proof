import { test, expect, type Page } from '@playwright/test';
import { generateTotp } from '@axiom/mfa';
import {
  createMfaAccount,
  selectTenant,
  signInAs,
  satisfyLoginMfaWithSecret,
  state,
} from '../fixtures';

/**
 * W1 · SEC-8 — enrolment, replacement and recovery, driven through the browser.
 *
 * Doc 11 promises step-up "re-challenged at the moment of approval-token
 * issuance". The approval journeys prove that half. They do it with factors
 * the SEED wrote straight into `user_mfa_factors`, so no seeded-factor journey
 * has ever exercised the path a real user takes to *get* a factor, or to
 * replace one they still hold.
 *
 * That gap hid two defects stacked on each other, and the first hid the
 * second. The Replace button called `POST /v1/mfa/enrol` with no
 * `mfaChallengeId`, so the BFF refused it at the gate — correctly, and because
 * it refused, nothing ever reached the database, where activating a
 * replacement raised 23505 against `user_mfa_factors_one_active_totp` and was
 * reported as `no_pending_factor`. Fixing only the UI would have swapped a
 * clean refusal for a misleading one. Migration 0030 is the other half.
 *
 * Every journey here provisions its OWN account. These are state transitions
 * on the account itself — a first enrolment happens once, a recovery code is
 * shown once and spends once, a replaced secret is not the seeded one — so a
 * journey written against a shared persona passes on a clean database and
 * fails on every rerun, including on a CI retry, which is the version of the
 * failure nobody would have read as a fixture problem.
 */

const SECURITY_PAGE = '/settings/security';

/** The setup key the enrolment panel shows, which is the new TOTP secret. */
async function readSetupKey(page: Page): Promise<string> {
  const key = page.locator('#setupKey');
  await expect(key).toBeVisible({ timeout: 20_000 });
  const text = (await key.innerText()).trim();
  expect(text.length).toBeGreaterThan(15);
  return text;
}

/**
 * Enter the six-digit code for `secret` and activate.
 *
 * Retries once into the next TOTP step. Activation verifies against the step
 * the server is in, and a code generated shortly before a boundary can be
 * stale by the time it is submitted — a clock race, not a defect, and waiting
 * is what a person does.
 */
async function activateWith(page: Page, secret: string): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const activationCode = generateTotp(secret);
    await page.fill('#activationCode', activationCode);
    await page.getByRole('button', { name: /^Activate$/ }).click();
    try {
      await expect(page.getByTestId('recovery-codes')).toBeVisible({ timeout: 15_000 });
      return activationCode;
    } catch {
      if (attempt === 1) throw new Error('activation was refused twice');
      await page.waitForTimeout(31_000);
    }
  }
  throw new Error('Activation did not complete');
}

/** The recovery codes shown once, at activation. */
async function readRecoveryCodes(page: Page): Promise<string[]> {
  await expect(page.getByTestId('recovery-codes')).toBeVisible({ timeout: 20_000 });
  const codes = await page.getByTestId('recovery-code').allInnerTexts();
  expect(codes.length).toBeGreaterThan(0);
  return codes.map((c) => c.trim());
}

/** Open the replacement step-up panel and submit `code` into it. */
async function submitReplacementCode(page: Page, code: string): Promise<void> {
  await page.getByRole('button', { name: /^Replace authenticator$/ }).click();
  await expect(page.getByTestId('mfa-replace-step-up')).toBeVisible({ timeout: 20_000 });
  await page.fill('#stepUpCode', code);
  await page.getByRole('button', { name: /^Confirm and replace$/ }).click();
}

test.describe('enrolling a first authenticator', () => {
  test('asks for no step-up, and issues recovery codes', async ({ page }) => {
    const who = await createMfaAccount('enrol');
    await signInAs(page, who.email, who.password);
    await selectTenant(page, 'a');
    await page.goto(SECURITY_PAGE);

    // The starting state has to be real, or "enrolment succeeded" would also
    // be true of an account that was already enrolled.
    await expect(page.locator('body')).toContainText('Not enrolled', { timeout: 20_000 });

    await page.getByRole('button', { name: /^Enrol an authenticator$/ }).click();

    // A first enrolment is deliberately NOT step-up gated — there is nothing
    // yet to protect. If this panel ever appears here, the gate has widened
    // into a lockout for every new user.
    await expect(page.getByTestId('mfa-replace-step-up')).toHaveCount(0);

    const secret = await readSetupKey(page);
    await activateWith(page, secret);
    expect(await readRecoveryCodes(page)).not.toHaveLength(0);

    await page.getByRole('button', { name: /I have saved them/ }).click();
    await expect(page.locator('body')).toContainText('Active', { timeout: 20_000 });
  });
});

test.describe('replacing an authenticator with the one you hold', () => {
  test('a wrong code is refused and no replacement secret is issued', async ({ page }) => {
    const who = await createMfaAccount('replace-wrong', { withFactor: true });
    await signInAs(page, who.email, who.password);
    await selectTenant(page, 'a');
    await page.goto(SECURITY_PAGE);
    await expect(page.locator('body')).toContainText('Active', { timeout: 20_000 });

    await submitReplacementCode(page, '000000');

    // Refused, and — the part that matters — no new secret on screen. A UI
    // that revealed the setup key before the challenge was satisfied would
    // hand a stolen session everything it needs.
    await expect(page.locator('#setupKey')).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator('body')).toContainText('not accepted');
  });

  test('the current code replaces it, and retires the old one', async ({ page }) => {
    const who = await createMfaAccount('replace-totp', { withFactor: true });
    await signInAs(page, who.email, who.password);
    await selectTenant(page, 'a');
    await page.goto(SECURITY_PAGE);

    await submitReplacementCode(page, generateTotp(who.totpSecret!));

    const replacement = await readSetupKey(page);
    // A genuinely new factor. Re-showing the old secret would make
    // "replacement" cosmetic and leave the old authenticator valid.
    expect(replacement).not.toBe(who.totpSecret);

    // Before migration 0030 this is where it ended: the pending factor could
    // not be promoted while the old one was active, and the page reported
    // "No enrolment is in progress".
    await activateWith(page, replacement);
    await readRecoveryCodes(page);
    await page.getByRole('button', { name: /I have saved them/ }).click();
    await expect(page.locator('body')).toContainText('Active', { timeout: 20_000 });

    // The retired authenticator must stop satisfying a step-up. This is the
    // assertion that distinguishes a replacement from adding a second device.
    await page.goto(SECURITY_PAGE);
    await submitReplacementCode(page, generateTotp(who.totpSecret!));
    await expect(page.locator('#setupKey')).toHaveCount(0, { timeout: 20_000 });
  });
});

test.describe.serial('replacing an authenticator you have lost', () => {
  let recoveryCodes: string[] = [];
  let credentials: { email: string; password: string };

  test('a recovery code satisfies the replacement step-up', async ({ page }) => {
    const who = await createMfaAccount('recovery');
    credentials = who;
    await signInAs(page, who.email, who.password);
    await selectTenant(page, 'a');
    await page.goto(SECURITY_PAGE);

    // Enrol through the UI, because recovery codes only exist in readable
    // form at activation — the seed cannot hand us one.
    await page.getByRole('button', { name: /^Enrol an authenticator$/ }).click();
    const first = await readSetupKey(page);
    await activateWith(page, first);
    recoveryCodes = await readRecoveryCodes(page);
    await page.getByRole('button', { name: /I have saved them/ }).click();

    await submitReplacementCode(page, recoveryCodes[0]!);

    const replacement = await readSetupKey(page);
    expect(replacement).not.toBe(first);
    await activateWith(page, replacement);

    // Replacement reissues the set. Keeping the old codes would leave a code
    // already spent once still standing against the new factor.
    expect(await readRecoveryCodes(page)).not.toEqual(recoveryCodes);
  });

  test('the spent recovery code cannot be used a second time', async ({ page }) => {
    await signInAs(page, credentials.email, credentials.password);
    await selectTenant(page, 'a');
    await page.goto(SECURITY_PAGE);

    await submitReplacementCode(page, recoveryCodes[0]!);

    // Single use is the whole property of a recovery code. If this ever
    // succeeded, one leaked code would be a standing credential.
    await expect(page.locator('#setupKey')).toHaveCount(0, { timeout: 20_000 });
  });
});

// Security transitions use private accounts so reruns exercise the same path.
test.describe('revocation and login quarantine', () => {
  test('wrong revocation proof keeps the authenticator active', async ({ page }) => {
    const who = await createMfaAccount('revoke-wrong', { withFactor: true });
    await signInAs(page, who.email, who.password);
    await page.goto(SECURITY_PAGE);
    await page.getByRole('button', { name: /^Revoke authenticator$/ }).click();
    await expect(page.getByTestId('mfa-revoke-step-up')).toBeVisible();
    await page.fill('#stepUpCode', 'not-a-recovery-code');
    await page.getByRole('button', { name: /^Confirm revocation$/ }).click();
    await expect(page.locator('body')).toContainText('not accepted');
    await page.reload();
    await expect(page.getByRole('button', { name: /^Replace authenticator$/ })).toBeVisible();
  });

  test('revocation spends proof, clears credentials, and requires enrollment again', async ({
    page,
  }) => {
    const who = await createMfaAccount('revoke');
    await signInAs(page, who.email, who.password);
    await page.goto(SECURITY_PAGE);
    await page.getByRole('button', { name: /^Enrol an authenticator$/ }).click();
    await activateWith(page, await readSetupKey(page));
    const codes = await readRecoveryCodes(page);
    await page.getByRole('button', { name: /I have saved them/ }).click();
    await page.getByRole('button', { name: /^Revoke authenticator$/ }).click();
    await page.fill('#stepUpCode', codes[0]!);
    await page.getByRole('button', { name: /^Confirm revocation$/ }).click();
    await expect(page.getByRole('status')).toContainText('Authenticator revoked');
    await expect(page.getByRole('button', { name: /^Enrol an authenticator$/ })).toBeVisible();
    await page.reload();
    await expect(page.locator('body')).toContainText('Not enrolled');
    await expect(page.getByRole('button', { name: /^Revoke authenticator$/ })).toHaveCount(0);
  });

  test('a quarantined founder enrolls, saves codes, verifies, and can then access the app', async ({
    page,
  }) => {
    const who = await createMfaAccount('quarantine', { role: 'founder' });
    await signInAs(page, who.email, who.password);
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/settings\/security\?enrol=required/);
    const protectedApi = () =>
      page.request.get('/api/bff/v1/engagements', { headers: { 'X-Tenant-Id': state.tenantA.id } });
    const before = await protectedApi();
    expect(before.status()).toBe(403);
    expect((await before.json()).error.code).toBe('mfa_enrolment_required');
    await page.getByRole('button', { name: /^Enrol an authenticator$/ }).click();
    await activateWith(page, await readSetupKey(page));
    const codes = await readRecoveryCodes(page);
    const enrolled = await protectedApi();
    expect(enrolled.status()).toBe(401);
    expect((await enrolled.json()).error.code).toBe('mfa_verification_required');
    await expect(page.getByRole('link', { name: 'Continue to sign-in verification' })).toHaveCount(
      0,
    );
    await page.getByRole('button', { name: /I have saved them/ }).click();
    await page.getByRole('link', { name: 'Continue to sign-in verification' }).click();
    await expect(page).toHaveURL(/\/verify/);
    await page.fill('#code', codes[0]!);
    await page.getByRole('button', { name: /^Verify$/ }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    expect((await protectedApi()).status()).toBe(200);
    // A second browser session with just the password is still quarantined.
    await page.context().clearCookies();
    await signInAs(page, who.email, who.password);
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/verify/);
    expect((await protectedApi()).status()).toBe(401);
  });
});

test('recovery replacement makes both verified sessions complete MFA again', async ({
  page,
  browser,
}) => {
  const who = await createMfaAccount('recovery-sessions', { role: 'founder' });
  await signInAs(page, who.email, who.password);
  await selectTenant(page, 'a');
  await page.goto(SECURITY_PAGE);
  await page.getByRole('button', { name: /^Enrol an authenticator$/ }).click();
  await activateWith(page, await readSetupKey(page));
  const codes = await readRecoveryCodes(page);
  await page.getByRole('button', { name: /I have saved them/ }).click();
  const verifyRecovery = async (target: Page, code: string) => {
    await target.goto('/verify');
    await target.fill('#code', code);
    await target.getByRole('button', { name: /^Verify$/ }).click();
    // The dev-mode server action can exceed the default 5s on a cold compile.
    await expect(target).toHaveURL(/\/dashboard/, { timeout: 20_000 });
  };
  const protectedApi = (target: Page) =>
    target.request.get('/api/bff/v1/engagements', { headers: { 'X-Tenant-Id': state.tenantA.id } });
  await verifyRecovery(page, codes[0]!);
  const secondContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const second = await secondContext.newPage();
    await signInAs(second, who.email, who.password);
    await selectTenant(second, 'a');
    await verifyRecovery(second, codes[1]!);
    expect((await protectedApi(page)).status()).toBe(200);
    expect((await protectedApi(second)).status()).toBe(200);
    await page.goto(SECURITY_PAGE);
    await page.getByRole('button', { name: /^Replace authenticator$/ }).click();
    await expect(page.getByTestId('mfa-replace-step-up')).toContainText(
      'activating the replacement ends all existing MFA verifications',
    );
    await page.fill('#stepUpCode', codes[2]!);
    await page.getByRole('button', { name: /^Confirm and replace$/ }).click();
    const replacement = await readSetupKey(page);
    const activationCode = await activateWith(page, replacement);
    const newCodes = await readRecoveryCodes(page);
    // Revocation occurs on activation, including the session doing recovery.
    for (const target of [page, second]) {
      const response = await protectedApi(target);
      expect(response.status()).toBe(401);
      expect((await response.json()).error.code).toBe('mfa_verification_required');
    }
    await page.getByRole('button', { name: /I have saved them/ }).click();
    await second.goto('/dashboard');
    await expect(second).toHaveURL(/\/verify/);
    // Activation already spent this TOTP counter. This journey verifies
    // renewed assurance, not replay refusal (covered separately). Wait for
    // a fresh code without printing either code if the assertion fails.
    await expect
      .poll(() => generateTotp(replacement) !== activationCode, { timeout: 35_000 })
      .toBe(true);
    await satisfyLoginMfaWithSecret(page, replacement);
    expect((await protectedApi(page)).status()).toBe(200);
    expect((await protectedApi(second)).status()).toBe(401);
    await verifyRecovery(second, newCodes[0]!);
    expect((await protectedApi(second)).status()).toBe(200);
  } finally {
    await secondContext.close();
  }
});
