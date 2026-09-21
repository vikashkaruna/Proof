import { test, expect, type Page } from '@playwright/test';
import { generateTotp } from '@axiom/mfa';
import { createMfaAccount, selectTenant, signInAs } from '../fixtures';

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
async function activateWith(page: Page, secret: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.fill('#activationCode', generateTotp(secret));
    await page.getByRole('button', { name: /^Activate$/ }).click();
    try {
      await expect(page.getByTestId('recovery-codes')).toBeVisible({ timeout: 15_000 });
      return;
    } catch {
      if (attempt === 1) throw new Error('activation was refused twice');
      await page.waitForTimeout(31_000);
    }
  }
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
