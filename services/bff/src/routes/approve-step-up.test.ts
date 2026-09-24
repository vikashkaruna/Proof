import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { generateTotp } from '@axiom/mfa';
import { UserRole, Capability, rolesWith } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';

/**
 * W1 · SEC-8 · FR-7.3 — no approval token without a fresh, bound step-up.
 *
 * The service suite proves the challenge machinery. This proves the thing the
 * plan actually promises: that `POST /v1/plans/approve` cannot issue a signed
 * token unless the caller has just re-authenticated *for this approval*.
 *
 * It exercises the real route with a real MFA service over a real (in-memory)
 * store, so the assertions are about behaviour rather than about which
 * functions were called.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '00000000-0000-4000-8000-0000000000aa';
const PLAN = '22222222-2222-4222-8222-222222222222';
const ACTION_A = '33333333-3333-4333-8333-33333333000a';
const ACTION_B = '33333333-3333-4333-8333-33333333000b';

const db = vi.hoisted(() => ({ current: null as FakeDb | null }));

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SUPABASE_URL = 'https://local.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'a'.repeat(40);
  process.env.SUPABASE_SERVICE_KEY = 'b'.repeat(40);
  process.env.APPROVAL_SIGNING_KEY = 'k'.repeat(48);
});

vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));
vi.mock('@axiom/supabase', () => ({
  createSupabaseAdmin: () => {
    if (!db.current) throw new Error('fake db not installed');
    return db.current.client;
  },
}));

const KEY = 'route-test-encryption-key-at-least-32-chars';
const T0 = Date.UTC(2026, 8, 20, 12, 0, 0);
const STEP = 30_000;

let fake: FakeDb;
let mfa: Awaited<ReturnType<typeof buildMfa>>;
let ledgerAppend: ReturnType<typeof vi.fn>;

async function buildMfa() {
  const { createMfaService } = await import('../services/mfa.js');
  return createMfaService(() => fake.client as never, { encryptionKey: KEY });
}

/** An approvable plan: dry-run complete, rollback validated, nothing stale. */
function seedApprovablePlan() {
  fake.seed('remediation_plans', {
    id: PLAN,
    tenant_id: TENANT,
    status: 'review',
    version: 1,
    library_version: '0.1.1',
  });
  for (const id of [ACTION_A, ACTION_B]) {
    fake.seed('remediation_actions', {
      id,
      tenant_id: TENANT,
      plan_id: PLAN,
      action_type: 'data.mask',
      dry_run_status: 'dry_run_complete',
      rollback_validated: true,
      dry_run_expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
  }
}

async function buildApp(role: UserRole = UserRole.APPROVER) {
  const { v1Routes } = await import('./v1.js');

  ledgerAppend = vi.fn(async () => ({ sequenceNo: 1, entryHash: 'hash' }));

  const routes = v1Routes({
    approvalEngine: {
      verify: async () => ({ valid: true }),
      isActionCovered: () => true,
      markNonceUsed: vi.fn(),
      issue: async (_tenantId: string, input: Record<string, unknown>) => ({
        signature: 'sig',
        spec: { ...input, nonce: 'nonce-1' },
      }),
    } as never,
    killSwitch: { isActive: async () => false } as never,
    ledger: { append: ledgerAppend } as never,
    mfa: mfa as never,
    realtime: { broadcast: vi.fn() } as never,
  });

  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: USER, email: 'approver@example.com' } as never);
    c.set('tenantId', TENANT as never);
    c.set('role', role);
    c.set('approvalScopes', [] as never);
    c.set('idempotencyKey', 'idem-1' as never);
    await next();
  });
  app.route('/v1', routes);
  return app;
}

function approveBody(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    planId: PLAN,
    actionIds: [ACTION_A, ACTION_B],
    mode: 'batch',
    ...extra,
  });
}

const post = (app: Hono<{ Variables: Variables }>, path: string, body: string) =>
  app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

/** Enrol, open an approval challenge, satisfy it. Returns the challenge id. */
async function freshStepUp(app: Hono<{ Variables: Variables }>, actionIds = [ACTION_A, ACTION_B]) {
  const begun = await mfa.beginTotpEnrolment({ userId: USER, accountName: 'a@example.com' });
  const activated = await mfa.activateTotpEnrolment({
    userId: USER,
    code: generateTotp(begun.secret, T0),
    atMs: T0,
  });
  if (!activated.ok) throw new Error('enrolment failed');

  const challengeRes = await post(
    app,
    '/v1/mfa/challenge',
    JSON.stringify({ purpose: 'approval_issuance', planId: PLAN, actionIds, mode: 'batch' }),
  );
  expect(challengeRes.status).toBe(201);
  const { challengeId } = (await challengeRes.json()) as { challengeId: string };

  const verified = await mfa.verifyChallenge({
    challengeId,
    userId: USER,
    code: generateTotp(begun.secret, T0 + STEP),
    atMs: T0 + STEP,
  });
  expect(verified.ok).toBe(true);
  return challengeId;
}

beforeEach(async () => {
  vi.resetModules();
  fake = createFakeDb({});
  db.current = fake;
  seedApprovablePlan();
  mfa = await buildMfa();
});

describe('POST /v1/plans/approve — MFA step-up', () => {
  it('refuses to issue a token when no challenge is presented', async () => {
    const app = await buildApp();
    await freshStepUp(app); // enrolled, but the approve call omits the id

    const res = await post(app, '/v1/plans/approve', approveBody());
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('mfa_challenge_required');
    expect(fake.rows('approval_tokens')).toHaveLength(0);
  });

  it('tells an unenrolled approver to enrol rather than to authenticate', async () => {
    const app = await buildApp();
    const res = await post(app, '/v1/plans/approve', approveBody());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('mfa_enrolment_required');
    expect(fake.rows('approval_tokens')).toHaveLength(0);
  });

  it('issues a token when a satisfied, correctly bound challenge is presented', async () => {
    const app = await buildApp();
    const challengeId = await freshStepUp(app);

    const res = await post(app, '/v1/plans/approve', approveBody({ mfaChallengeId: challengeId }));
    expect(res.status).toBe(201);
    expect(fake.rows('approval_tokens')).toHaveLength(1);

    // The challenge is spent, and points at the token it authorised.
    const challenge = fake.rows('mfa_challenges').find((r) => r.id === challengeId);
    expect(challenge?.consumed_at).toBeTruthy();
    expect(challenge?.consumed_for).toBe(fake.rows('approval_tokens')[0]?.id);
  });

  it('records the step-up in the ledger entry for the approval', async () => {
    const app = await buildApp();
    const challengeId = await freshStepUp(app);
    await post(app, '/v1/plans/approve', approveBody({ mfaChallengeId: challengeId }));

    // Migration 0026 moved this write INTO the issuing transaction, so the
    // entry is in the ledger table rather than in a call the route made
    // afterwards. That is the point of the change: the previous shape could
    // issue a live token and then fail to record who granted it.
    const issued = fake
      .rows('audit_ledger')
      .find((entry) => entry['action_type'] === 'approval.token.issued') as
      { detail?: Record<string, unknown>; approval_token_id?: string } | undefined;

    expect(issued, 'the issuing transaction must have written a ledger entry').toBeTruthy();
    expect(issued?.approval_token_id).toBe(fake.rows('approval_tokens')[0]?.['id']);

    // FR-7.3: the approver's identity claim has to be more than "a session
    // cookie was present", and the evidence for that lives in the chain.
    expect(issued?.detail?.mfa).toMatchObject({ challengeId });
    expect((issued?.detail?.mfa as { satisfiedAt: string }).satisfiedAt).toBeTruthy();
    // And the exact content that was approved, so a later diff has something
    // to compare against.
    expect(issued?.detail?.contentDigest).toEqual(expect.any(String));
  });

  it('will not let one step-up authorise a second approval', async () => {
    const app = await buildApp();
    const challengeId = await freshStepUp(app);

    expect(
      (await post(app, '/v1/plans/approve', approveBody({ mfaChallengeId: challengeId }))).status,
    ).toBe(201);

    const second = await post(
      app,
      '/v1/plans/approve',
      approveBody({ mfaChallengeId: challengeId }),
    );
    expect(second.status).toBe(401);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe(
      'challenge_already_consumed',
    );
    expect(fake.rows('approval_tokens')).toHaveLength(1);
  });

  it('refuses a step-up satisfied for a different action set', async () => {
    const app = await buildApp();
    // Satisfied for {A} alone; spent against {A, B}.
    const challengeId = await freshStepUp(app, [ACTION_A]);

    const res = await post(app, '/v1/plans/approve', approveBody({ mfaChallengeId: challengeId }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('binding_mismatch');
    expect(fake.rows('approval_tokens')).toHaveLength(0);
  });

  it('ledgers a refused step-up, so a run of them is visible to a reviewer', async () => {
    const app = await buildApp();
    const challengeId = await freshStepUp(app, [ACTION_A]);
    await post(app, '/v1/plans/approve', approveBody({ mfaChallengeId: challengeId }));

    const failures = ledgerAppend.mock.calls
      .map(([arg]) => arg as { actionType: string })
      .filter((entry) => entry.actionType === 'mfa.challenge.failed');
    expect(failures.length).toBeGreaterThan(0);
  });

  it('does not spend the challenge when the approval fails for an unrelated reason', async () => {
    const app = await buildApp();
    const challengeId = await freshStepUp(app);

    // An action that is not eligible — the request fails before the step-up.
    fake.rows('remediation_actions').find((r) => r.id === ACTION_B)!.rollback_validated = false;

    const res = await post(app, '/v1/plans/approve', approveBody({ mfaChallengeId: challengeId }));
    expect(res.status).toBe(422);

    const challenge = fake.rows('mfa_challenges').find((r) => r.id === challengeId);
    expect(challenge?.consumed_at).toBeFalsy();
  });
});

// A valid factor cannot rescue missing/stale safety evidence. These denials
// precede token consumption and runtime dispatch.
describe('dry-run expiry at both safety gates', () => {
  it.each([null, 'not-a-date', '2000-01-01T00:00:00.000Z'])(
    'refuses approval with expiry %s',
    async (expiry) => {
      fake.rows('remediation_actions')[0]!.dry_run_expires_at = expiry;
      const app = await buildApp();
      const response = await post(app, '/v1/plans/approve', approveBody());
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: { code: 'dry_run_expired' } });
      expect(fake.rows('approval_tokens')).toHaveLength(0);
    },
  );
  it('refuses execution settings that differ from the ones that were signed', async () => {
    // R-08: `concurrency` and `stopOnFailure` are inside the signed spec, and
    // the execute path took them from the REQUEST. An approver could sign
    // "one at a time, stop on first failure" while the caller ran twenty at
    // once ignoring failures — on the same token. The signature covered
    // settings nobody enforced, which is worse than not signing them.
    for (const action of fake.rows('remediation_actions')) {
      action.approval_status = 'approved';
      action.dry_run_expires_at = new Date(Date.now() + 3_600_000).toISOString();
    }
    fake.seed('approval_tokens', {
      id: '44444444-4444-4444-8444-44444444aaaa',
      tenant_id: TENANT,
      plan_id: PLAN,
      action_ids: [ACTION_A, ACTION_B],
      signature: 'sig',
      nonce: 'nonce-settings',
      status: 'issued',
    });

    const app = await buildApp(UserRole.OWNER);
    const response = await post(
      app,
      `/v1/plans/${PLAN}/execute`,
      JSON.stringify({
        planId: PLAN,
        actionIds: [ACTION_A, ACTION_B],
        mode: 'batch',
        concurrency: 20,
        stopOnFailure: false,
        approvalToken: JSON.stringify({
          signature: 'sig',
          spec: {
            planId: PLAN,
            actionIds: [ACTION_A, ACTION_B],
            nonce: 'nonce-settings',
            mode: 'batch',
            concurrency: 1,
            stopOnFailure: true,
          },
        }),
      }),
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      error: { code: string; details: { conflicting: string[] } };
    };
    expect(body.error.code).toBe('execution_settings_mismatch');
    expect(body.error.details.conflicting.sort()).toEqual(['concurrency', 'stopOnFailure']);
    // Refused before the token was spent.
    expect(fake.rows('approval_tokens').find((t) => t.nonce === 'nonce-settings')!.status).toBe(
      'issued',
    );
  });

  it('permits execution settings that match the signed spec', async () => {
    for (const action of fake.rows('remediation_actions')) {
      action.approval_status = 'approved';
      action.dry_run_expires_at = new Date(Date.now() + 3_600_000).toISOString();
    }
    fake.seed('approval_tokens', {
      id: '44444444-4444-4444-8444-44444444bbbb',
      tenant_id: TENANT,
      plan_id: PLAN,
      action_ids: [ACTION_A, ACTION_B],
      signature: 'sig',
      nonce: 'nonce-match',
      status: 'issued',
    });

    const app = await buildApp(UserRole.OWNER);
    const response = await post(
      app,
      `/v1/plans/${PLAN}/execute`,
      JSON.stringify({
        planId: PLAN,
        actionIds: [ACTION_A, ACTION_B],
        mode: 'batch',
        concurrency: 1,
        stopOnFailure: true,
        approvalToken: JSON.stringify({
          signature: 'sig',
          spec: {
            planId: PLAN,
            actionIds: [ACTION_A, ACTION_B],
            nonce: 'nonce-match',
            mode: 'batch',
            concurrency: 1,
            stopOnFailure: true,
          },
        }),
      }),
    );

    expect(response.status).not.toBe(409);
  });

  it.each([null, 'not-a-date', '2000-01-01T00:00:00.000Z'])(
    'refuses execution with expiry %s without consuming the token',
    async (expiry) => {
      for (const action of fake.rows('remediation_actions')) {
        action.approval_status = 'approved';
        action.dry_run_expires_at = expiry;
      }
      fake.seed('approval_tokens', {
        id: '44444444-4444-4444-8444-444444444444',
        tenant_id: TENANT,
        plan_id: PLAN,
        action_ids: [ACTION_A, ACTION_B],
        signature: 'sig',
        nonce: 'nonce-execute',
        status: 'issued',
      });
      const app = await buildApp(UserRole.OWNER);
      const response = await post(
        app,
        `/v1/plans/${PLAN}/execute`,
        JSON.stringify({
          planId: PLAN,
          actionIds: [ACTION_A, ACTION_B],
          mode: 'batch',
          approvalToken: JSON.stringify({
            signature: 'sig',
            spec: { planId: PLAN, actionIds: [ACTION_A, ACTION_B], nonce: 'nonce-execute' },
          }),
        }),
      );
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        acceptedActionIds: [],
        rejectedActionIds: [
          { actionId: ACTION_A, reason: 'dry_run_expired' },
          { actionId: ACTION_B, reason: 'dry_run_expired' },
        ],
      });
      expect(fake.rows('approval_tokens')[0]!.status).toBe('issued');
    },
  );
});

/**
 * W1 · R-08 — the step-up binds the action CONTENT, not only its id.
 *
 * `planVersion` closed the case where the plan was revised. It cannot close
 * the case where the version never moves and an action is rewritten in place,
 * and that window is wide open by design: `trg_actions_approved_immutable`
 * only locks an action's definition once `approval_status` is already
 * approved/executing/succeeded, so everything the approver is reading stays
 * writable right up until the approval lands.
 *
 * Each test here edits an action AFTER the challenge has been satisfied — the
 * exact moment the approver has already decided — and requires the approval to
 * be refused with nothing issued.
 */
describe('POST /v1/plans/approve — the binding covers action content', () => {
  /** Satisfy a challenge, then mutate action A the way an attacker would. */
  async function stepUpThenEdit(
    app: Hono<{ Variables: Variables }>,
    edit: (row: Record<string, unknown>) => void,
  ) {
    const challengeId = await freshStepUp(app);
    const row = fake.rows('remediation_actions').find((r) => r.id === ACTION_A);
    expect(row, 'action A should be seeded').toBeTruthy();
    edit(row as Record<string, unknown>);
    return post(app, '/v1/plans/approve', approveBody({ mfaChallengeId: challengeId }));
  }

  it.each([
    [
      'parameters rewritten after review',
      (row: Record<string, unknown>) => {
        row.parameters = { columns: ['email', 'phone', 'aadhaar'], scope: 'all_records' };
      },
    ],
    [
      'the rollback definition swapped for an empty one',
      (row: Record<string, unknown>) => {
        row.rollback_definition = {};
      },
    ],
    [
      'the dry-run diff replaced with a different simulated outcome',
      (row: Record<string, unknown>) => {
        row.dry_run_result = { recordsAffected: 4_000_000, systems: ['crm', 'warehouse'] };
      },
    ],
    [
      'the action retyped entirely',
      (row: Record<string, unknown>) => {
        row.action_type = 'data.delete';
      },
    ],
    [
      'a different finding claimed as the justification',
      (row: Record<string, unknown>) => {
        row.closes_finding_ids = ['44444444-4444-4444-8444-444444444444'];
      },
    ],
  ])('refuses the approval when %s', async (_label, edit) => {
    const app = await buildApp();
    const res = await stepUpThenEdit(app, edit);

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('binding_mismatch');
    // The decisive assertion: no signed authority came out of this.
    expect(fake.rows('approval_tokens')).toHaveLength(0);
  });

  it('still approves when nothing changed, so the digest is not simply refusing everything', async () => {
    const app = await buildApp();
    const res = await stepUpThenEdit(app, () => {
      /* no edit */
    });
    expect(res.status).toBe(201);
    expect(fake.rows('approval_tokens')).toHaveLength(1);
  });

  it('is unmoved by a reordering of closes_finding_ids, which is a set', async () => {
    const app = await buildApp();
    const f1 = '44444444-4444-4444-8444-44444444000f';
    const f2 = '44444444-4444-4444-8444-44444444000e';
    const row = fake.rows('remediation_actions').find((r) => r.id === ACTION_A)!;
    row.closes_finding_ids = [f1, f2];

    const res = await stepUpThenEdit(app, (r) => {
      r.closes_finding_ids = [f2, f1];
    });
    expect(res.status).toBe(201);
  });

  it('refuses when an action is edited between the challenge and a RETRY of the approval', async () => {
    // The first approval fails for an unrelated reason, the caller fixes it and
    // retries with the same challenge — and the content moved in between. A
    // challenge is single-use, so this must not be the way back in.
    const app = await buildApp();
    const challengeId = await freshStepUp(app);

    const first = await post(
      app,
      '/v1/plans/approve',
      approveBody({ mfaChallengeId: challengeId }),
    );
    expect(first.status).toBe(201);

    const row = fake.rows('remediation_actions').find((r) => r.id === ACTION_B)!;
    row.parameters = { scope: 'everything' };

    const second = await post(
      app,
      '/v1/plans/approve',
      approveBody({ mfaChallengeId: challengeId }),
    );
    expect(second.status).toBe(401);
    expect(fake.rows('approval_tokens')).toHaveLength(1);
  });

  it('refuses a plan revision changed after MFA consumption', async () => {
    const app = await buildApp();
    const challengeId = await freshStepUp(app);
    const consume = mfa.consumeChallenge.bind(mfa);
    vi.spyOn(mfa, 'consumeChallenge').mockImplementation(async (opts) => {
      const result = await consume(opts);
      fake.rows('remediation_plans')[0]!.version = 2;
      return result;
    });
    const res = await post(app, '/v1/plans/approve', approveBody({ mfaChallengeId: challengeId }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'plan_changed' } });
    expect(fake.rows('approval_tokens')).toHaveLength(0);
  });

  it.each(['parameters', 'dry_run_result'])(
    'refuses %s edited after MFA consumption but before digest acquisition',
    async (field) => {
      const app = await buildApp();
      const challengeId = await freshStepUp(app);
      const consume = mfa.consumeChallenge.bind(mfa);
      vi.spyOn(mfa, 'consumeChallenge').mockImplementation(async (opts) => {
        const result = await consume(opts);
        fake.rows('remediation_actions').find((row) => row.id === ACTION_A)![field] = {
          changed: true,
        };
        return result;
      });
      const res = await post(
        app,
        '/v1/plans/approve',
        approveBody({ mfaChallengeId: challengeId }),
      );
      expect(res.status).toBe(409);
      expect(fake.rows('approval_tokens')).toHaveLength(0);
      expect(fake.rows('audit_ledger')).toHaveLength(0);
    },
  );

  it('refuses at the database when content moves after the route has read it', async () => {
    // The window the step-up binding cannot see. The route verifies the
    // binding, then reads the content, then writes — and anything with update
    // rights can change an action in between. Migration 0026 recomputes the
    // digest under the row locks, so the issuing transaction refuses.
    //
    // Simulated by making the digest the route reads disagree with the one the
    // issuing function computes, which is exactly what a concurrent edit does.
    const app = await buildApp();
    const challengeId = await freshStepUp(app);
    fake.onRpc('reviewed_action_content_digest', () => 'digest-from-before-the-edit');

    const res = await post(app, '/v1/plans/approve', approveBody({ mfaChallengeId: challengeId }));

    expect(res.status).toBe(409);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'content_changed' },
    });
    // The decisive part: no signed authority came out of it, and nothing was
    // half-written.
    expect(fake.rows('approval_tokens')).toHaveLength(0);
    expect(fake.rows('remediation_actions').every((a) => a['approval_status'] !== 'approved')).toBe(
      true,
    );
    expect(
      fake.rows('audit_ledger').some((e) => e['action_type'] === 'approval.token.issued'),
    ).toBe(false);
  });

  it('refuses a challenge raised for an action that does not exist', async () => {
    // Otherwise the digest is computed over a smaller set than the one being
    // approved, and the missing action rides in unbound.
    const app = await buildApp();
    const res = await post(
      app,
      '/v1/mfa/challenge',
      JSON.stringify({
        purpose: 'approval_issuance',
        planId: PLAN,
        actionIds: [ACTION_A, '33333333-3333-4333-8333-3333333900ff'],
        mode: 'batch',
      }),
    );
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'actions_not_found' },
    });
  });
});

describe('execution capability boundary', () => {
  it.each(
    Object.values(UserRole).filter((role) => !rolesWith(Capability.PLAN_EXECUTE).includes(role)),
  )('refuses %s before processing an execution token', async (role) => {
    const app = await buildApp(role);
    const response = await post(app, `/v1/plans/${PLAN}/execute`, '{}');
    expect(response.status).toBe(403);
    expect(ledgerAppend).not.toHaveBeenCalled();
  });
});
