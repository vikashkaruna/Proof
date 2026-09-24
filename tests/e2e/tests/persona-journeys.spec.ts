import { test, expect, type Page } from '@playwright/test';
import { PERSONAS, type PersonaKey } from '../personas';
import { account, persona, selectTenant, signIn, state } from '../fixtures';

/**
 * W1 — browser persona journeys, against real authentication.
 *
 * Doc 11's exit criterion for W1 is specific: "a `viewer` in tenant A cannot
 * see tenant B, cannot reach an approve button, and cannot call the approve
 * endpoint. Proven by test, not inspection."
 *
 * The first two clauses are what a browser can prove and an API suite cannot,
 * and they are what this file covers. The third is enforced by the BFF and is
 * covered against real GoTrue in `scripts/verify-strict-parity.ts`, which is
 * the right place for it — a rendered page cannot demonstrate that the server
 * refuses a request the page never offers to make.
 *
 * Every account here is a real GoTrue user signing in with a real password.
 * The former harness ran under the e2e bypass, which resolves every caller to
 * one founder identity, so none of these assertions could have meant anything
 * under it.
 */

/** Personas that reach the app: tenant A has login MFA switched off. */
const REACHES_APP = PERSONAS.filter((p) => !p.mfaQuarantined);
/** Personas sent to enrolment instead: founder always, plus tenant B's owner. */
const QUARANTINED = PERSONAS.filter((p) => p.mfaQuarantined);

async function openPlanA(page: Page, key: PersonaKey) {
  await signIn(page, key);
  await selectTenant(page, 'a');
  await page.goto(`/plans/${state.planA.id}`);
}

test.describe('signing in', () => {
  test('an unauthenticated visitor cannot reach a plan', async ({ page }) => {
    await page.goto(`/plans/${state.planA.id}`);
    await page.waitForURL(/\/login/, { timeout: 30_000 });
    expect(page.url()).toContain('/login');
  });

  test('a wrong password is refused', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[name="email"]', account('viewer').email);
    await page.fill('input[name="password"]', 'not-the-password');
    await page.click('button[type="submit"]');
    // Still on login. The former login action minted a founder identity with
    // no credentials whenever auth failed (SEC-2/SEC-13); this asserts it
    // stays failed.
    await page.waitForURL(/\/login/, { timeout: 30_000 });
    await expect(page.locator('body')).not.toContainText(state.planA.title);
  });
});

test.describe('the approve control is role-gated', () => {
  for (const p of REACHES_APP) {
    test(`${p.key} (${p.role}) ${p.canApprove ? 'is offered' : 'is not offered'} approval`, async ({
      page,
    }) => {
      await openPlanA(page, p.key);

      // The plan itself must render, or "no approve button" would be true of
      // an error page too and the assertion would prove nothing.
      await expect(page.locator('body')).toContainText(state.planA.title, { timeout: 20_000 });

      const approve = page.getByRole('button', { name: /^Approve \d+ action/ });
      const reject = page.getByRole('button', { name: /Reject plan/ });

      if (p.canApprove) {
        await expect(approve).toBeVisible();
      } else {
        await expect(approve).toHaveCount(0);
      }

      // Refusing is a separate authority from granting, and deliberately not
      // narrowed by `approval_scopes`.
      if (p.canReject) {
        await expect(reject).toBeVisible();
      } else {
        await expect(reject).toHaveCount(0);
        // Only a persona who can do neither is told they are read-only.
        await expect(page.locator('body')).toContainText('You have read access to this plan');
      }
    });
  }

  test('a scoped approver may refuse a plan it may not approve', async ({ page }) => {
    // The sharpest single case in this file: same role, same tenant, same
    // plan as `approver` — the only difference is a non-empty
    // `approval_scopes` that does not cover this action's class. Approval
    // disappears; refusal does not, because saying no is not authority over
    // a client estate.
    await openPlanA(page, 'approverScoped');
    await expect(page.locator('body')).toContainText(state.planA.title, { timeout: 20_000 });
    await expect(page.getByRole('button', { name: /^Approve \d+ action/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Reject plan/ })).toBeVisible();
  });

  test('the scoped approver differs from the unscoped one only by approval_scopes', async () => {
    // Guards the meaning of the pair above: if someone changes the fixture so
    // these two differ by role, the journeys would still pass while testing
    // something else entirely. Doc 11 recorded approval_scopes as "defined and
    // never read", and this pair is what makes that falsifiable.
    expect(persona('approverScoped').role).toBe(persona('approver').role);
    expect(persona('approver').approvalScopes).toEqual([]);
    expect(persona('approverScoped').approvalScopes.length).toBeGreaterThan(0);
  });
});

test.describe('tenant isolation', () => {
  for (const p of REACHES_APP) {
    test(`${p.key} cannot read tenant B's plan`, async ({ page }) => {
      await signIn(page, p.key);
      await selectTenant(page, 'a');
      await page.goto(`/plans/${state.planB.id}`);
      // Whatever the surface does — refuse, redirect, render "not found" — the
      // one thing it must never do is show the other tenant's content.
      await expect(page.locator('body')).not.toContainText(state.planB.title);
    });
  }

  test('naming another tenant in the cookie does not grant it', async ({ page }) => {
    // The cookie is a preference, not an authorisation. Pages used to query
    // whatever slug it carried.
    await signIn(page, 'viewer');
    await selectTenant(page, 'b');
    await page.goto(`/plans/${state.planB.id}`);
    await expect(page.locator('body')).not.toContainText(state.planB.title);
  });
});

test.describe('login MFA quarantine', () => {
  for (const p of QUARANTINED) {
    test(`${p.key} (${p.role}) is sent to enrolment, not the app`, async ({ page }) => {
      await signIn(page, p.key);
      await selectTenant(page, p.membership === 'b' ? 'b' : 'a');
      await page.goto(`/plans/${state.planA.id}`);
      // No active factor, so the gate holds them at enrolment. Reaching the
      // plan would mean the login-MFA gate is not running.
      await page.waitForURL(/\/(settings\/security|verify)/, { timeout: 30_000 });
      await expect(page.locator('body')).not.toContainText(state.planA.title);
    });
  }

  test('the founder is quarantined by role even where the tenant asks for nobody', async ({
    page,
  }) => {
    // Tenant A sets `mfa_required_roles = '{}'`. A tenant cannot exempt the
    // founder, because that authority is not a tenant's to waive.
    expect(persona('founder').mfaQuarantined).toBe(true);
    await signIn(page, 'founder');
    await selectTenant(page, 'a');
    await page.goto('/dashboard');
    await page.waitForURL(/\/(settings\/security|verify)/, { timeout: 30_000 });
  });
});

test.describe('surface gating in the navigation', () => {
  for (const p of REACHES_APP) {
    test(`${p.key} sees ${p.partnerPortal ? 'the' : 'no'} partner portal link`, async ({
      page,
    }) => {
      await signIn(page, p.key);
      await selectTenant(page, 'a');
      await page.goto('/dashboard');
      const partnerLink = page.locator('a[href="/partner"]');
      if (p.partnerPortal) {
        await expect(partnerLink.first()).toBeVisible({ timeout: 20_000 });
      } else {
        await expect(partnerLink).toHaveCount(0);
      }
    });
  }
});
