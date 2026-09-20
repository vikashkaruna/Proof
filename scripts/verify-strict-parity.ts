/** Real GoTrue + PostgREST + the complete BFF middleware chain. No auth mocks. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';

async function main() {
  const environment = process.argv[2];
  assert(environment && ['staging', 'preprod', 'production', 'onprem'].includes(environment));
  const stateDir = process.env.AXIOM_PARITY_STATE_DIR ?? resolve('.axiom-runtime/parity');
  const status = JSON.parse(await readFile(`${stateDir}/status.json`, 'utf8')) as Record<
    string,
    string
  >;
  // Run the hardened configuration against Docker's published interface. All
  // topology variants use this same real stack; no credential rules are relaxed.
  const address = Object.values(networkInterfaces())
    .flat()
    .find((n) => n?.family === 'IPv4' && !n.internal)?.address;
  assert(address, 'A Docker-reachable network interface is required');
  const api = new URL(status.API_URL!);
  api.hostname = address;
  Object.assign(process.env, {
    NODE_ENV: 'production',
    ENVIRONMENT: environment,
    AXIOM_AUTH_MODE: 'strict',
    SUPABASE_URL: api.origin,
    SUPABASE_ANON_KEY: status.PUBLISHABLE_KEY,
    SUPABASE_SERVICE_KEY: status.SECRET_KEY,
    APPROVAL_SIGNING_KEY: randomBytes(32).toString('hex'),
    AXIOM_MFA_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    AGENT_RUNTIME_INTERNAL_TOKEN: randomBytes(32).toString('hex'),
    AGENT_RUNTIME_URL: 'http://unused-runtime.invalid',
    MODEL_GATEWAY_API_KEY: randomBytes(32).toString('hex'),
    AXIOM_REGION: 'ap-south-1',
    LOG_LEVEL: 'error',
  });

  async function apiRequest(
    path: string,
    method = 'GET',
    body?: unknown,
    token = status.SERVICE_ROLE_KEY!,
  ) {
    return fetch(`${api.origin}${path}`, {
      method,
      headers: {
        apikey: status.PUBLISHABLE_KEY!,
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        Prefer: 'return=representation',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function createUser() {
    const email = `parity-${randomUUID()}@example.invalid`;
    const password = randomBytes(24).toString('base64url');
    const created = await apiRequest('/auth/v1/admin/users', 'POST', {
      email,
      password,
      email_confirm: true,
    });
    assert.equal(created.status, 200, 'Real Auth admin create');
    const user = (await created.json()) as { id: string };
    const mirrored = await apiRequest('/rest/v1/users', 'POST', { id: user.id, email });
    assert.equal(mirrored.status, 201, 'Application profile provisioning');
    const login = await apiRequest(
      '/auth/v1/token?grant_type=password',
      'POST',
      { email, password },
      status.ANON_KEY!,
    );
    assert.equal(login.status, 200, 'Real password sign-in');
    const session = (await login.json()) as { access_token: string };
    assert.equal(session.access_token.split('.').length, 3);
    return { id: user.id, token: session.access_token };
  }
  const viewer = await createUser();
  const owner = await createUser();
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  assert.equal(
    (
      await apiRequest('/rest/v1/tenants', 'POST', [
        { id: tenantA, slug: `parity-${tenantA}`, name: 'Parity A', tier: 'growth' },
        { id: tenantB, slug: `parity-${tenantB}`, name: 'Parity B', tier: 'growth' },
      ])
    ).status,
    201,
  );
  assert.equal(
    (
      await apiRequest('/rest/v1/tenant_users', 'POST', [
        { tenant_id: tenantA, user_id: viewer.id, role: 'viewer' },
        { tenant_id: tenantB, user_id: owner.id, role: 'owner' },
      ])
    ).status,
    201,
  );

  const library = `parity-${randomUUID()}`;
  const engagementA = randomUUID();
  const engagementB = randomUUID();
  assert.equal(
    (
      await apiRequest('/rest/v1/control_libraries', 'POST', {
        version: library,
        published_at: new Date().toISOString(),
        published_by: 'parity-fixture',
        change_log: 'Isolation test only; not an assessment baseline',
        control_count: 0,
        is_current: false,
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await apiRequest('/rest/v1/engagements', 'POST', [
        { id: engagementA, tenant_id: tenantA, library_version: library, title: 'Visible A' },
        { id: engagementB, tenant_id: tenantB, library_version: library, title: 'Private B' },
      ])
    ).status,
    201,
  );

  const { createApp } = await import('../services/bff/src/app.js');
  const app = createApp();
  const outcomes: Record<string, number | boolean> = {};
  async function check(name: string, path: string, expected: number, options: RequestInit = {}) {
    const response = await app.request(path, options);
    outcomes[name] = response.status;
    assert.equal(response.status, expected, name);
    return response;
  }
  const viewerHeaders = { Authorization: `Bearer ${viewer.token}`, 'x-tenant-id': tenantA };
  await check('unauthenticated', '/v1/engagements', 401);
  await check('cookie_cannot_authenticate', '/v1/engagements', 401, {
    headers: { cookie: 'axiom_e2e_bypass=true', 'x-tenant-id': tenantA },
  });
  await check('synthetic_token', '/v1/engagements', 401, {
    headers: { ...viewerHeaders, Authorization: 'Bearer dev-token' },
  });
  const ownRead = await check('own_tenant_read', '/v1/engagements', 200, {
    headers: viewerHeaders,
  });
  const ownBody = (await ownRead.json()) as { engagements: Array<{ id: string }> };
  assert.deepEqual(
    ownBody.engagements.map((row) => row.id),
    [engagementA],
  );
  await check('foreign_resource_id', `/v1/engagements/${engagementB}`, 404, {
    headers: viewerHeaders,
  });
  await check('foreign_tenant', '/v1/engagements', 403, {
    headers: { ...viewerHeaders, 'x-tenant-id': tenantB },
  });
  const visible = await apiRequest('/rest/v1/tenants?select=id', 'GET', undefined, viewer.token);
  assert.equal(visible.status, 200);
  assert.deepEqual(await visible.json(), [{ id: tenantA }]);
  outcomes.direct_rls = true;
  const promotion = await apiRequest(
    `/rest/v1/users?id=eq.${viewer.id}`,
    'PATCH',
    { is_axiom_internal: true },
    viewer.token,
  );
  assert.equal(promotion.status, 403, 'Direct client cannot promote itself');
  outcomes.self_promotion = promotion.status;
  await check('viewer_cannot_invoke', '/v1/agents/drishti/run', 403, {
    method: 'POST',
    headers: {
      ...viewerHeaders,
      'idempotency-key': randomUUID(),
      'content-type': 'application/json',
    },
    body: '{}',
  });
  const quarantined = await check('owner_needs_mfa', '/v1/engagements', 403, {
    headers: { Authorization: `Bearer ${owner.token}`, 'x-tenant-id': tenantB },
  });
  assert.equal(
    ((await quarantined.json()) as { error: { code: string } }).error.code,
    'mfa_enrolment_required',
  );
  await check('no_key', '/v1/organizations/onboard', 400, {
    method: 'POST',
    headers: viewerHeaders,
    body: '{}',
  });
  const key = randomUUID();
  const onboard = {
    method: 'POST',
    headers: { ...viewerHeaders, 'idempotency-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Not entitled' }),
  };
  await check('entitlement_refusal', '/v1/organizations/onboard', 403, onboard);
  const replay = await check('idempotent_replay', '/v1/organizations/onboard', 403, onboard);
  assert.equal(replay.headers.get('idempotency-replayed'), 'true');
  await check('key_payload_conflict', '/v1/organizations/onboard', 409, {
    ...onboard,
    body: JSON.stringify({ name: 'Different payload' }),
  });
  await writeFile(`${stateDir}/${environment}.json`, JSON.stringify(outcomes, null, 2), {
    mode: 0o600,
  });
  console.log(
    `${environment}: real Auth, tenant RLS, RBAC, MFA quarantine and durable idempotency passed.`,
  );
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Parity verification failed');
  process.exitCode = 1;
});
