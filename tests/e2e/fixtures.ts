import {
  designateOwnedFixtureFounder,
  assertLocalFounderFixtureTarget,
  wantsGlobalFounder,
} from '../../scripts/lib/owned-founder-fixture';
import {
  browserMfaPoolEnabled,
  mfaPoolFactorReadPath,
  verifyMfaPoolAccountRows,
  leaseBrowserMfaAccount,
  prepareBrowserMfaPool,
  type MfaPoolBinding,
  type MfaPoolIdentity,
  type MfaPoolAccount,
} from '../../scripts/lib/browser-mfa-pool';
import { dirname, join } from 'node:path';
import { withFreshMfaFixtureCounter } from './fixtures/login-mfa-counter';
import {
  acceptanceTarget,
  personaStatePath,
  assertPersonaTarget,
  tenantCookie,
  repoRoot,
} from './target';
import { localRoleBearer } from './local-writer';
import { insertLocalFixtureRow } from './local-db';
import { enrolTestMfa } from '../../scripts/lib/enrol-test-mfa';
import { readFileSync } from 'node:fs';
import { expect, type Page, type Response } from '@playwright/test';
import { encryptSecret, generateSecret, generateTotp } from '@axiom/mfa';
import { HARNESS_MFA_KEY, type PersonaKey, type PersonaState, personaByKey } from './personas';

export const state: PersonaState = JSON.parse(readFileSync(personaStatePath, 'utf8'));
assertPersonaTarget(state);

export const usesBrowserMfaPool = browserMfaPoolEnabled(acceptanceTarget, {
  requested: process.env.AXIOM_BROWSER_MFA_POOL,
  ci: process.env.CI,
  github: process.env.GITHUB_ACTIONS,
});
function poolBinding(): MfaPoolBinding {
  if (!usesBrowserMfaPool || !acceptanceTarget)
    throw new Error('Isolated MFA pool authority refused');
  return {
    deploymentId: acceptanceTarget.deploymentId,
    revision: acceptanceTarget.expectedRevision,
    tenantId: state.tenantA.id,
    bffUrl: acceptanceTarget.bffUrl,
    webUrl: acceptanceTarget.webUrl,
    marketingUrl: acceptanceTarget.marketingUrl,
    supabaseUrl: acceptanceTarget.supabaseUrl,
  };
}
const poolDirectory = join(dirname(personaStatePath), `fresh-mfa-${state.tenantA.id}`);
async function verifyPoolAccount(who: MfaPoolAccount): Promise<boolean> {
  const headers = { apikey: state.publishableKey, Authorization: `Bearer ${state.serviceKey}` };
  async function read(path: string) {
    const response = await fetch(`${state.supabaseUrl}/rest/v1/${path}`, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error('MFA pool account readback refused');
    return response.json() as Promise<unknown>;
  }
  const profile = await read(`users?id=eq.${who.id}&select=id,email,is_axiom_internal`);
  const memberships = await read(`tenant_users?user_id=eq.${who.id}&select=user_id,tenant_id,role`);
  const factors = await read(mfaPoolFactorReadPath(who.id));
  if (who.role === 'founder' && who.internal) {
    const result = await fetch(`${state.supabaseUrl}/rest/v1/rpc/is_live_platform_founder`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ p_user_id: who.id }),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (!result.ok || (await result.json()) !== true) return false;
  }
  return verifyMfaPoolAccountRows(who, poolBinding(), { profile, memberships, factors });
}
export async function prepareBrowserMfaAccounts(): Promise<void> {
  await prepareBrowserMfaPool({
    directory: poolDirectory,
    binding: poolBinding(),
    provision: async (identity: MfaPoolIdentity, index: number) => {
      let consumedCounter: number | undefined;
      const who = await provisionMfaAccount(
        identity.profileCase === 'long-account'
          ? 'long-organization-operator-layout-verification'
          : `pool-${index}`,
        { role: identity.role, isInternal: identity.internal, withFactor: true },
        {
          wait: false,
          activated: (counter) => {
            consumedCounter = counter;
          },
        },
      );
      if (!who.totpSecret || consumedCounter === undefined)
        throw new Error('MFA pool enrollment unconfirmed');
      const result = {
        ...who,
        totpSecret: who.totpSecret,
        consumedCounter,
        ...identity,
        profileCase: identity.profileCase ?? ('ordinary' as const),
      };
      if (!(await verifyPoolAccount(result)))
        throw new Error('MFA pool provision readback refused');
      return result;
    },
  });
}

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
  // Founder/analyst journeys already verify explicitly. Client journeys need
  // the same real attestation now; no tenant policy can waive these roles.
  if (['owner', 'approver'].includes(persona(key).role) && persona(key).totpEnrolled) {
    await selectTenant(page, persona(key).membership === 'b' ? 'b' : 'a');
    await satisfyLoginMfa(page, key);
  }
}

/** Password-only unless the caller explicitly supplies its enrolled login factor. */
export async function signInAs(
  page: Page,
  email: string,
  password: string,
  loginSecret?: string,
): Promise<void> {
  await page.goto('/login');
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 }),
    page.click('button[type="submit"]'),
  ]);
  if (loginSecret) await satisfyLoginMfaWithSecret(page, loginSecret);
}

/** Point the session at a seeded tenant. The cookie is a preference; membership still decides. */
export async function selectTenant(page: Page, which: 'a' | 'b'): Promise<void> {
  const tenant = which === 'a' ? state.tenantA : state.tenantB;
  await page.context().addCookies([tenantCookie(tenant.slug)]);
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

  // Plans and actions are not writable through the service credential (0099), so
  // these synthetic rows go through the bound fixture database path.
  await insertLocalFixtureRow(
    'remediation_plans',
    {
      id,
      tenant_id: state.tenantA.id,
      engagement_id: state.engagementA,
      library_version: state.libraryVersion,
      title,
      status: 'review',
    },
    { tenantId: state.tenantA.id, engagementId: state.engagementA },
  );
  await insertLocalFixtureRow(
    'remediation_actions',
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
      rollback_validated: true,
    },
    { tenantId: state.tenantA.id, engagementId: state.engagementA },
  );
  // 0157: approval needs a RECORDED dry run; the inline status alone is not one.
  // Record it through the sanctioned path, which also sets that status.
  await recordFixtureDryRun(actionId, { columns: ['email'] }, { restore: 'persona-snapshot' });

  return { id, title, actionId };
}

/** A successful dry run for a fixture action, recorded by `record_dry_run` (0060). */
export async function recordFixtureDryRun(
  actionId: string,
  parameters: unknown,
  rollbackDefinition: unknown,
): Promise<void> {
  const res = await fetch(`${state.supabaseUrl}/rest/v1/rpc/record_dry_run`, {
    method: 'POST',
    headers: {
      apikey: state.publishableKey,
      Authorization: `Bearer ${state.serviceKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      p_tenant_id: state.tenantA.id,
      p_action_id: actionId,
      p_status: 'succeeded',
      p_diff: { changes: [{ field: 'email', before: 'cleartext', after: 'masked' }] },
      p_refusal_reason: null,
      p_simulated_by: 'sudhaar',
      p_parameters: parameters,
      p_rollback_definition: rollbackDefinition,
      p_correlation_id: crypto.randomUUID(),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    dryRun?: { status?: string };
    error?: string;
  };
  if (!res.ok || body.dryRun?.status !== 'succeeded')
    throw new Error(`Fixture dry run not recorded: ${res.status} ${body.error ?? ''}`);
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
  const who = account(key);
  const secret = who.totpSecret;
  if (!secret) throw new Error(`${key} was seeded without a TOTP factor`);
  // Keep independent workers serialized, but do not wait another entire window
  // when the last successful verification's counter has already expired.
  await withFreshMfaFixtureCounter(join(dirname(personaStatePath), 'login-mfa-locks'), who.id, () =>
    satisfyLoginMfaWithSecret(page, secret),
  );
}

export async function satisfyLoginMfaWithSecret(page: Page, secret: string): Promise<void> {
  // The post-login server-action redirect can still be committing after the
  // URL changes. If it aborts this navigation, wait for it to settle and
  // explicitly navigate again; do not treat the abort as an MFA success.
  try {
    await page.goto('/verify', { waitUntil: 'domcontentloaded' });
  } catch (cause) {
    if (!(cause instanceof Error) || !cause.message.includes('net::ERR_ABORTED')) throw cause;
    await page.waitForLoadState('domcontentloaded');
    await page.goto('/verify', { waitUntil: 'domcontentloaded' });
  }
  await page
    .locator('#code')
    .waitFor({ state: 'visible', timeout: 15_000 })
    .catch(() => {
      throw new Error(`Login-MFA form did not appear at ${new URL(page.url()).pathname}`);
    });
  // A server-rendered input is visible before its React handler is attached.
  // Wait for the client component to hydrate before sending a one-time code.
  await page.waitForFunction(
    () => {
      const input = document.querySelector('#code');
      return input && Object.keys(input).some((key) => key.startsWith('__reactProps$'));
    },
    undefined,
    { timeout: 15_000 },
  );
  // Record status only, never request bodies, codes, cookies or response payloads.
  const statuses: string[] = [];
  let verificationConfirmed = false;
  const record = (response: Response) => {
    const path = new URL(response.url()).pathname;
    if (
      path.endsWith('/verify') &&
      path.startsWith('/api/bff/v1/mfa/challenge') &&
      response.status() === 200
    )
      verificationConfirmed = true;
    if (path.startsWith('/api/bff/v1/mfa/challenge'))
      statuses.push(`${path.endsWith('/verify') ? 'verify' : 'issue'}:${response.status()}`);
  };
  page.on('response', record);
  try {
    // Activation consumes the same factor counter. Wait for a genuinely new
    // code after a refusal; never bypass the replay defence.
    for (let attempt = 0; attempt < 2; attempt++) {
      statuses.push(`attempt:${attempt + 1}`);
      const verifyButton = page.getByRole('button', { name: /^Verify$/ });
      // Next can render the input before React hydrates it. A fill made in
      // that gap leaves the controlled button disabled; explicitly wait for
      // the state change and refill after hydration if necessary.
      for (let fillAttempt = 0; fillAttempt < 3; fillAttempt++) {
        await page.fill('#code', generateTotp(secret));
        try {
          await expect(verifyButton).toBeEnabled({ timeout: 5_000 });
          break;
        } catch (cause) {
          if (fillAttempt === 2) throw cause;
        }
      }
      await verifyButton.click({ timeout: 15_000 });
      try {
        await page.waitForURL((url) => !url.pathname.startsWith('/verify'), { timeout: 15_000 });
        if (!verificationConfirmed)
          throw new Error('MFA navigation lacked a successful real verification response');
        return;
      } catch {
        if (attempt === 1)
          throw new Error(`Could not satisfy the login-MFA gate (${statuses.join(', ')})`);
        await page.waitForTimeout(31_000);
      }
    }
  } finally {
    page.off('response', record);
  }
}

/** Each verifying journey owns its counter; concurrent tests cannot spend its code. */
export async function signInFreshAnalyst(page: Page, label: string): Promise<void> {
  const who = await createMfaAccount(label, {
    role: 'axiom_analyst',
    withFactor: true,
    isInternal: true,
  });
  if (!who.totpSecret) throw new Error('Analyst journey requires an enrolled factor');
  await signInAs(page, who.email, who.password);
  await selectTenant(page, 'a');
  await satisfyLoginMfaWithSecret(page, who.totpSecret);
}

/** Explicit private owner identity: ordinary journeys do not share a one-use factor. */
export async function signInFreshOwner(page: Page, label: string) {
  const who = await createMfaAccount(label, { role: 'owner', withFactor: true });
  if (!who.totpSecret) throw new Error('Owner journey needs its own enrolled factor');
  await selectTenant(page, 'a');
  await signInAs(page, who.email, who.password, who.totpSecret);
  return who;
}

/** A fresh internal founder: the only role that reaches the Agent Workbench. */
export async function signInFreshFounder(page: Page, label: string): Promise<void> {
  const who = await createMfaAccount(label, {
    role: 'founder',
    withFactor: true,
    isInternal: true,
  });
  if (!who.totpSecret) throw new Error('Founder journey requires an enrolled factor');
  await signInAs(page, who.email, who.password);
  await selectTenant(page, 'a');
  await satisfyLoginMfaWithSecret(page, who.totpSecret);
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
 * Tenant A keeps an empty optional MFA policy. The five mandatory human roles
 * still require enrolment and session verification, independently of that policy.
 *
 * `withFactor` seeds an active TOTP factor encrypted under the harness ring
 * key, exactly as `scripts/seed-personas.ts` does, for journeys that start
 * from a user who already holds an authenticator.
 */
export async function createMfaAccount(
  label: string,
  opts: {
    withFactor?: boolean;
    isInternal?: boolean;
    globalFounder?: boolean;
    role?: 'approver' | 'founder' | 'owner' | 'admin' | 'axiom_analyst' | 'viewer';
  } = {},
): Promise<{ id: string; email: string; password: string; totpSecret?: string }> {
  wantsGlobalFounder(opts); // Validate contradictory authority intent before provisioning or leasing.
  if (usesBrowserMfaPool && opts.withFactor && opts.globalFounder !== false) {
    return leaseBrowserMfaAccount({
      directory: poolDirectory,
      binding: poolBinding(),
      identity: {
        role: opts.role ?? 'approver',
        internal: opts.isInternal ?? false,
        profileCase:
          label === 'long-organization-operator-layout-verification' ? 'long-account' : 'ordinary',
      },
      verify: verifyPoolAccount,
    });
  }
  return provisionMfaAccount(label, opts);
}

async function provisionMfaAccount(
  label: string,
  opts: {
    withFactor?: boolean;
    isInternal?: boolean;
    globalFounder?: boolean;
    role?: 'approver' | 'founder' | 'owner' | 'admin' | 'axiom_analyst' | 'viewer';
  } = {},
  readiness?: { wait: boolean; activated: (counter: number) => void },
): Promise<{ id: string; email: string; password: string; totpSecret?: string }> {
  if (wantsGlobalFounder(opts)) assertLocalFounderFixtureTarget(acceptanceTarget?.topology);
  const suffix = crypto.randomUUID().slice(0, 8);
  const email = `journey-${label}-${suffix}@example.invalid`;
  const password = `Pw-${crypto.randomUUID()}`;

  const admin = async (path: string, body: unknown, what: string, expected = 200) => {
    const res = await fetch(`${state.supabaseUrl}${path}`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
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
  await admin(
    '/rest/v1/users',
    { id, email, is_axiom_internal: opts.isInternal ?? false },
    'journey profile',
    201,
  );
  await admin(
    '/rest/v1/tenant_users',
    {
      tenant_id: state.tenantA.id,
      user_id: id,
      role: opts.role ?? 'approver',
      approval_scopes: [],
    },
    'journey membership',
    201,
  );

  if (wantsGlobalFounder(opts)) {
    assertLocalFounderFixtureTarget(acceptanceTarget?.topology);
    await designateOwnedFixtureFounder({
      root: repoRoot,
      supabaseUrl: state.supabaseUrl,
      serviceKey: state.serviceKey,
      userId: id,
      email,
      designate: async (request) => {
        const response = await admin(
          '/rest/v1/rpc/designate_platform_founder',
          request,
          'journey founder designation',
          204,
        );
        if (response.status !== 204) throw new Error('Founder designation unconfirmed');
      },
    });
  }

  let totpSecret: string | undefined;
  if (opts.withFactor && acceptanceTarget) {
    totpSecret = await enrolTestMfa({
      bffUrl: acceptanceTarget.bffUrl,
      supabaseUrl: state.supabaseUrl,
      anonKey: state.anonKey,
      email,
      password,
      tenantId: state.tenantA.id,
      waitForNextCode: readiness?.wait,
      onActivated: readiness?.activated,
    });
  } else if (opts.withFactor) {
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

/**
 * Register and activate a workload identity through the reviewed lifecycle RPC
 * (0048 revoked direct table writes). Each call uses its own trust domain so
 * the one-ID-per-agent convention never collides across tests.
 */
export async function registerWorkload(agent: 'drishti' | 'karya', label: string): Promise<string> {
  const id = crypto.randomUUID();
  const spiffe = `spiffe://w-${label}.axiom.test/agent/${agent}`;
  let version = 0;
  for (const status of ['disabled', 'active']) {
    const res = await fetch(`${state.supabaseUrl}/rest/v1/rpc/manage_workload_identity`, {
      method: 'POST',
      headers: {
        apikey: state.publishableKey,
        Authorization: `Bearer ${localRoleBearer('human_action_writer', state)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        p_tenant_id: state.tenantA.id,
        p_actor_id: state.accounts.owner.id,
        p_correlation_id: crypto.randomUUID(),
        p_workload_id: id,
        p_expected_version: version,
        p_agent: agent,
        p_spiffe_id: spiffe,
        p_status: status,
      }),
    });
    const body = (await res.json()) as { version?: number; error?: string };
    if (!res.ok || body.error || typeof body.version !== 'number')
      throw new Error(`Workload registration failed: ${res.status} ${body.error ?? ''}`);
    version = body.version;
  }
  return id;
}

/** Approval/replacement must spend a different counter from successful login MFA. */
export async function freshTotpCode(page: Page, secret: string): Promise<string> {
  const counter = Math.floor(Date.now() / 30_000);
  await page.waitForTimeout((counter + 1) * 30_000 - Date.now() + 100);
  return generateTotp(secret);
}
