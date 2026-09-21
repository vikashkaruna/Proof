import {
  loadAcceptanceTarget,
  acceptanceStatePath,
  verifyAcceptanceTarget,
} from './lib/acceptance-target.js';
import { enrolTestMfa } from './lib/enrol-test-mfa.js';
/**
 * Seed the browser persona journeys against the real parity stack.
 *
 * Every account here is a real GoTrue user with a real password, because the
 * point of these journeys is the part the API suites cannot reach: what a
 * signed-in human actually sees. The existing Playwright harness ran under
 * `AXIOM_AUTH_MODE=e2e-bypass`, which resolves every caller to one founder
 * identity — so a "viewer journey" written on it would have been a founder
 * wearing a viewer's name, and would have passed no matter what the render
 * gating did.
 *
 * Writes credentials to `.axiom-runtime/personas/state.json`, which is
 * git-ignored and mode 0600. Nothing here is printed.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { encryptSecret, generateSecret } from '@axiom/mfa';
import {
  HARNESS_MFA_KEY,
  PERSONAS,
  type PersonaKey,
  type PersonaState,
} from '../tests/e2e/personas.js';

async function main() {
  const target = loadAcceptanceTarget();
  if (target) await verifyAcceptanceTarget(target);
  const stateDir = process.env.AXIOM_PARITY_STATE_DIR ?? resolve('.axiom-runtime/parity');
  const status = (
    target
      ? {
          API_URL: target.supabaseUrl,
          ANON_KEY: target.anonKey,
          PUBLISHABLE_KEY: target.publishableKey,
          SERVICE_ROLE_KEY: target.serviceKey,
        }
      : JSON.parse(await readFile(`${stateDir}/status.json`, 'utf8'))
  ) as Record<string, string>;
  const origin = new URL(status.API_URL!).origin;
  const run = randomUUID().slice(0, 8);

  async function api(
    path: string,
    method = 'GET',
    body?: unknown,
    token = status.SERVICE_ROLE_KEY!,
  ) {
    return fetch(`${origin}${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        apikey: status.PUBLISHABLE_KEY!,
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        Prefer: 'return=representation',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /**
   * Assert a status and surface the server's own message when it differs.
   * A bare `201 !== 400` says nothing about which column the fixture got
   * wrong, and this fixture touches a lot of columns.
   */
  async function expectStatus(res: Response, status: number, label: string) {
    if (res.status === status) return res;
    const body = target ? 'Server details suppressed for deployed credentials.' : await res.text();
    throw new Error(`${label}: expected ${status}, got ${res.status} — ${body.slice(0, 400)}`);
  }

  async function createAccount(emailPrefix: string, internal: boolean) {
    const email = `${emailPrefix}-${run}@example.invalid`;
    const password = randomBytes(24).toString('base64url');
    const created = await api('/auth/v1/admin/users', 'POST', {
      email,
      password,
      email_confirm: true,
    });
    await expectStatus(created, 200, `Auth admin create for ${emailPrefix}`);
    const { id } = (await created.json()) as { id: string };
    // The application profile is a separate row; without it the tenant
    // resolver has an authenticated user with nothing to resolve.
    const mirrored = await api('/rest/v1/users', 'POST', {
      id,
      email,
      is_axiom_internal: internal,
    });
    await expectStatus(mirrored, 201, `Profile provisioning for ${emailPrefix}`);
    // Prove the password works here rather than discovering it in a browser,
    // where the failure would look like a broken login page.
    const login = await api(
      '/auth/v1/token?grant_type=password',
      'POST',
      { email, password },
      status.ANON_KEY!,
    );
    await expectStatus(login, 200, `Password sign-in for ${emailPrefix}`);
    return { id, email, password };
  }

  const tenantA = { id: randomUUID(), slug: `persona-a-${run}`, name: `Persona Tenant A ${run}` };
  const tenantB = { id: randomUUID(), slug: `persona-b-${run}`, name: `Persona Tenant B ${run}` };
  // Two tenants with DIFFERENT MFA policies, on purpose.
  //
  // Tenant A turns login MFA off (`mfa_required_roles = '{}'`) so the
  // authorisation journeys isolate one variable: what a role may see and do.
  // With the column's default of {owner, approver} every interesting persona
  // would be redirected to enrolment before reaching a single page, and the
  // journeys would prove the MFA gate over and over while proving nothing
  // about RBAC.
  //
  // Tenant B keeps the default, so the quarantine itself is exercised as its
  // own journey. Both are real, supported configurations.
  await expectStatus(
    await api('/rest/v1/tenants', 'POST', [
      { ...tenantA, tier: 'growth', mfa_required_roles: [] },
      // Stated rather than inherited: PostgREST needs matching key sets, and
      // a journey that depends on a column default breaks quietly the day
      // that default changes.
      { ...tenantB, tier: 'growth', mfa_required_roles: ['owner', 'approver'] },
    ]),
    201,
    'Tenant creation',
  );

  const accounts = {} as PersonaState['accounts'];
  const memberships: Record<string, unknown>[] = [];
  const factors: Record<string, unknown>[] = [];
  for (const persona of PERSONAS) {
    const account = await createAccount(persona.emailPrefix, persona.axiomInternal);

    // Approving always needs a fresh step-up, whatever the tenant's login
    // policy is, so an approver with no factor cannot complete an approval in
    // a browser at all. The secret is written encrypted under the same ring
    // key the harness starts the BFF with, so the two agree by construction
    // rather than by both happening to read the same env var correctly.
    let totpSecret: string | undefined;
    if (persona.totpEnrolled && !target) {
      totpSecret = generateSecret(20);
      factors.push({
        user_id: account.id,
        factor_type: 'totp',
        status: 'active',
        label: `${persona.key} authenticator`,
        secret_encrypted: encryptSecret(totpSecret, HARNESS_MFA_KEY),
        activated_at: new Date().toISOString(),
      });
    }
    accounts[persona.key as PersonaKey] = { ...account, ...(totpSecret ? { totpSecret } : {}) };
    const row = (tenantId: string) => ({
      tenant_id: tenantId,
      user_id: account.id,
      role: persona.role,
      // Always present: PostgREST refuses a bulk insert whose objects do not
      // share a key set, and the column is `not null default '{}'`.
      approval_scopes: persona.approvalScopes,
    });
    if (persona.membership === 'a' || persona.membership === 'both')
      memberships.push(row(tenantA.id));
    if (persona.membership === 'b' || persona.membership === 'both')
      memberships.push(row(tenantB.id));
  }
  await expectStatus(
    await api('/rest/v1/tenant_users', 'POST', memberships),
    201,
    'Tenant membership',
  );

  if (factors.length > 0) {
    await expectStatus(
      await api('/rest/v1/user_mfa_factors', 'POST', factors),
      201,
      'TOTP factor enrolment',
    );
  }

  if (target)
    for (const persona of PERSONAS.filter((p) => p.totpEnrolled)) {
      const account = accounts[persona.key];
      account.totpSecret = await enrolTestMfa({
        bffUrl: target.bffUrl,
        supabaseUrl: origin,
        anonKey: status.ANON_KEY!,
        email: account.email,
        password: account.password,
        tenantId: persona.membership === 'b' ? tenantB.id : tenantA.id,
        waitForNextCode: false,
      });
    }
  if (target) await new Promise((resolve) => setTimeout(resolve, 30_500 - (Date.now() % 30_000)));
  const library = `persona-${run}`;
  await expectStatus(
    await api('/rest/v1/control_libraries', 'POST', {
      version: library,
      published_at: new Date().toISOString(),
      published_by: 'persona-fixture',
      change_log: 'Persona journey fixture only; not an assessment baseline',
      control_count: 0,
      is_current: false,
    }),
    201,
    'Control library fixture',
  );

  const engagementA = randomUUID();
  const engagementB = randomUUID();
  await expectStatus(
    await api('/rest/v1/engagements', 'POST', [
      { id: engagementA, tenant_id: tenantA.id, library_version: library, title: 'Persona A' },
      { id: engagementB, tenant_id: tenantB.id, library_version: library, title: 'Persona B' },
    ]),
    201,
    'Engagement fixture',
  );

  // A plan in each tenant. The one in B exists so "cannot see tenant B" is a
  // claim about something that is actually there — a page that renders empty
  // because the fixture is empty proves nothing about isolation.
  const planA = { id: randomUUID(), title: `Persona plan A ${run}` };
  const planB = { id: randomUUID(), title: `Persona plan B ${run}` };
  await expectStatus(
    await api('/rest/v1/remediation_plans', 'POST', [
      {
        id: planA.id,
        tenant_id: tenantA.id,
        engagement_id: engagementA,
        library_version: library,
        title: planA.title,
        status: 'review',
      },
      {
        id: planB.id,
        tenant_id: tenantB.id,
        engagement_id: engagementB,
        library_version: library,
        title: planB.title,
        status: 'review',
      },
    ]),
    201,
    'Plan fixture',
  );

  const actionId = randomUUID();
  await expectStatus(
    await api('/rest/v1/remediation_actions', 'POST', {
      id: actionId,
      tenant_id: tenantA.id,
      plan_id: planA.id,
      sequence: 1,
      action_type: 'data.mask',
      description: 'Mask a column, so the approve surface has something to approve',
      risk_score: 10,
      rollback_definition: { restore: 'persona-snapshot' },
      parameters: { columns: ['email'] },
      closes_finding_ids: [],
      dry_run_status: 'dry_run_complete',
      rollback_validated: true,
      dry_run_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      dry_run_result: { recordsAffected: 12 },
    }),
    201,
    'Action fixture',
  );

  const state: PersonaState = {
    deployment: target
      ? {
          id: target.deploymentId,
          environment: target.environment,
          revision: target.expectedRevision,
          webUrl: target.webUrl,
          bffUrl: target.bffUrl,
          marketingUrl: target.marketingUrl,
        }
      : null,
    supabaseUrl: origin,
    anonKey: status.ANON_KEY!,
    publishableKey: status.PUBLISHABLE_KEY!,
    serviceKey: status.SERVICE_ROLE_KEY!,
    tenantA,
    tenantB,
    engagementA,
    libraryVersion: library,
    planA: { ...planA, actionId },
    planB,
    accounts,
  };
  const path = acceptanceStatePath(target);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(state, null, 2), { mode: 0o600 });
  // Outcome only. These are real credentials for a real running stack.
  console.log(
    `Seeded ${PERSONAS.length} personas across 2 tenants, ${PERSONAS.filter((p) => p.totpEnrolled).length} with a TOTP factor. ` +
      'State written (not printed).',
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
