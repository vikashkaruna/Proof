import { loadAcceptanceTarget, verifyAcceptanceTarget } from './lib/acceptance-target.js';
/** Real GoTrue + PostgREST + the complete BFF middleware chain. No auth mocks. */
import assert from 'node:assert/strict';
import { seedAcceptanceLibrary } from './lib/seed-acceptance-library.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';

async function main() {
  const target = loadAcceptanceTarget();
  const environment = process.argv[2] ?? target?.environment;
  if (target) {
    assert.equal(environment, target.environment, 'Target environment mismatch');
    await rm(resolve('.axiom-runtime/acceptance', target.deploymentId, 'api-results.json'), {
      force: true,
    });
    await verifyAcceptanceTarget(target, false);
  }
  assert(environment && ['staging', 'preprod', 'production', 'onprem'].includes(environment));
  const stateDir = process.env.AXIOM_PARITY_STATE_DIR ?? resolve('.axiom-runtime/parity');
  const status = (
    target
      ? {
          API_URL: target.supabaseUrl,
          ANON_KEY: target.anonKey,
          PUBLISHABLE_KEY: target.publishableKey,
          SERVICE_ROLE_KEY: target.serviceKey,
          SECRET_KEY: target.serviceKey,
        }
      : JSON.parse(await readFile(`${stateDir}/status.json`, 'utf8'))
  ) as Record<string, string>;
  // Run the hardened configuration against Docker's published interface. All
  // topology variants use this same real stack; no credential rules are relaxed.
  const address = Object.values(networkInterfaces())
    .flat()
    .find((n) => n?.family === 'IPv4' && !n.internal)?.address;
  if (!target) assert(address, 'A Docker-reachable network interface is required');
  const api = new URL(status.API_URL!);
  if (!target) api.hostname = address!;
  if (!target)
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
      AXIOM_REPORT_EMAIL_MODE: 'disabled',
      LOG_LEVEL: 'error',
    });

  await seedAcceptanceLibrary(api.origin, status.PUBLISHABLE_KEY!, status.SERVICE_ROLE_KEY!);

  async function apiRequest(
    path: string,
    method = 'GET',
    body?: unknown,
    token = status.SERVICE_ROLE_KEY!,
  ) {
    return fetch(`${api.origin}${path}`, {
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
    return {
      id: user.id,
      token: session.access_token,
      async newSession() {
        const response = await apiRequest(
          '/auth/v1/token?grant_type=password',
          'POST',
          { email, password },
          status.ANON_KEY!,
        );
        assert.equal(response.status, 200);
        return ((await response.json()) as { access_token: string }).access_token;
      },
    };
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

  const estateA = randomUUID();
  const estateB = randomUUID();
  const systemA = randomUUID();
  const systemB = randomUUID();
  assert.equal(
    (
      await apiRequest('/rest/v1/estates', 'POST', [
        { id: estateA, tenant_id: tenantA, slug: 'production', name: 'Estate A' },
        { id: estateB, tenant_id: tenantB, slug: 'production', name: 'Estate B' },
      ])
    ).status,
    201,
  );
  assert.equal(
    (
      await apiRequest('/rest/v1/estate_systems', 'POST', [
        {
          id: systemA,
          tenant_id: tenantA,
          estate_id: estateA,
          name: 'System A',
          system_kind: 'database',
        },
        {
          id: systemB,
          tenant_id: tenantB,
          estate_id: estateB,
          name: 'System B',
          system_kind: 'database',
        },
      ])
    ).status,
    201,
  );
  assert.equal(
    (
      await apiRequest('/rest/v1/system_data_categories', 'POST', [
        { tenant_id: tenantA, system_id: systemA, category_key: 'contact-details' },
        { tenant_id: tenantB, system_id: systemB, category_key: 'contact-details' },
      ])
    ).status,
    201,
  );
  assert.equal(
    (
      await apiRequest('/rest/v1/estate_scans', 'POST', [
        { tenant_id: tenantA, estate_id: estateA },
        { tenant_id: tenantB, estate_id: estateB },
      ])
    ).status,
    201,
  );
  const descriptorId = randomUUID();
  const connectorA = randomUUID();
  const connectorB = randomUUID();
  const identityA = randomUUID();
  const identityB = randomUUID();
  async function seedConnectorTable(table: string, rows: unknown) {
    const response = await apiRequest(`/rest/v1/${table}`, 'POST', rows);
    assert.equal(response.status, 201, `seed ${table}`);
  }
  await seedConnectorTable('connector_descriptors', {
    id: descriptorId,
    slug: `parity-${randomUUID()}`,
    version: '1',
    transport: 'mcp',
    target_binding: 'reference-mock',
    manifest: { enumerate: 'list' },
  });
  await seedConnectorTable('connectors', [
    {
      id: connectorA,
      tenant_id: tenantA,
      system_id: systemA,
      descriptor_id: descriptorId,
      target_binding: 'reference-mock',
      name: 'A',
      endpoint_ref: 'fixture-a',
      assurance: 'high',
    },
    {
      id: connectorB,
      tenant_id: tenantB,
      system_id: systemB,
      descriptor_id: descriptorId,
      target_binding: 'reference-mock',
      name: 'B',
      endpoint_ref: 'fixture-b',
      assurance: 'high',
    },
  ]);
  await seedConnectorTable('workload_identities', [
    {
      id: identityA,
      tenant_id: tenantA,
      agent_name: 'drishti',
      spiffe_id: 'spiffe://parity/agent/drishti',
    },
    {
      id: identityB,
      tenant_id: tenantB,
      agent_name: 'karya',
      spiffe_id: 'spiffe://parity/agent/karya',
    },
  ]);
  for (const [tenant_id, connector_id, workload_identity_id, agent_name, internal_scope] of [
    [tenantA, connectorA, identityA, 'drishti', 'connector.read'],
    [tenantB, connectorB, identityB, 'karya', 'connector.write'],
  ]) {
    await seedConnectorTable('connector_credentials', {
      tenant_id,
      connector_id,
      grant_type: 'cloud_iam',
      key_ref: 'fixture-key',
      algorithm: 'aes-256-gcm',
      nonce: `\\x${'aa'.repeat(12)}`,
      ciphertext: `\\x${'bb'.repeat(32)}`,
      wrapped_data_key: '\\xcc',
    });
    await seedConnectorTable('connector_grants', {
      tenant_id,
      connector_id,
      workload_identity_id,
      agent_name,
      internal_scope,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });
    await seedConnectorTable('connector_health_checks', {
      tenant_id,
      connector_id,
      status: 'healthy',
    });
    await seedConnectorTable('mcp_tool_registry', {
      tenant_id,
      connector_id,
      tool_name: 'list',
      tool_version: '1',
      operation_class: 'read',
      description: 'Fixture metadata only',
      input_schema: {},
    });
  }
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
        {
          id: engagementA,
          tenant_id: tenantA,
          estate_id: estateA,
          library_version: library,
          title: 'Visible A',
        },
        {
          id: engagementB,
          tenant_id: tenantB,
          estate_id: estateB,
          library_version: library,
          title: 'Private B',
        },
      ])
    ).status,
    201,
  );

  let request: (path: string, options?: RequestInit) => Promise<Response>;
  if (target)
    request = (path, options = {}) =>
      fetch(`${target.bffUrl}${path}`, {
        ...options,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
  else {
    const app = (await import('../services/bff/src/app.js')).createApp();
    request = (path, options) => Promise.resolve(app.request(path, options));
  }
  const outcomes: Record<string, number | boolean> = {};
  async function check(name: string, path: string, expected: number, options: RequestInit = {}) {
    const response = await request(path, options);
    outcomes[name] = response.status;
    assert.equal(response.status, expected, name);
    return response;
  }
  const reportConfig = await check('gap_scan_email_config', '/public/gap-scan/config', 200);
  assert.equal(
    ((await reportConfig.json()) as { emailDeliveryEnabled: boolean }).emailDeliveryEnabled,
    false,
  );
  const reportCreated = await check('gap_scan_create', '/public/gap-scan', 201, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: randomUUID(),
      answers: { q1: true, q2: false },
      contactEmail: 'fixture@example.invalid',
    }),
  });
  const report = (await reportCreated.json()) as {
    id: string;
    accessToken: string;
    postureScore: number;
    emailSent: boolean;
  };
  assert.equal(report.emailSent, false);
  const owned = await check('gap_scan_owned_read', `/public/gap-scan/${report.id}`, 200, {
    headers: { 'X-Gap-Scan-Access': report.accessToken },
  });
  const ownedReport = (await owned.json()) as {
    report_snapshot: { postureScore: number };
    access_token_hash?: string;
  };
  assert.equal(ownedReport.report_snapshot.postureScore, report.postureScore);
  assert.equal(ownedReport.access_token_hash, undefined);
  await check('gap_scan_missing_proof', `/public/gap-scan/${report.id}`, 404);
  await check('gap_scan_foreign_proof', `/public/gap-scan/${report.id}`, 404, {
    headers: { 'X-Gap-Scan-Access': randomBytes(32).toString('hex') },
  });
  await check('gap_scan_email_missing_proof', '/public/gap-scan/send-email', 404, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: report.id, email: 'fixture@example.invalid' }),
  });
  await check('gap_scan_email_disabled', '/public/gap-scan/send-email', 503, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Gap-Scan-Access': report.accessToken },
    body: JSON.stringify({ id: report.id, email: 'fixture@example.invalid' }),
  });
  const storedReport = await apiRequest(
    `/rest/v1/gap_scan_responses?id=eq.${report.id}&select=access_token_hash,report_snapshot`,
  );
  assert.equal(storedReport.status, 200);
  const stored = (
    (await storedReport.json()) as Array<{ access_token_hash: string; report_snapshot: unknown }>
  )[0]!;
  assert.notEqual(stored.access_token_hash, report.accessToken);
  await check('gap_scan_digest_is_not_proof', `/public/gap-scan/${report.id}`, 404, {
    headers: { 'X-Gap-Scan-Access': stored.access_token_hash },
  });
  const forged = await apiRequest(
    '/rest/v1/gap_scan_responses',
    'POST',
    { session_id: 'forged', access_token_hash: 'a'.repeat(64), library_version: library },
    viewer.token,
  );
  assert.equal(forged.status, 403);
  outcomes.gap_scan_direct_write_refused = true;
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
  for (const table of ['estates', 'estate_systems', 'system_data_categories', 'estate_scans']) {
    const read = await apiRequest(
      `/rest/v1/${table}?select=tenant_id`,
      'GET',
      undefined,
      viewer.token,
    );
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), [{ tenant_id: tenantA }], `${table}: real Auth RLS`);
  }
  assert.equal(
    (
      await apiRequest('/rest/v1/estate_systems', 'POST', {
        tenant_id: tenantA,
        estate_id: estateB,
        name: 'Wrong tenant',
        system_kind: 'database',
      })
    ).status,
    409,
    'Composite FK rejects privileged cross-tenant inventory writes',
  );
  assert.equal(
    (
      await apiRequest(
        '/rest/v1/estates',
        'POST',
        {
          tenant_id: tenantA,
          slug: 'forged',
          name: 'Unapproved browser write',
        },
        viewer.token,
      )
    ).status,
    403,
    'Browser cannot write inventory',
  );
  outcomes.estate_isolation = true;
  for (const table of [
    'connectors',
    'workload_identities',
    'connector_grants',
    'connector_health_checks',
    'mcp_tool_registry',
  ]) {
    const response = await apiRequest(
      `/rest/v1/${table}?select=tenant_id`,
      'GET',
      undefined,
      viewer.token,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(
      await response.json(),
      [{ tenant_id: tenantA }],
      `${table}: real Auth isolation`,
    );
  }
  assert.equal(
    (await apiRequest('/rest/v1/connector_credentials', 'GET', undefined, viewer.token)).status,
    403,
    'credential envelopes never reach browsers',
  );
  assert.equal(
    (await apiRequest(`/rest/v1/connectors?id=eq.${connectorA}`, 'PATCH', { system_id: systemB }))
      .status,
    409,
    'service cannot cross-link tenant systems',
  );
  assert.equal(
    (
      await apiRequest(`/rest/v1/connector_grants?tenant_id=eq.${tenantA}`, 'PATCH', {
        internal_scope: 'connector.write',
      })
    ).status,
    400,
    'Drishti cannot receive write scope',
  );
  assert.equal(
    (
      await apiRequest(
        `/rest/v1/connectors?id=eq.${connectorA}`,
        'PATCH',
        { status: 'active' },
        viewer.token,
      )
    ).status,
    403,
    'browser cannot activate connectors',
  );
  outcomes.connector_isolation = true;

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
  // Doc 11's W1 exit criterion, third clause: a viewer "cannot call the
  // approve endpoint". The browser journeys prove the button is absent; that
  // is a statement about the page, not about the server, and a caller who
  // never loads the page is exactly the one worth refusing. Asserted here
  // because this is the suite that holds a real GoTrue token.
  await check('viewer_cannot_approve', '/v1/plans/approve', 403, {
    method: 'POST',
    headers: {
      ...viewerHeaders,
      'idempotency-key': randomUUID(),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ planId: randomUUID(), actionIds: [randomUUID()], mode: 'batch' }),
  });
  // Rejecting is a different authority from approving and must be refused
  // for a viewer too — the two are separately gated, so they are separately
  // asserted.
  await check('viewer_cannot_reject', `/v1/plans/${randomUUID()}/reject`, 403, {
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

  // Full MFA round trips against actual Auth sessions and persisted factors.
  // Credentials remain in memory and are never written to parity reports.
  const ownerHeaders = { Authorization: `Bearer ${owner.token}`, 'x-tenant-id': tenantB };
  const ownerPost = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: {
      ...ownerHeaders,
      'idempotency-key': randomUUID(),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const enrol = await check('mfa_begin_enrolment', '/v1/mfa/enrol', 201, ownerPost({}));
  const factor = (await enrol.json()) as { factorId: string; secret: string };
  const { generateTotp } = await import('../packages/mfa/src/index.js');
  const activate = await check(
    'mfa_activate_totp',
    '/v1/mfa/enrol/activate',
    200,
    ownerPost({ code: generateTotp(factor.secret) }),
  );
  const { recoveryCodes } = (await activate.json()) as { recoveryCodes: string[] };
  assert(recoveryCodes.length >= 4);
  const encryptedFactor = await apiRequest(
    `/rest/v1/user_mfa_factors?id=eq.${factor.factorId}&select=secret_encrypted`,
  );
  assert.equal(encryptedFactor.status, 200);
  const factorRows = (await encryptedFactor.json()) as Array<{ secret_encrypted: string }>;
  assert.equal(factorRows.length, 1);
  assert(
    factorRows[0]!.secret_encrypted && !factorRows[0]!.secret_encrypted.includes(factor.secret),
    'TOTP secret must not be plaintext at rest',
  );
  const beforeLogin = await check('enrolled_owner_still_needs_login_mfa', '/v1/engagements', 401, {
    headers: ownerHeaders,
  });
  assert.equal(
    ((await beforeLogin.json()) as { error: { code: string } }).error.code,
    'mfa_verification_required',
  );
  async function challenge(name: string, body: unknown, code: string) {
    const issued = await check(`${name}_issued`, '/v1/mfa/challenge', 201, ownerPost(body));
    const { challengeId } = (await issued.json()) as { challengeId: string };
    await check(
      `${name}_verified`,
      `/v1/mfa/challenge/${challengeId}/verify`,
      200,
      ownerPost({ code }),
    );
    return challengeId;
  }
  await challenge('login_recovery', { purpose: 'login' }, recoveryCodes[0]!);
  const unlocked = await check('attested_owner_can_read', '/v1/engagements', 200, {
    headers: ownerHeaders,
  });
  assert.deepEqual(
    ((await unlocked.json()) as { engagements: Array<{ id: string }> }).engagements.map(
      (e) => e.id,
    ),
    [engagementB],
  );
  const linkedEngagement = await check(
    'create_estate_engagement',
    '/v1/engagements',
    201,
    ownerPost({ libraryVersion: library, title: 'Scoped assessment', estateId: estateB }),
  );
  assert.equal(((await linkedEngagement.json()) as { estate_id: string }).estate_id, estateB);
  await check(
    'refuse_foreign_estate_engagement',
    '/v1/engagements',
    422,
    ownerPost({ libraryVersion: library, title: 'Wrong scope', estateId: estateA }),
  );

  const estateIntent = ownerPost({ slug: 'managed-estate', name: 'Managed estate' });
  const estateCreated = await check('estate_create', '/v1/estates', 201, estateIntent);
  const managed = ((await estateCreated.json()) as { data: { id: string } }).data;
  const estateReplay = await check('estate_create_replay', '/v1/estates', 201, estateIntent);
  assert.equal(estateReplay.headers.get('idempotency-replayed'), 'true');
  assert.equal(((await estateReplay.json()) as { data: { id: string } }).data.id, managed.id);
  const auditRows = await apiRequest(
    `/rest/v1/audit_ledger?target_ref=eq.${managed.id}&action_type=eq.estate.created&select=id`,
  );
  assert.equal(auditRows.status, 200);
  assert.equal(
    ((await auditRows.json()) as unknown[]).length,
    1,
    'replay must append exactly one creation event',
  );
  await check('estate_foreign_read', `/v1/estates/${estateA}`, 404, { headers: ownerHeaders });
  await check('estate_foreign_update', `/v1/estates/${estateA}`, 404, {
    ...ownerPost({ name: 'Wrong tenant', status: 'active', expectedVersion: 1 }),
    method: 'PATCH',
  });
  const systemCreated = await check(
    'estate_system_create',
    `/v1/estates/${managed.id}/systems`,
    201,
    ownerPost({ name: 'CRM', systemKind: 'saas', dataCategories: ['contact'] }),
  );
  const managedSystem = ((await systemCreated.json()) as { data: { id: string } }).data;
  const changedSystem = {
    name: 'CRM updated',
    systemKind: 'saas',
    dataCategories: ['contact'],
    status: 'active',
    expectedVersion: 1,
  };
  await check('estate_system_update', `/v1/estate-systems/${managedSystem.id}`, 200, {
    ...ownerPost(changedSystem),
    method: 'PATCH',
  });
  await check('estate_stale_system_edit', `/v1/estate-systems/${managedSystem.id}`, 409, {
    ...ownerPost(changedSystem),
    method: 'PATCH',
  });
  const emptyAssessment = await check(
    'estate_unassigned_intake',
    '/v1/engagements',
    201,
    ownerPost({ libraryVersion: library, title: 'Unstarted scope' }),
  );
  const intakeId = ((await emptyAssessment.json()) as { id: string }).id;
  await check(
    'estate_assignment_requires_confirmation',
    `/v1/engagements/${intakeId}/estate`,
    400,
    ownerPost({ estateId: managed.id }),
  );
  await check(
    'estate_assignment',
    `/v1/engagements/${intakeId}/estate`,
    200,
    ownerPost({ estateId: managed.id, confirmed: true }),
  );
  await check(
    'estate_reassignment_refused',
    `/v1/engagements/${intakeId}/estate`,
    409,
    ownerPost({ estateId: estateB, confirmed: true }),
  );
  const registrationIntent = ownerPost({
    systemId: managedSystem.id,
    descriptorId: '41410000-0000-4000-8000-000000000002',
    name: 'Reference registration',
    endpointRef: 'reference_crm',
  });
  const registrationCreated = await check(
    'connector_register',
    '/v1/connectors',
    201,
    registrationIntent,
  );
  const registration = (
    (await registrationCreated.json()) as {
      data: { id: string; status: string; version: number; target_binding: string };
    }
  ).data;
  assert.equal(registration.status, 'draft');
  assert.equal(registration.target_binding, 'reference-mock');
  const registrationReplay = await check(
    'connector_register_replay',
    '/v1/connectors',
    201,
    registrationIntent,
  );
  assert.equal(registrationReplay.headers.get('idempotency-replayed'), 'true');
  assert.equal(
    ((await registrationReplay.json()) as { data: { id: string } }).data.id,
    registration.id,
  );
  const registrationAudits = await apiRequest(
    `/rest/v1/audit_ledger?target_ref=eq.${registration.id}&action_type=eq.connector.registered&select=id`,
  );
  assert.equal(((await registrationAudits.json()) as unknown[]).length, 1);
  const connectorPatch = (body: unknown) => ({ ...ownerPost(body), method: 'PATCH' });
  await check(
    'connector_foreign_system',
    '/v1/connectors',
    404,
    ownerPost({
      systemId: systemA,
      descriptorId: '41410000-0000-4000-8000-000000000002',
      name: 'Foreign',
      endpointRef: 'foreign',
    }),
  );
  await check(
    'connector_refuse_credentials',
    '/v1/connectors',
    400,
    ownerPost({
      systemId: managedSystem.id,
      descriptorId: '41410000-0000-4000-8000-000000000002',
      name: 'Secret',
      endpointRef: 'postgres://secret@host',
    }),
  );
  await check(
    'connector_foreign_update',
    `/v1/connectors/${connectorA}`,
    404,
    connectorPatch({ operation: 'transition', status: 'active', expectedVersion: 1 }),
  );
  const visibleConnectors = await check('connector_tenant_list', '/v1/connectors', 200, {
    headers: ownerHeaders,
  });
  assert(
    !((await visibleConnectors.json()) as { data: { id: string }[] }).data.some(
      (row) => row.id === connectorA,
    ),
  );
  await check(
    'connector_enable',
    `/v1/connectors/${registration.id}`,
    200,
    connectorPatch({ operation: 'transition', status: 'active', expectedVersion: 1 }),
  );
  await check(
    'connector_active_edit_refused',
    `/v1/connectors/${registration.id}`,
    409,
    connectorPatch({
      operation: 'edit',
      name: 'Changed',
      endpointRef: 'new_ref',
      expectedVersion: 2,
    }),
  );
  await check('connector_blocks_estate_archive', `/v1/estates/${managed.id}`, 409, {
    ...ownerPost({ name: 'Archived estate', status: 'archived', expectedVersion: 1 }),
    method: 'PATCH',
  });
  await check(
    'connector_disable',
    `/v1/connectors/${registration.id}`,
    200,
    connectorPatch({ operation: 'transition', status: 'disabled', expectedVersion: 2 }),
  );
  await check(
    'connector_stale_transition',
    `/v1/connectors/${registration.id}`,
    409,
    connectorPatch({ operation: 'transition', status: 'active', expectedVersion: 2 }),
  );
  await check('estate_archive', `/v1/estates/${managed.id}`, 200, {
    ...ownerPost({ name: 'Archived estate', status: 'archived', expectedVersion: 1 }),
    method: 'PATCH',
  });
  await check(
    'estate_archived_system_refused',
    `/v1/estates/${managed.id}/systems`,
    409,
    ownerPost({ name: 'Late system', systemKind: 'other' }),
  );
  await check(
    'estate_archived_assessment_refused',
    '/v1/engagements',
    409,
    ownerPost({ libraryVersion: library, title: 'Late assessment', estateId: managed.id }),
  );

  await check(
    'connector_archived_parent_refused',
    `/v1/connectors/${registration.id}`,
    409,
    connectorPatch({ operation: 'transition', status: 'active', expectedVersion: 3 }),
  );
  await check(
    'connector_archive',
    `/v1/connectors/${registration.id}`,
    200,
    connectorPatch({ operation: 'transition', status: 'archived', expectedVersion: 3 }),
  );
  await check(
    'connector_archive_terminal',
    `/v1/connectors/${registration.id}`,
    409,
    connectorPatch({ operation: 'transition', status: 'active', expectedVersion: 4 }),
  );
  const preparer = await createUser();
  assert.equal(
    (
      await apiRequest('/rest/v1/tenant_users', 'POST', {
        tenant_id: tenantB,
        user_id: preparer.id,
        role: 'axiom_analyst',
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await apiRequest('/rest/v1/tenant_onboarding_intakes', 'POST', {
        tenant_id: tenantB,
        submitted_by: owner.id,
        dpo_email: 'private-contact@example.invalid',
        proposed_systems: [{ name: 'Original CRM', type: 'custom' }],
      })
    ).status,
    201,
  );
  const prepared = await apiRequest('/rest/v1/rpc/prepare_onboarding_proposal', 'POST', {
    p_tenant_id: tenantB,
    p_actor_id: preparer.id,
    p_estate_id: estateB,
    p_systems: [{ name: 'Reviewed CRM', systemKind: 'saas', dataCategories: ['contact'] }],
    p_correlation_id: randomUUID(),
  });
  assert.equal(prepared.status, 200);
  const proposal = ((await prepared.json()) as { data: { id: string; content_sha256: string } })
    .data;
  const proposalsRead = await check('proposal_read', '/v1/onboarding/proposals', 200, {
    headers: ownerHeaders,
  });
  assert(
    !(await proposalsRead.text()).includes('private-contact@example.invalid'),
    'private intake contact must not enter inventory responses',
  );
  await check(
    'proposal_requires_staff_preparer',
    '/v1/onboarding/proposals',
    403,
    ownerPost({ estateId: estateB, systems: [{ name: 'CRM', systemKind: 'saas' }] }),
  );
  await check(
    'proposal_wrong_digest',
    `/v1/onboarding/proposals/${proposal.id}/review`,
    409,
    ownerPost({ contentSha256: '0'.repeat(64), decision: 'approved', reason: 'Stale content' }),
  );
  const reviewIntent = ownerPost({
    contentSha256: proposal.content_sha256,
    decision: 'approved',
    reason: 'Reviewed original intake and normalized inventory',
  });
  await check(
    'proposal_owner_approval',
    `/v1/onboarding/proposals/${proposal.id}/review`,
    200,
    reviewIntent,
  );
  const reviewedAgain = await check(
    'proposal_review_replay',
    `/v1/onboarding/proposals/${proposal.id}/review`,
    200,
    reviewIntent,
  );
  assert.equal(reviewedAgain.headers.get('idempotency-replayed'), 'true');
  const appliedSystems = await apiRequest(
    `/rest/v1/onboarding_proposal_systems?proposal_id=eq.${proposal.id}&select=system_id`,
  );
  assert.equal(appliedSystems.status, 200);
  assert.equal(((await appliedSystems.json()) as unknown[]).length, 1);
  const reviewedAudit = await apiRequest(
    `/rest/v1/audit_ledger?target_ref=eq.${proposal.id}&action_type=eq.onboarding.proposal.approved&select=id`,
  );
  assert.equal(((await reviewedAudit.json()) as unknown[]).length, 1);
  await check(
    'proposal_second_review_refused',
    `/v1/onboarding/proposals/${proposal.id}/review`,
    409,
    ownerPost({
      contentSha256: proposal.content_sha256,
      decision: 'approved',
      reason: 'Duplicate intent',
    }),
  );

  await check('login_attestation_cannot_move_to_another_session', '/v1/engagements', 401, {
    headers: { ...ownerHeaders, Authorization: `Bearer ${await owner.newSession()}` },
  });

  const replayChallenge = await check(
    'recovery_reuse_challenge',
    '/v1/mfa/challenge',
    201,
    ownerPost({ purpose: 'login' }),
  );
  const replayId = ((await replayChallenge.json()) as { challengeId: string }).challengeId;
  await check(
    'recovery_code_single_use',
    `/v1/mfa/challenge/${replayId}/verify`,
    401,
    ownerPost({ code: recoveryCodes[0] }),
  );

  const planId = randomUUID();
  const actionId = randomUUID();
  assert.equal(
    (
      await apiRequest('/rest/v1/remediation_plans', 'POST', {
        id: planId,
        tenant_id: tenantB,
        engagement_id: engagementB,
        library_version: library,
        title: 'Parity approval only — no execution',
        status: 'review',
        version: 1,
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await apiRequest('/rest/v1/remediation_actions', 'POST', {
        id: actionId,
        tenant_id: tenantB,
        plan_id: planId,
        sequence: 1,
        action_type: 'data.mask',
        description: 'Synthetic approval fixture',
        risk_score: 10,
        rollback_definition: { fixture: true },
        rollback_validated: true,
        dry_run_status: 'dry_run_complete',
        dry_run_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      })
    ).status,
    201,
  );
  const approval = { planId, actionIds: [actionId], mode: 'batch' };
  await check(
    'session_mfa_does_not_replace_approval_step_up',
    '/v1/plans/approve',
    401,
    ownerPost(approval),
  );
  const staleChallenge = await challenge(
    'approval_revision_one',
    { ...approval, purpose: 'approval_issuance' },
    recoveryCodes[1]!,
  );
  assert.equal(
    (await apiRequest(`/rest/v1/remediation_plans?id=eq.${planId}`, 'PATCH', { version: 2 }))
      .status,
    200,
  );
  await check(
    'changed_plan_invalidates_step_up',
    '/v1/plans/approve',
    401,
    ownerPost({ ...approval, mfaChallengeId: staleChallenge }),
  );
  const validChallenge = await challenge(
    'approval_revision_two',
    { ...approval, purpose: 'approval_issuance' },
    recoveryCodes[2]!,
  );
  assert.equal(
    (
      await apiRequest(`/rest/v1/remediation_actions?id=eq.${actionId}`, 'PATCH', {
        parameters: { changedAfterStepUp: true },
      })
    ).status,
    200,
  );
  await check(
    'changed_action_content_invalidates_step_up',
    '/v1/plans/approve',
    401,
    ownerPost({ ...approval, mfaChallengeId: validChallenge }),
  );
  const freshContentChallenge = await challenge(
    'approval_current_content',
    { ...approval, purpose: 'approval_issuance' },
    recoveryCodes[3]!,
  );
  const approved = await check(
    'fresh_bound_step_up_issues_token',
    '/v1/plans/approve',
    201,
    ownerPost({ ...approval, mfaChallengeId: freshContentChallenge }),
  );
  const approvalResult = (await approved.json()) as {
    approvalTokenId: string;
    token: { spec: { actionIds: string[] } };
  };
  assert.deepEqual(approvalResult.token.spec.actionIds, [actionId]);
  await check(
    'approval_step_up_single_use',
    '/v1/plans/approve',
    401,
    ownerPost({ ...approval, mfaChallengeId: freshContentChallenge }),
  );
  const recorded = await apiRequest(
    `/rest/v1/approval_tokens?id=eq.${approvalResult.approvalTokenId}&select=status`,
  );
  assert.deepEqual(
    await recorded.json(),
    [{ status: 'issued' }],
    'Test only approves; no execution is attempted',
  );

  // Even possession of a valid token cannot grant an unprivileged member
  // the separate capability to start estate execution.
  assert.equal(
    (
      await apiRequest('/rest/v1/tenant_users', 'POST', {
        tenant_id: tenantB,
        user_id: viewer.id,
        role: 'viewer',
      })
    ).status,
    201,
  );
  await check('viewer_with_valid_token_cannot_execute', `/v1/plans/${planId}/execute`, 403, {
    ...ownerPost({ ...approval, approvalToken: JSON.stringify(approvalResult.token) }),
    headers: {
      Authorization: `Bearer ${viewer.token}`,
      'x-tenant-id': tenantB,
      'idempotency-key': randomUUID(),
      'content-type': 'application/json',
    },
  });

  for (const operation of ['issue', 'verify'] as const) {
    let limited = false;
    for (let attempt = 0; attempt < 21; attempt++) {
      const response = await request(
        operation === 'issue' ? '/v1/mfa/challenge' : `/v1/mfa/challenge/${randomUUID()}/verify`,
        ownerPost(operation === 'issue' ? { purpose: 'login' } : { code: '000000' }),
      );
      if (response.status === 429) {
        assert(Number(response.headers.get('Retry-After')) > 0);
        assert.equal(
          ((await response.json()) as { error: { code: string } }).error.code,
          'rate_limited',
        );
        limited = true;
        break;
      }
      assert.equal(
        response.status,
        operation === 'issue' ? 201 : 404,
        `MFA ${operation} budget response`,
      );
    }
    assert(limited, `MFA ${operation} must be bounded across fresh challenges`);
    outcomes[`mfa_${operation}_budget`] = true;
  }
  const outputDirectory = target
    ? resolve('.axiom-runtime/acceptance', target.deploymentId)
    : stateDir;
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    `${outputDirectory}/${target ? 'api-results' : environment}.json`,
    JSON.stringify(
      target
        ? {
            schemaVersion: 1,
            kind: 'deployed-http',
            passed: true,
            completedAt: new Date().toISOString(),
            deploymentId: target.deploymentId,
            environment,
            topology: target.topology,
            revision: target.expectedRevision,
            bffUrl: target.bffUrl,
            outcomes,
          }
        : outcomes,
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    `${environment}: real Auth, tenant RLS, RBAC, MFA enrolment/login/bound approval and durable idempotency passed.`,
  );
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Parity verification failed');
  process.exitCode = 1;
});
