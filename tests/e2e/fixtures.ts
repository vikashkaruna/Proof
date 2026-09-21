import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { encryptSecret, generateSecret, generateTotp } from '@axiom/mfa';
import { HARNESS_MFA_KEY, type PersonaKey, type PersonaState, personaByKey } from './personas';

const repoRoot = path.resolve(__dirname, '..', '..');

export const state: PersonaState = JSON.parse(
  readFileSync(path.join(repoRoot, '.axiom-runtime/personas/state.json'), 'utf8'),
);

export const account = (key: PersonaKey) => state.accounts[key];
export const persona = personaByKey;

/**
 * Sign in the way a person does: the real login form, a real password, a real
 * GoTrue session cookie. No injected token and no bypass — if this stops
 * working, the journeys that depend on it should fail rather than silently
 * fall back to some other identity.
 */
export async function signIn(page: Page, key: PersonaKey): Promise<void> {
  const who = account(key);
  await signInAs(page, who.email, who.password);
}

/** The same real login, for an account a journey provisioned for itself. */
export async function signInAs(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 }),
    page.click('button[type="submit"]'),
  ]);
}

/** Point the session at a seeded tenant. The cookie is a preference; membership still decides. */
export async function selectTenant(page: Page, which: 'a' | 'b'): Promise<void> {
  const tenant = which === 'a' ? state.tenantA : state.tenantB;
  await page.context().addCookies([
    {
      name: 'axiom_active_tenant',
      value: tenant.slug,
      domain: 'localhost',
      path: '/',
    },
  ]);
}

/**
 * Create a fresh plan with one approvable action in tenant A.
 *
 * Approving is a state transition: once an action is approved it stops being
 * eligible, so two journeys sharing one seeded action means the second finds
 * nothing to approve and fails for a reason that has nothing to do with what
 * it was testing. Each approval journey takes its own plan.
 */
export async function createApprovablePlan(label: string): Promise<{
  id: string;
  title: string;
  actionId: string;
}> {
  const id = crypto.randomUUID();
  const actionId = crypto.randomUUID();
  const title = `${label} ${id.slice(0, 8)}`;

  const post = async (path: string, body: unknown, what: string) => {
    const res = await fetch(`${state.supabaseUrl}${path}`, {
      method: 'POST',
      headers: {
        apikey: state.publishableKey,
        Authorization: `Bearer ${state.serviceKey}`,
        'content-type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(body),
    });
    if (res.status !== 201) {
      throw new Error(`${what}: ${res.status} — ${(await res.text()).slice(0, 300)}`);
    }
  };

  await post(
    '/rest/v1/remediation_plans',
    {
      id,
      tenant_id: state.tenantA.id,
      engagement_id: state.engagementA,
      library_version: state.libraryVersion,
      title,
      status: 'review',
    },
    'plan fixture',
  );
  await post(
    '/rest/v1/remediation_actions',
    {
      id: actionId,
      tenant_id: state.tenantA.id,
      plan_id: id,
      sequence: 1,
      action_type: 'data.mask',
      description: 'Mask a column',
      risk_score: 10,
      rollback_definition: { restore: 'persona-snapshot' },
      parameters: { columns: ['email'] },
      closes_finding_ids: [],
      dry_run_status: 'dry_run_complete',
      rollback_validated: true,
      dry_run_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      dry_run_result: { recordsAffected: 12 },
    },
    'action fixture',
  );

  return { id, title, actionId };
}

/**
 * Satisfy the login-MFA gate for a persona `ALWAYS_MFA_REQUIRED` holds at
 * `/verify`, leaving a live session attestation behind.
 *
 * This is the step that needed a running BFF: the code goes to
 * `/api/bff/v1/mfa/challenge` and its verify endpoint, which decrypt the
 * seeded secret under the harness ring key.
 */
export async function satisfyLoginMfa(page: Page, key: PersonaKey): Promise<void> {
  const secret = account(key).totpSecret;
  if (!secret) throw new Error(`${key} was seeded without a TOTP factor`);
  await page.goto('/verify');

  // `last_used_counter` replay defence is per FACTOR, so two journeys using
  // one authenticator inside the same 30-second step have the second refused
  // — correctly. Waiting for the next code is what a person does, and it is
  // what keeps this helper honest instead of disabling the defence for tests.
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.fill('#code', generateTotp(secret));
    await page.getByRole('button', { name: /^Verify$/ }).click();
    try {
      await page.waitForURL((url) => !url.pathname.startsWith('/verify'), { timeout: 15_000 });
      return;
    } catch {
      if (attempt === 1) throw new Error(`${key} could not satisfy the login-MFA gate`);
      // Into the next TOTP step, then one more try with a genuinely new code.
      await page.waitForTimeout(31_000);
    }
  }
}

export const planUrl = (id: string) => `/plans/${id}`;

/**
 * A fresh approver in tenant A, provisioned for one journey.
 *
 * The MFA journeys need this for the same reason approval journeys need
 * `createApprovablePlan`: they are state transitions on the account itself. A
 * first enrolment happens once, a recovery code is shown once and spends
 * once, and a replaced secret is not the secret the seed recorded. A journey
 * written against a seeded persona passes on a clean database and fails on
 * every rerun — including, silently and permanently, on a CI retry.
 *
 * Tenant A keeps `mfa_required_roles = '{}'`, so an account with no factor
 * signs in and reaches the app instead of landing on the quarantine page.
 *
 * `withFactor` seeds an active TOTP factor encrypted under the harness ring
 * key, exactly as `scripts/seed-personas.ts` does, for journeys that start
 * from a user who already holds an authenticator.
 */
export async function createMfaAccount(
  label: string,
  opts: { withFactor?: boolean } = {},
): Promise<{ id: string; email: string; password: string; totpSecret?: string }> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const email = `journey-${label}-${suffix}@example.invalid`;
  const password = `Pw-${crypto.randomUUID()}`;

  const admin = async (path: string, body: unknown, what: string, expected = 200) => {
    const res = await fetch(`${state.supabaseUrl}${path}`, {
      method: 'POST',
      headers: {
        apikey: state.publishableKey,
        Authorization: `Bearer ${state.serviceKey}`,
        'content-type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(body),
    });
    if (res.status !== expected) {
      throw new Error(`${what}: ${res.status} — ${(await res.text()).slice(0, 300)}`);
    }
    return res;
  };

  const created = await admin(
    '/auth/v1/admin/users',
    { email, password, email_confirm: true },
    'journey account',
  );
  const { id } = (await created.json()) as { id: string };

  // The application profile is a separate row; without it the tenant resolver
  // has an authenticated user with nothing to resolve.
  await admin('/rest/v1/users', { id, email, is_axiom_internal: false }, 'journey profile', 201);
  await admin(
    '/rest/v1/tenant_users',
    { tenant_id: state.tenantA.id, user_id: id, role: 'approver', approval_scopes: [] },
    'journey membership',
    201,
  );

  let totpSecret: string | undefined;
  if (opts.withFactor) {
    totpSecret = generateSecret(20);
    await admin(
      '/rest/v1/user_mfa_factors',
      {
        user_id: id,
        factor_type: 'totp',
        status: 'active',
        label: `${label} authenticator`,
        secret_encrypted: encryptSecret(totpSecret, HARNESS_MFA_KEY),
        activated_at: new Date().toISOString(),
      },
      'journey factor',
      201,
    );
  }

  return { id, email, password, ...(totpSecret ? { totpSecret } : {}) };
}
