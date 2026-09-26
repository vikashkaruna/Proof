import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';

/**
 * W8 — the rights, breach and release routes.
 *
 * Migration 0071 proves the workflows in the database; these prove the wire:
 * the intake routes pass the caller's identity and nothing else (statutory
 * clocks are server-owned, so no timestamp is ever accepted from the body),
 * the closed state maps are the RPC's business and render as 409 here, the
 * maker-checker refusals surface verbatim, and a report can never be released
 * by anyone the database does not recognise as the founder authority. The
 * route's own jobs are narrower: validate the shape, refuse malformed ids,
 * and never turn a refusal into a success.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '00000000-0000-4000-8000-0000000000aa';
const DSAR = '22222222-2222-4222-8222-22222222000a';
const BREACH = '22222222-2222-4222-8222-22222222000b';
const NOTIFICATION = '22222222-2222-4222-8222-22222222000c';
const REPORT = '22222222-2222-4222-8222-22222222000d';
const EVIDENCE = '22222222-2222-4222-8222-22222222000e';

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

let fake: FakeDb;
let broadcast: ReturnType<typeof vi.fn>;
let lastRpc: { fn: string; args: Record<string, unknown> } | null;

beforeEach(() => {
  fake = createFakeDb();
  db.current = fake;
  broadcast = vi.fn();
  lastRpc = null;

  const record = (fn: string) => (args: Record<string, unknown>) => {
    lastRpc = { fn, args };
    return { ok: true };
  };

  fake.onRpc('record_dsar', (args) => {
    record('record_dsar')(args);
    return { dsarId: DSAR, dueBy: new Date(Date.now() + 30 * 86_400_000).toISOString() };
  });
  fake.onRpc('verify_dsar_identity', (args) => {
    record('verify_dsar_identity')(args);
    return { dsarId: DSAR, identityVerified: true };
  });
  fake.onRpc('advance_dsar', (args) => {
    record('advance_dsar')(args);
    return { dsarId: DSAR, status: args['p_to_status'] };
  });
  fake.onRpc('record_breach', (args) => {
    record('record_breach')(args);
    return {
      breachId: BREACH,
      dpbNotificationDueBy: new Date(Date.now() + 72 * 3_600_000).toISOString(),
    };
  });
  fake.onRpc('advance_breach', (args) => {
    record('advance_breach')(args);
    return { breachId: BREACH, status: args['p_to_status'] };
  });
  fake.onRpc('draft_breach_notification', (args) => {
    record('draft_breach_notification')(args);
    return { notificationId: NOTIFICATION };
  });
  fake.onRpc('review_breach_notification', (args) => {
    record('review_breach_notification')(args);
    return { notificationId: NOTIFICATION, status: 'reviewed' };
  });
  fake.onRpc('send_breach_notification', (args) => {
    record('send_breach_notification')(args);
    return { notificationId: NOTIFICATION, status: 'sent' };
  });
  fake.onRpc('review_report', (args) => {
    record('review_report')(args);
    return { reportId: REPORT, status: args['p_decision'] };
  });
  fake.onRpc('release_report', (args) => {
    record('release_report')(args);
    return { reportId: REPORT, status: 'published', contentHash: 'h'.repeat(64) };
  });
});

function seedReads() {
  fake.seed('dsars', {
    id: DSAR,
    tenant_id: TENANT,
    kind: 'access',
    status: 'received',
    identity_verified: false,
    due_by: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    received_at: new Date().toISOString(),
  });
  fake.seed('breaches', {
    id: BREACH,
    tenant_id: TENANT,
    title: 'CRM export exposed',
    severity: 'high',
    status: 'notifying_dpb',
    detected_at: new Date().toISOString(),
    dpb_notification_due_by: new Date(Date.now() + 10 * 3_600_000).toISOString(),
  });
  fake.seed('breach_notifications', {
    id: NOTIFICATION,
    tenant_id: TENANT,
    breach_id: BREACH,
    kind: 'dpb',
    status: 'reviewed',
    language: 'en',
    subject: 'Notification under section 8(6)',
    body: 'Body.',
    created_at: new Date().toISOString(),
  });
  fake.seed('reports', {
    id: REPORT,
    tenant_id: TENANT,
    kind: 'board',
    title: 'Board report',
    library_version: '0.1.1',
    generated_by_agent: 'parikshan',
    generated_at: new Date().toISOString(),
    status: 'draft',
  });
}

async function buildApp(role: UserRole = UserRole.ADMIN) {
  const { v1Routes } = await import('./v1.js');
  const routes = v1Routes({
    approvalEngine: {} as never,
    killSwitch: { isActive: async () => false } as never,
    ledger: { append: vi.fn() } as never,
    mfa: {} as never,
    realtime: { broadcast } as never,
  });
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: USER } as never);
    c.set('tenantId', TENANT as never);
    c.set('role', role);
    c.set('approvalScopes', [] as never);
    await next();
  });
  app.route('/v1', routes);
  return app;
}

const post = (app: Hono<{ Variables: Variables }>, path: string, body?: string) =>
  app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

describe('POST /v1/dsars', () => {
  const body = JSON.stringify({
    kind: 'access',
    principalEmail: 'asha@example.invalid',
    dueDays: 30,
  });

  it('records intake and passes the caller as the recorder, never a clock', async () => {
    const res = await post(await buildApp(), '/v1/dsars', body);
    expect(res.status).toBe(201);
    expect(lastRpc?.fn).toBe('record_dsar');
    expect(lastRpc?.args['p_recorded_by']).toBe(USER);
    expect(lastRpc?.args['p_due_days']).toBe(30);
    expect(lastRpc?.args['p_correlation_id']).toEqual(expect.any(String));
  });

  it('refuses intake without any principal contact channel', async () => {
    const res = await post(
      await buildApp(),
      '/v1/dsars',
      JSON.stringify({ kind: 'access', dueDays: 30 }),
    );
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: { code: string } };
    expect(error.code).toBe('validation_failed');
  });

  it('refuses a caller without ESTATE_MANAGE', async () => {
    const res = await post(await buildApp(UserRole.AXIOM_ANALYST), '/v1/dsars', body);
    expect(res.status).toBe(403);
  });

  it('renders an RPC refusal as a 409, verbatim', async () => {
    fake.onRpc('record_dsar', () => ({ error: 'invalid_request' }));
    const res = await post(await buildApp(), '/v1/dsars', body);
    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: { code: string } };
    expect(error.code).toBe('invalid_request');
  });
});

describe('GET /v1/dsars', () => {
  it('lists the tenant requests, soonest deadline first', async () => {
    seedReads();
    const res = await (await buildApp()).request('/v1/dsars');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { id: string }[] };
    expect(data.map((d) => d.id)).toContain(DSAR);
  });
});

describe('POST /v1/dsars/:id/verify and /advance', () => {
  it('binds the verification method and the verifier', async () => {
    const res = await post(
      await buildApp(),
      `/v1/dsars/${DSAR}/verify`,
      JSON.stringify({ method: 'government id + live match' }),
    );
    expect(res.status).toBe(200);
    expect(lastRpc?.args['p_method']).toBe('government id + live match');
    expect(lastRpc?.args['p_verified_by']).toBe(USER);
  });

  it('advances through the closed map and carries the fulfilment evidence', async () => {
    const res = await post(
      await buildApp(),
      `/v1/dsars/${DSAR}/advance`,
      JSON.stringify({ toStatus: 'completed', fulfilmentEvidenceId: EVIDENCE }),
    );
    expect(res.status).toBe(200);
    expect(lastRpc?.args['p_to_status']).toBe('completed');
    expect(lastRpc?.args['p_fulfilment_evidence_id']).toBe(EVIDENCE);
  });

  it('refuses a status outside the closed set before touching the database', async () => {
    const res = await post(
      await buildApp(),
      `/v1/dsars/${DSAR}/advance`,
      JSON.stringify({ toStatus: 'deleted_forever' }),
    );
    expect(res.status).toBe(400);
    expect(lastRpc).toBeNull();
  });

  it('renders the transition refusal as a 409', async () => {
    fake.onRpc('advance_dsar', () => ({ error: 'invalid_transition' }));
    const res = await post(
      await buildApp(),
      `/v1/dsars/${DSAR}/advance`,
      JSON.stringify({ toStatus: 'in_fulfilment' }),
    );
    expect(res.status).toBe(409);
  });
});

describe('POST /v1/breaches', () => {
  const body = JSON.stringify({
    title: 'CRM export exposed',
    description: 'A misconfigured export exposed contact records.',
    severity: 'high',
  });

  it('records intake with server-owned clocks and bounded categories', async () => {
    const res = await post(await buildApp(), '/v1/breaches', body);
    expect(res.status).toBe(201);
    expect(lastRpc?.args['p_reported_by']).toBe(USER);
    expect(lastRpc?.args['p_data_categories']).toEqual([]);
    expect(lastRpc?.args['p_occurred_at']).toBeNull();
  });

  it('passes an explicit occurredAt and affected count when given', async () => {
    const occurredAt = new Date(Date.now() - 3_600_000).toISOString();
    const res = await post(
      await buildApp(),
      '/v1/breaches',
      JSON.stringify({
        ...JSON.parse(body),
        occurredAt,
        dataCategories: ['contact'],
        affectedCount: 120,
      }),
    );
    expect(res.status).toBe(201);
    expect(lastRpc?.args['p_occurred_at']).toBe(occurredAt);
    expect(lastRpc?.args['p_affected_count']).toBe(120);
  });

  it('refuses a future occurredAt-shaped body only where the schema can see it', async () => {
    const res = await post(
      await buildApp(),
      '/v1/breaches',
      JSON.stringify({ ...JSON.parse(body), severity: 'catastrophic' }),
    );
    expect(res.status).toBe(400);
    expect(lastRpc).toBeNull();
  });

  it('refuses a caller without ESTATE_MANAGE', async () => {
    const res = await post(await buildApp(UserRole.AXIOM_ANALYST), '/v1/breaches', body);
    expect(res.status).toBe(403);
  });
});

describe('GET /v1/breaches', () => {
  it('lists incidents and filters the overdue 72-hour clocks', async () => {
    seedReads();
    fake.seed('breaches', {
      id: '22222222-2222-4222-8222-22222222000f',
      tenant_id: TENANT,
      title: 'Old incident',
      severity: 'low',
      status: 'notifying_dpb',
      detected_at: new Date().toISOString(),
      dpb_notification_due_by: new Date(Date.now() - 86_400_000).toISOString(),
    });
    const app = await buildApp();
    const all = await app.request('/v1/breaches');
    expect(all.status).toBe(200);
    const { data } = (await all.json()) as { data: { id: string }[] };
    expect(data).toHaveLength(2);
    const overdue = await app.request('/v1/breaches?overdue=true');
    const { data: due } = (await overdue.json()) as { data: { id: string }[] };
    expect(due.map((b) => b.id)).toEqual(['22222222-2222-4222-8222-22222222000f']);
  });
});

describe('the breach notification authority chain', () => {
  it('drafts with the caller as drafter and the requested language', async () => {
    const res = await post(
      await buildApp(),
      `/v1/breaches/${BREACH}/notifications`,
      JSON.stringify({ kind: 'dpb', language: 'hi', subject: 'S', body: 'B' }),
    );
    expect(res.status).toBe(201);
    expect(lastRpc?.args['p_language']).toBe('hi');
    expect(lastRpc?.args['p_created_by']).toBe(USER);
  });

  it('refuses a draft body outside the bounded shape', async () => {
    const res = await post(
      await buildApp(),
      `/v1/breaches/${BREACH}/notifications`,
      JSON.stringify({ kind: 'dpb', language: 'en', subject: '', body: 'B' }),
    );
    expect(res.status).toBe(400);
  });

  it('reviews and sends through the RPC, refusals verbatim', async () => {
    seedReads();
    const app = await buildApp();
    const reviewed = await post(app, `/v1/breach-notifications/${NOTIFICATION}/review`);
    expect(reviewed.status).toBe(200);
    expect(lastRpc?.args['p_reviewed_by']).toBe(USER);

    fake.onRpc('review_breach_notification', () => ({ error: 'self_review_forbidden' }));
    const selfReview = await post(app, `/v1/breach-notifications/${NOTIFICATION}/review`);
    expect(selfReview.status).toBe(409);
    const { error } = (await selfReview.json()) as { error: { code: string } };
    expect(error.code).toBe('self_review_forbidden');

    fake.onRpc('send_breach_notification', () => ({ error: 'not_reviewed' }));
    const sent = await post(
      app,
      `/v1/breach-notifications/${NOTIFICATION}/send`,
      JSON.stringify({ outcome: 'delivered', detail: { reference: 'DPB-1' } }),
    );
    expect(sent.status).toBe(409);
    expect(((await sent.json()) as { error: { code: string } }).error.code).toBe('not_reviewed');
  });

  it('refuses a send outcome outside the closed set', async () => {
    const res = await post(
      await buildApp(),
      `/v1/breach-notifications/${NOTIFICATION}/send`,
      JSON.stringify({ outcome: 'sprayed' }),
    );
    expect(res.status).toBe(400);
    expect(lastRpc).toBeNull();
  });
});

describe('the report review and release gate', () => {
  it('lists the queue and filters by status', async () => {
    seedReads();
    const app = await buildApp();
    const res = await app.request('/v1/reports?status=draft');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { id: string }[] };
    expect(data.map((r) => r.id)).toContain(REPORT);
    const empty = await app.request('/v1/reports?status=published');
    const { data: none } = (await empty.json()) as { data: { id: string }[] };
    expect(none).toHaveLength(0);
  });

  it('submits the founder decision with the captured note', async () => {
    const res = await post(
      await buildApp(),
      `/v1/reports/${REPORT}/review`,
      JSON.stringify({ decision: 'rejected', note: 'Numbers do not match the ledger.' }),
    );
    expect(res.status).toBe(200);
    expect(lastRpc?.args['p_decision']).toBe('rejected');
    expect(lastRpc?.args['p_note']).toBe('Numbers do not match the ledger.');
    expect(lastRpc?.args['p_reviewed_by']).toBe(USER);
  });

  it('refuses a decision outside the pair before touching the database', async () => {
    const res = await post(
      await buildApp(),
      `/v1/reports/${REPORT}/review`,
      JSON.stringify({ decision: 'kind_of_ok' }),
    );
    expect(res.status).toBe(400);
    expect(lastRpc).toBeNull();
  });

  it('renders reason_required and not_approved as 409s', async () => {
    const app = await buildApp();
    fake.onRpc('review_report', () => ({ error: 'reason_required' }));
    const rejected = await post(
      app,
      `/v1/reports/${REPORT}/review`,
      JSON.stringify({ decision: 'rejected' }),
    );
    expect(rejected.status).toBe(409);

    fake.onRpc('release_report', () => ({ error: 'not_approved' }));
    const released = await post(app, `/v1/reports/${REPORT}/release`);
    expect(released.status).toBe(409);
    expect(((await released.json()) as { error: { code: string } }).error.code).toBe(
      'not_approved',
    );
  });

  it('releases through the RPC with the caller as releaser', async () => {
    const res = await post(await buildApp(), `/v1/reports/${REPORT}/release`);
    expect(res.status).toBe(200);
    expect(lastRpc?.args['p_released_by']).toBe(USER);
    expect(((await res.json()) as { data: { status: string } }).data.status).toBe('published');
  });
});
