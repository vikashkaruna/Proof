import {
  constants,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
/** Owned W8 fixture only. Password login + real MFA + mounted UI/RPCs.
 * Fixture accounts begin with enrolled test factors; this is not enrolment
 * acceptance, key provisioning, workload execution or legal-compliance proof. */
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { z } from 'zod';
import {
  encodeLocalCustodyPolicy,
  encodeLocalCustodyEvent,
  encodeLocalCustodyCancellation,
  localCustodyContextSchema,
  localCustodyCancellationReceiptSchema,
} from '../../../packages/types/src/index';
import { generateTotp } from '@axiom/mfa';
import { LocalKeyPolicy } from '../../../services/bff/src/workloads/local-key-policy';
import { createMfaAccount, signInAs, satisfyLoginMfaWithSecret, state } from '../fixtures';
import { withFreshMfaFixtureCounter } from '../fixtures/login-mfa-counter';
import { localRoleBearer } from '../local-writer';
import { acceptanceTarget, personaStatePath, tenantCookie, webOrigin } from '../target';

import { custodyBrowserFixtureGuard } from '../../../scripts/lib/acceptance-local-custody-browser';

const custodyRecordErrorCodes = [
  'custody_mfa_refused',
  'custody_forbidden',
  'tenant_forbidden',
  'tenant_selection_required',
  'mfa_enrolment_required',
  'mfa_verification_required',
  'staff_authority_required',
  'offline_license_invalid',
  'custody_outcome_unconfirmed',
  'unknown',
] as const;
const custodyRecordFailureSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('custody-cancellation-record-failure'),
    status: z.number().int().min(100).max(599).nullable(),
    code: z.enum(custodyRecordErrorCodes),
    recordRequests: z.number().int().min(0).max(1000000),
    completedFetches: z.number().int().min(0).max(1000000),
    body: z
      .object({
        withinBound: z.boolean(),
        jsonDecoded: z.boolean(),
        topObject: z.boolean(),
        errorObject: z.boolean(),
        hasData: z.boolean(),
      })
      .strict(),
    matches: z
      .object({
        tenant: z.boolean(),
        actor: z.boolean(),
        operationKey: z.boolean(),
        resolution: z.boolean(),
        challenge: z.boolean(),
        requestOrigin: z.boolean(),
        responseOrigin: z.boolean(),
        responsePath: z.boolean(),
      })
      .strict(),
  })
  .strict();
function custodyRecordResponse(bytes: Uint8Array | null) {
  const result = {
    code: 'unknown' as (typeof custodyRecordErrorCodes)[number],
    body: {
      withinBound: bytes !== null && bytes.byteLength <= 4096,
      jsonDecoded: false,
      topObject: false,
      errorObject: false,
      hasData: false,
    },
  };
  if (!result.body.withinBound || bytes === null) return result;
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    result.body.jsonDecoded = true;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
    result.body.topObject = true;
    result.body.hasData = Object.hasOwn(value, 'data');
    const error: unknown = (value as Record<string, unknown>).error;
    result.body.errorObject = !!error && typeof error === 'object' && !Array.isArray(error);
    const code: unknown = result.body.errorObject ? (error as Record<string, unknown>).code : error;
    if (typeof code === 'string' && custodyRecordErrorCodes.some((allowed) => allowed === code))
      result.code = code as typeof result.code;
  } catch {
    /* No body, error message, IDs, URLs or arbitrary keys are retained. */
  }
  return result;
}
function retainCustodyRecordFailure(directory: string, value: unknown) {
  const text = JSON.stringify(custodyRecordFailureSchema.parse(value)) + '\n';
  if (Buffer.byteLength(text) > 4096 || realpathSync(directory) !== resolve(directory))
    throw Error('Private failure destination refused');
  const parent = lstatSync(directory);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid?.() ||
    (parent.mode & 0o077) !== 0
  )
    throw Error('Private failure directory refused');
  const fd = openSync(
    join(directory, 'private-custody-cancellation-record-failure.json'),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const dirfd = openSync(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(dirfd);
  } finally {
    closeSync(dirfd);
  }
}

const assertOwnedFixture = custodyBrowserFixtureGuard(resolve(__dirname, '../../..'), state);
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const path = '/settings/local-custody';
type Account = Awaited<ReturnType<typeof createMfaAccount>>;
type Person = { who: Account; context: BrowserContext; page: Page };
const ownedContexts: BrowserContext[] = [];
let owner: Person, founder: Person, operator: Person;
let tenant: { id: string; slug: string },
  policyId: string,
  manifest: { policyText: string; policySha256: string };
const counters = join(dirname(personaStatePath), 'custody-browser-mfa-counters');
const requestPrefix = (actor: string) => `axiom:custody-policy:v1:${tenant.id}:${actor}:`;
const resolutionPrefix = (actor: string) =>
  `axiom:custody-policy-resolution:v1:${tenant.id}:${actor}:`;
function requireOwnedLocal() {
  if (
    acceptanceTarget ||
    process.env.AXIOM_LOCAL_CUSTODY_BROWSER_ACCEPTANCE !== 'true' ||
    process.env.AXIOM_EVIDENCE_STORAGE_ACCEPTANCE !== 'true' ||
    !process.env.AXIOM_EVIDENCE_FIXTURE_DIRECTORY ||
    !['127.0.0.1', 'localhost'].includes(new URL(state.supabaseUrl).hostname)
  )
    throw Error('Explicit owned local custody browser mode required');
  assertOwnedFixture();
}
async function fixturePost(path: string, body: unknown, expected: number, writer = false) {
  requireOwnedLocal();
  const response = await fetch(state.supabaseUrl + path, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
    headers: {
      apikey: state.publishableKey,
      Authorization: `Bearer ${writer ? localRoleBearer('human_action_writer', state) : state.serviceKey}`,
      'content-type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  expect(response.status, 'Synthetic fixture setup status only').toBe(expected);
  return response.json() as Promise<unknown>;
}
async function signIn(person: Person) {
  await person.context.addCookies([tenantCookie(tenant.slug)]);
  const unauthenticated = await person.page.request.get(
    '/api/bff/v1/local-custody-policy/context',
    {
      headers: { 'X-Tenant-Id': tenant.id, 'X-Expected-Actor-Id': person.who.id },
      maxRedirects: 0,
    },
  );
  // The web middleware redirects unauthenticated requests before the API bridge.
  // Inspect that refusal directly instead of following it to the public login HTML.
  expect(unauthenticated.status()).toBe(307);
  const login = new URL(unauthenticated.headers()['location'] ?? '', webOrigin);
  expect(login.origin).toBe(new URL(webOrigin).origin);
  expect(login.pathname).toBe('/login');
  expect(login.searchParams.get('redirect')).toBe('/api/bff/v1/local-custody-policy/context');
  await signInAs(person.page, person.who.email, person.who.password);
  const secret = person.who.totpSecret;
  if (!secret) throw Error('Enrolled test factor required');
  await withFreshMfaFixtureCounter(counters, person.who.id, () =>
    satisfyLoginMfaWithSecret(person.page, secret),
  );
  await person.page.goto(path);
  await expect(
    person.page.getByRole('heading', { name: 'Local dispatch-key custody', exact: true }),
  ).toBeVisible();
  await expect(
    person.page.getByRole('button', { name: 'Refresh current policies', exact: true }),
  ).toBeEnabled();
}
async function snapshot(person: Person) {
  return person.page.evaluate(
    ({ request, resolution }) =>
      Object.fromEntries(
        Object.entries(localStorage).filter(
          ([key]) => key.startsWith(request) || key.startsWith(resolution),
        ),
      ),
    { request: requestPrefix(person.who.id), resolution: resolutionPrefix(person.who.id) },
  );
}
async function context(person: Person) {
  const response = await person.page.request.get(
    `/api/bff/v1/local-custody-policy/context?policyId=${policyId}`,
    { headers: { 'X-Tenant-Id': tenant.id, 'X-Expected-Actor-Id': person.who.id } },
  );
  expect(response.status()).toBe(200);
  const body = z
    .object({ data: localCustodyContextSchema })
    .strict()
    .parse(await response.json());
  expect(body.data).toMatchObject({
    tenantId: tenant.id,
    actorId: person.who.id,
    selectedPolicyId: policyId,
  });
  expect(body.data.rows).toHaveLength(1);
  expect(body.data.rows[0]).toMatchObject({
    policyId,
    policyText: manifest.policyText,
    policySha256: manifest.policySha256,
  });
  for (const receipt of body.data.history) {
    expect(receipt.policySha256).toBe(manifest.policySha256);
    expect(receipt.requestSha256).toBe(sha(receipt.requestText));
  }
  return body.data;
}
function article(person: Person) {
  return person.page
    .locator('article')
    .filter({ has: person.page.getByRole('heading', { name: `Policy ${policyId}`, exact: true }) });
}
async function prepare(
  person: Person,
  action: 'request' | 'approve' | 'activate' | 'review',
  reason: string,
) {
  await person.page.getByLabel('Reason', { exact: true }).fill(reason);
  if (action === 'request')
    await person.page
      .getByLabel('Operator-reviewed non-secret manifest JSON')
      .fill(JSON.stringify(manifest));
  if (action === 'review')
    await person.page
      .getByLabel(/^Next periodic review \(review action only/)
      .fill(new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 16));
  await person.page
    .getByLabel('I reviewed the exact non-secret policy, selected action and reason.', {
      exact: true,
    })
    .check();
  await (
    action === 'request'
      ? person.page.getByRole('button', { name: 'Prepare owner request', exact: true })
      : article(person).getByRole('button', { name: `Prepare ${action}`, exact: true })
  ).click();
  await expect(
    person.page.getByRole('button', { name: 'Check retained request', exact: true }),
  ).toBeVisible();
  const retained = await snapshot(person);
  expect(Object.keys(retained)).toHaveLength(1);
  const original = z
    .object({
      tenantId: z.literal(tenant.id),
      actorId: z.literal(person.who.id),
      request: z.unknown(),
    })
    .strict()
    .parse(JSON.parse(Object.values(retained)[0]!));
  expect(encodeLocalCustodyEvent(original.request)).toContain(reason);
  return retained;
}
async function checkThenMfa(person: Person, resolution = false) {
  await person.page
    .getByRole('button', {
      name: resolution ? 'Check retained cancellation' : 'Check retained request',
      exact: true,
    })
    .click();
  await expect(person.page.getByRole('status')).toContainText('No positive receipt was found');
  await person.page
    .getByLabel('I reviewed this exact retained request and authorize its retry with fresh MFA.', {
      exact: true,
    })
    .check();
  const secret = person.who.totpSecret;
  if (!secret) throw Error('Enrolled factor required');
  await withFreshMfaFixtureCounter(counters, person.who.id, async () => {
    const issued = person.page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === '/api/bff/v1/local-custody-policy/challenge' &&
        r.request().method() === 'POST',
    );
    await person.page
      .getByRole('button', { name: 'Request authenticator challenge', exact: true })
      .click();
    expect((await issued).status()).toBe(200);
    await person.page.getByLabel('Authenticator code', { exact: true }).fill(generateTotp(secret));
    const verified = person.page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === '/api/bff/v1/local-custody-policy/verify' &&
        r.request().method() === 'POST',
    );
    await person.page.getByRole('button', { name: 'Verify authenticator', exact: true }).click();
    expect((await verified).status()).toBe(200);
    await expect(
      person.page.getByRole('button', {
        name: resolution ? 'Record exact cancellation' : 'Record exact custody action',
        exact: true,
      }),
    ).toBeEnabled();
  });
}
async function record(person: Person) {
  const response = person.page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/bff/v1/local-custody-policy/record' &&
      r.request().method() === 'POST',
  );
  await person.page
    .getByRole('button', { name: 'Record exact custody action', exact: true })
    .click();
  expect((await response).status()).toBe(201);
  await expect(
    person.page.getByRole('region', { name: 'Confirmed custody receipt' }),
  ).toBeVisible();
  expect(await snapshot(person)).toEqual({});
}
async function ledger(person: Person) {
  const response = await person.page.request.get('/api/bff/v1/ledger?limit=1000', {
    headers: { 'X-Tenant-Id': tenant.id },
  });
  expect(response.status()).toBe(200);
  return z
    .object({
      entries: z.array(
        z
          .object({
            id: z.union([z.number().int().safe(), z.string()]),
            tenant_id: z.literal(tenant.id),
            actor_type: z.string(),
            actor_id: z.string(),
            action_type: z.string(),
            correlation_id: z.string(),
            target_ref: z.string().nullable(),
            input_hash: z.string().nullable(),
            output_hash: z.string().nullable(),
            entry_hash: z.string(),
          })
          .passthrough(),
      ),
      count: z.number().int(),
    })
    .parse(await response.json()).entries;
}

test.describe.serial('normal Auth local custody policy workflow', () => {
  test.afterAll(async () => {
    const results = await Promise.allSettled(ownedContexts.map((current) => current.close()));
    if (results.some((result) => result.status === 'rejected'))
      throw Error('Owned browser context cleanup failed');
  });
  test('customer owner requests an exact reviewed dispatch-key policy', async ({ browser }) => {
    requireOwnedLocal();
    const create = async (
      label: string,
      role: 'owner' | 'founder' | 'axiom_analyst',
      internal: boolean,
    ) => {
      requireOwnedLocal();
      const who = await createMfaAccount(`custody-${label}`, {
        role,
        isInternal: internal,
        withFactor: true,
      });
      const current = await browser.newContext({ baseURL: webOrigin });
      ownedContexts.push(current);
      return { who, context: current, page: await current.newPage() };
    };
    owner = await create('owner', 'owner', false);
    founder = await create('founder', 'founder', true);
    operator = await create('operator', 'axiom_analyst', true);
    tenant = { id: randomUUID(), slug: `custody-browser-${randomUUID()}` };
    await fixturePost(
      '/rest/v1/tenants',
      { ...tenant, name: 'Synthetic normal-Auth custody browser', is_demo: false },
      201,
    );
    for (const [person, role] of [
      [owner, 'owner'],
      [founder, 'founder'],
      [operator, 'axiom_analyst'],
    ] as const)
      await fixturePost(
        '/rest/v1/tenant_users',
        { tenant_id: tenant.id, user_id: person.who.id, role, approval_scopes: [] },
        201,
      );
    const workloadId = randomUUID();
    let version = 0;
    for (const status of ['disabled', 'active']) {
      const result = z
        .object({ version: z.number().int().positive() })
        .passthrough()
        .parse(
          await fixturePost(
            '/rest/v1/rpc/manage_workload_identity',
            {
              p_tenant_id: tenant.id,
              p_actor_id: owner.who.id,
              p_correlation_id: randomUUID(),
              p_workload_id: workloadId,
              p_expected_version: version,
              p_agent: 'parikshan',
              p_spiffe_id: `spiffe://custody-${workloadId}.axiom.test/agent/parikshan`,
              p_status: status,
            },
            200,
            true,
          ),
        );
      version = result.version;
    }
    policyId = randomUUID();
    const keyRef = `axiom-local-dispatch://${tenant.id}/${randomUUID()}/versions/1`,
      validity = { kind: 'until_revoked' as const, reviewDueAt: 1 };
    const policyText = encodeLocalCustodyPolicy({
      version: 1,
      policyId,
      tenantId: tenant.id,
      mode: 'operator_managed',
      nominatedOperatorId: operator.who.id,
      targetWorkloadId: workloadId,
      servicePrincipals: {
        producer: 'spiffe://local.axiomproof.test/service/assessment-dispatch-producer',
        controller: 'spiffe://local.axiomproof.test/controller/assessment',
      },
      validity,
      actionClass: 'assessment_dispatch_key_custody',
      keyPolicy: { primary: keyRef, readable: [keyRef] },
      keyPolicySha256: new LocalKeyPolicy({
        tenantId: tenant.id,
        revision: policyId,
        mode: 'operator_managed',
        validity,
        primary: keyRef,
        readable: [keyRef],
      }).fingerprint,
      deploymentBindingSha256: sha(`synthetic custody browser:${tenant.id}`),
      reason: 'Synthetic operator-reviewed dispatch-key custody only',
      acceptedLimitations: ['hardware_backing_unverified'],
      statutoryComplianceAsserted: false,
      ownershipVerified: false,
    });
    manifest = { policyText, policySha256: sha(policyText) };
    await signIn(owner);
    await prepare(owner, 'request', 'Customer owner requests this exact non-secret policy');
    await checkThenMfa(owner);
    await record(owner);
    const current = await context(owner);
    expect(current.rows[0]!.head.state).toBe('requested');
    expect(current.history).toHaveLength(1);
    expect(current.history[0]!.actorId).toBe(owner.who.id);
    expect(await ledger(owner)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_type: 'custody.local_policy_requested',
          actor_id: owner.who.id,
          input_hash: current.history[0]!.requestSha256,
          output_hash: manifest.policySha256,
          entry_hash: current.history[0]!.receipt.entryHash,
        }),
      ]),
    );
  });
  test('live internal founder approves the retained exact owner request', async () => {
    await signIn(founder);
    await expect(
      article(founder).getByRole('button', { name: 'Prepare activate', exact: true }),
    ).toHaveCount(0);
    await prepare(founder, 'approve', 'Founder approves the exact customer-owner request');
    await checkThenMfa(founder);
    await record(founder);
    const current = await context(founder);
    expect(current.rows[0]!.head.state).toBe('approved');
    expect(current.history).toHaveLength(2);
    expect(current.history[0]!.actorId).toBe(founder.who.id);
    expect(current.history[0]!.previousEventId).toBe(current.history[1]!.eventId);
  });
  test('only the nominated live operator activates; overdue review remains a reminder', async () => {
    await signIn(operator);
    await expect(
      operator.page.getByRole('button', { name: 'Prepare owner request', exact: true }),
    ).toHaveCount(0);
    await prepare(
      operator,
      'activate',
      'Nominated internal operator activates dispatch-key policy',
    );
    await checkThenMfa(operator);
    await record(operator);
    const current = await context(operator);
    expect(current.rows[0]!.head.state).toBe('active');
    expect(current.rows[0]!.reviewOverdue).toBe(true);
    expect(current.history).toHaveLength(3);
    expect(current.history[0]!.actorId).toBe(operator.who.id);
    await expect(article(operator)).toContainText(
      'Periodic review overdue; authority remains valid until revoked.',
    );
    await expect(
      operator.page.getByText(
        'No action here grants storage access, report release, or agent write credentials.',
        { exact: false },
      ),
    ).toBeVisible();
  });
  test('stale intent resolves with fresh-MFA cancellation after committed response loss and reload', async () => {
    await owner.page.goto(path);
    const original = await prepare(
      owner,
      'review',
      'Owner review retained before a competing review',
    );
    await founder.page.goto(path);
    await prepare(founder, 'review', 'Founder records a newer legitimate review');
    await checkThenMfa(founder);
    await record(founder);
    const headBefore = await context(owner),
      ledgerBefore = await ledger(owner);
    await owner.page.getByRole('button', { name: 'Check retained request', exact: true }).click();
    await expect(owner.page.getByRole('status')).toContainText('No positive receipt was found');
    await owner.page
      .getByLabel(
        'I reviewed this exact retained request and authorize its retry with fresh MFA.',
        { exact: true },
      )
      .check();
    const stale = owner.page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === '/api/bff/v1/local-custody-policy/challenge' &&
        r.request().method() === 'POST',
    );
    await owner.page
      .getByRole('button', { name: 'Request authenticator challenge', exact: true })
      .click();
    expect((await stale).status()).toBe(503);
    expect(await snapshot(owner)).toEqual(original);
    await owner.page.getByRole('button', { name: 'Check retained request', exact: true }).click();
    await expect(owner.page.getByRole('status')).toContainText('No positive receipt was found');
    await owner.page
      .getByLabel('Cancellation reason', { exact: true })
      .fill('Abandon the exact stale review; preserve its history');
    await owner.page
      .getByLabel(
        'I request recorded cancellation of this exact unresolved intent, with fresh MFA.',
        { exact: true },
      )
      .check();
    await owner.page
      .getByRole('button', { name: 'Prepare recorded cancellation', exact: true })
      .click();
    const linked = await snapshot(owner);
    expect(Object.keys(linked)).toHaveLength(2);
    for (const [key, value] of Object.entries(original)) expect(linked[key]).toBe(value);
    const resolution = JSON.parse(
      Object.entries(linked).find(([key]) => key.startsWith(resolutionPrefix(owner.who.id)))![1],
    ).resolution;
    let custodyPosts = 0;
    const custodyRecoveries: Array<{
      body: unknown;
      tenantId: string | undefined;
      actorId: string | undefined;
      operationKey: string | undefined;
    }> = [];
    const countCustodyPosts = (request: import('@playwright/test').Request) => {
      if (
        request.method() === 'POST' &&
        new URL(request.url()).pathname.startsWith('/api/bff/v1/local-custody-policy/')
      ) {
        custodyPosts++;
        if (new URL(request.url()).pathname === '/api/bff/v1/local-custody-policy/recover') {
          const headers = request.headers();
          custodyRecoveries.push({
            body: request.postDataJSON(),
            tenantId: headers['x-tenant-id'],
            actorId: headers['x-expected-actor-id'],
            operationKey: headers['idempotency-key'],
          });
        }
      }
    };
    owner.page.on('request', countCustodyPosts);
    await owner.page.reload();
    expect(await snapshot(owner)).toEqual(linked);
    await expect(
      owner.page.getByRole('button', { name: 'Check retained cancellation', exact: true }),
    ).toBeEnabled();
    expect(custodyPosts).toBe(0);
    let verifiedChallenge: string | undefined;
    const observeVerifiedChallenge = (response: import('@playwright/test').Response) => {
      if (
        new URL(response.url()).pathname !== '/api/bff/v1/local-custody-policy/verify' ||
        response.request().method() !== 'POST' ||
        response.status() !== 200
      )
        return;
      try {
        verifiedChallenge = z.uuid().parse(response.request().postDataJSON().challengeId);
      } catch {
        /* fixed match bit only */
      }
    };
    owner.page.on('response', observeVerifiedChallenge);
    try {
      await checkThenMfa(owner, true);
    } finally {
      owner.page.off('response', observeVerifiedChallenge);
    }
    let committed: z.infer<typeof localCustodyCancellationReceiptSchema> | null = null;
    let recordRequests = 0,
      completedFetches = 0;
    let resolveRecord!: () => void, rejectRecord!: (error: unknown) => void;
    const recordCompleted = new Promise<void>((resolve, reject) => {
      resolveRecord = resolve;
      rejectRecord = reject;
    });
    // Attach immediately: the explicit await below still throws the SAME primary
    // handler error, without an unhandled rejection or a secondary null race.
    void recordCompleted.catch(() => undefined);
    const route = '**/api/bff/v1/local-custody-policy/record';
    await owner.page.route(route, async (intercepted) => {
      recordRequests++;
      let actual: import('@playwright/test').APIResponse | undefined;
      let body: { resolution: unknown; challengeId: string } | undefined;
      try {
        body = z
          .object({ resolution: z.unknown(), challengeId: z.uuid() })
          .strict()
          .parse(intercepted.request().postDataJSON());
        actual = await intercepted.fetch();
        completedFetches++;
        expect(actual.status()).toBe(201);
        committed = localCustodyCancellationReceiptSchema.parse((await actual.json()).data);
        expect(committed.cancellationText).toBe(encodeLocalCustodyCancellation(body.resolution));
        await intercepted.abort('failed');
        resolveRecord();
      } catch (error) {
        try {
          const request = intercepted.request(),
            headers = request.headers();
          let sameResolution = false;
          try {
            sameResolution =
              encodeLocalCustodyCancellation(body?.resolution) ===
              encodeLocalCustodyCancellation(resolution);
          } catch {
            /* only equality */
          }
          retainCustodyRecordFailure(process.env.AXIOM_EVIDENCE_FIXTURE_DIRECTORY!, {
            version: 1,
            kind: 'custody-cancellation-record-failure',
            status: actual?.status() ?? null,
            ...custodyRecordResponse(actual ? await actual.body().catch(() => null) : null),
            recordRequests,
            completedFetches,
            matches: {
              tenant: headers['x-tenant-id'] === tenant.id,
              actor: headers['x-expected-actor-id'] === owner.who.id,
              operationKey: headers['idempotency-key'] === resolution.operationKey,
              resolution: sameResolution,
              challenge: verifiedChallenge !== undefined && body?.challengeId === verifiedChallenge,
              requestOrigin: new URL(request.url()).origin === webOrigin,
              responseOrigin: actual !== undefined && new URL(actual.url()).origin === webOrigin,
              responsePath:
                actual !== undefined &&
                new URL(actual.url()).pathname === '/api/bff/v1/local-custody-policy/record',
            },
          });
        } catch {
          /* Private diagnostic IO must not replace the primary failure. */
        }
        await intercepted.abort('failed').catch(() => undefined);
        rejectRecord(error);
      }
    });
    try {
      await owner.page
        .getByRole('button', { name: 'Record exact cancellation', exact: true })
        .click();
      await recordCompleted;
      // The application alert is a paragraph; Next also mounts a global
      // route-announcer alert. Inspect the app error without matching both.
      await expect(owner.page.locator('p[role="alert"]')).toBeVisible();
    } finally {
      await owner.page.unroute(route);
    }
    expect(committed).not.toBeNull();
    expect(await snapshot(owner)).toEqual(linked);
    const postsBeforeReload = custodyPosts;
    await owner.page.reload();
    await expect(
      owner.page.getByRole('button', { name: 'Check retained cancellation', exact: true }),
    ).toBeEnabled();
    expect(custodyPosts).toBe(postsBeforeReload);
    const recoveriesBeforeCheck = custodyRecoveries.length;
    await owner.page
      .getByRole('button', { name: 'Check retained cancellation', exact: true })
      .click();
    await expect(owner.page.getByRole('status')).toContainText('Cancellation receipt confirmed');
    expect(await snapshot(owner)).toEqual({});
    // Explicit recovery is a read-only POST. It must be the sole POST since
    // reload: no automatic challenge, verify, or record is permitted.
    expect(custodyPosts).toBe(postsBeforeReload + 1);
    expect(custodyRecoveries.slice(recoveriesBeforeCheck)).toEqual([
      {
        body: { resolution },
        tenantId: tenant.id,
        actorId: owner.who.id,
        operationKey: resolution.operationKey,
      },
    ]);
    owner.page.off('request', countCustodyPosts);
    const after = await context(owner);
    expect(after.rows[0]!.head).toEqual(headBefore.rows[0]!.head);
    expect(after.history).toEqual(headBefore.history);
    const entries = await ledger(owner);
    expect(entries).toHaveLength(ledgerBefore.length + 1);
    const receipt = localCustodyCancellationReceiptSchema.parse(committed);
    expect(entries[0]).toMatchObject({
      actor_type: 'human',
      actor_id: owner.who.id,
      action_type: 'custody.local_policy_intent_cancelled',
      correlation_id: receipt.operationKey,
      target_ref: receipt.cancellationId,
      input_hash: receipt.cancellationSha256,
      output_hash: receipt.originalRequestSha256,
      entry_hash: receipt.receipt.entryHash,
    });
    const replay = await owner.page.request.post('/api/bff/v1/local-custody-policy/recover', {
      headers: {
        'X-Tenant-Id': tenant.id,
        'X-Expected-Actor-Id': owner.who.id,
        'Idempotency-Key': resolution.operationKey,
      },
      data: { resolution },
    });
    expect(replay.status()).toBe(200);
    expect(localCustodyCancellationReceiptSchema.parse((await replay.json()).data)).toEqual({
      ...receipt,
      replayed: true,
    });
    expect(await ledger(owner)).toEqual(entries);
    await expect(
      article(owner).getByRole('button', { name: 'Prepare review', exact: true }),
    ).toBeEnabled();
    const verified = await owner.page.request.post('/api/bff/v1/ledger/verify', {
      headers: { 'X-Tenant-Id': tenant.id, 'Idempotency-Key': randomUUID() },
      data: {},
    });
    expect(verified.status()).toBe(200);
    expect(await verified.json()).toEqual({ intact: true });
  });
});
