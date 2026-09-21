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
      const response = await app.request(
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
  await writeFile(`${stateDir}/${environment}.json`, JSON.stringify(outcomes, null, 2), {
    mode: 0o600,
  });
  console.log(
    `${environment}: real Auth, tenant RLS, RBAC, MFA enrolment/login/bound approval and durable idempotency passed.`,
  );
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Parity verification failed');
  process.exitCode = 1;
});
