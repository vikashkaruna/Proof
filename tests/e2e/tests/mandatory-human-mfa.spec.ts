import { test, expect } from '@playwright/test';
import {
  createMfaAccount,
  selectTenant,
  signInAs,
  satisfyLoginMfaWithSecret,
  state,
} from '../fixtures';

// Restated deliberately: deriving this matrix from the policy under test would
// allow removal of a privileged role to silently remove its acceptance case.
const MANDATORY_ROLES = ['founder', 'axiom_analyst', 'owner', 'admin', 'approver'] as const;

for (const role of MANDATORY_ROLES) {
  test(`${role}: an empty optional tenant policy cannot waive enrolment`, async ({ page }) => {
    const who = await createMfaAccount(`mandatory-unenrolled-${role}`, {
      role,
      isInternal: role === 'founder' || role === 'axiom_analyst',
    });
    await selectTenant(page, 'a');
    await signInAs(page, who.email, who.password);
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/settings\/security\?enrol=required/);
    const response = await page.request.get('/api/bff/v1/engagements', {
      headers: { 'X-Tenant-Id': state.tenantA.id },
    });
    expect(response.status()).toBe(403);
    expect((await response.json()).error.code).toBe('mfa_enrolment_required');
  });

  test(`${role}: only a real session attestation unlocks protected reads`, async ({ page }) => {
    test.setTimeout(120_000);
    const who = await createMfaAccount(`mandatory-enrolled-${role}`, {
      role,
      withFactor: true,
      isInternal: role === 'founder' || role === 'axiom_analyst',
    });
    if (!who.totpSecret) throw new Error('The enrolled journey needs its own factor');
    await selectTenant(page, 'a');
    await signInAs(page, who.email, who.password);
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/verify/);
    const read = () =>
      page.request.get('/api/bff/v1/engagements', {
        headers: { 'X-Tenant-Id': state.tenantA.id },
      });
    const before = await read();
    expect(before.status()).toBe(401);
    expect((await before.json()).error.code).toBe('mfa_verification_required');
    await satisfyLoginMfaWithSecret(page, who.totpSecret);
    await expect(page).toHaveURL(role === 'founder' ? /\/workbench/ : /\/portal/);
    expect((await read()).status()).toBe(200);

    // The stored factor is not an attestation for another password session.
    await page.context().clearCookies();
    await selectTenant(page, 'a');
    await signInAs(page, who.email, who.password);
    const freshSession = await read();
    expect(freshSession.status()).toBe(401);
    expect((await freshSession.json()).error.code).toBe('mfa_verification_required');
  });
}
