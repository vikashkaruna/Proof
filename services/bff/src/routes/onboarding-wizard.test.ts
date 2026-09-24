import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';
vi.mock('@axiom/supabase', () => ({ createSupabaseAdmin: vi.fn() }));
import { onboardingWizardRoutes } from './onboarding-wizard.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '00000000-0000-4000-8000-000000000001';
const WIZARD = '44444444-4444-4444-8444-444444444444';
const ESTATE = '55555555-5555-4555-8555-555555555555';
const readiness = {
  ready: false,
  checks: [{ key: 'company_profile', ok: false }],
  counts: {
    systems: 0,
    registeredConnectors: 0,
    manualSystems: 0,
    activeReadGrants: 0,
    activeWriteGrants: 0,
  },
};
const wizard = (over: Record<string, unknown> = {}) => ({
  id: WIZARD,
  tenant_id: TENANT,
  estate_id: null,
  status: 'in_progress',
  completed_steps: [],
  manual_system_ids: [],
  version: 1,
  started_by: USER,
  completed_by: null,
  completed_at: null,
  readiness: null,
  created_at: '2026-09-24T00:00:00.000Z',
  updated_at: '2026-09-24T00:00:00.000Z',
  ...over,
});
let fake: FakeDb;
let calls: Record<string, Record<string, unknown>[]>;
let advance: (a: Record<string, unknown>) => unknown;
beforeEach(() => {
  fake = createFakeDb();
  calls = {};
  advance = () => ({ resource: wizard({ version: 2, completed_steps: ['company'] }), readiness });
  const record = (fn: string, result: (a: Record<string, unknown>) => unknown) =>
    fake.onRpc(fn, (args) => {
      (calls[fn] ??= []).push(args);
      return result(args);
    });
  record('start_onboarding_wizard', () => ({ resource: wizard(), created: true, readiness }));
  record('advance_onboarding_wizard', (a) => advance(a));
  record('onboarding_wizard_readiness', () => readiness);
});

function app(role: UserRole = UserRole.ADMIN) {
  const hono = new Hono<{ Variables: Variables }>();
  hono.use('*', async (c, next) => {
    c.set('user', { id: USER } as never);
    c.set('tenantId', TENANT as never);
    c.set('role', role);
    await next();
  });
  hono.route('/v1', onboardingWizardRoutes({ client: () => fake.client as never }));
  return hono;
}
const post = (path: string, body: unknown, role?: UserRole) =>
  app(role).request(`/v1${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
type Reply = {
  data?: { id?: string };
  readiness?: unknown;
  error?: { readiness?: unknown } & Record<string, unknown>;
};
const body = async (res: Response) => (await res.json()) as Reply;
const company = {
  step: 'company',
  expectedVersion: 1,
  isSdf: false,
  processesChildrenData: false,
  processesHealthData: true,
  dpoName: 'Asha Rao',
  dpoEmail: 'DPO@Example.in',
};

describe('onboarding wizard routes (C-W3-5)', () => {
  it('starts or resumes a run for estate managers only', async () => {
    const res = await post('/onboarding/wizard', {});
    expect(res.status).toBe(201);
    expect((await body(res)).data?.id).toBe(WIZARD);
    expect(calls.start_onboarding_wizard?.[0]).toMatchObject({
      p_tenant_id: TENANT,
      p_actor_id: USER,
    });
    expect((await post('/onboarding/wizard', {}, UserRole.VIEWER)).status).toBe(403);
    expect(calls.start_onboarding_wizard).toHaveLength(1);
  });

  it('reports a resumed run with 200', async () => {
    fake.onRpc('start_onboarding_wizard', () => ({
      resource: wizard(),
      created: false,
      readiness,
    }));
    expect((await post('/onboarding/wizard', {})).status).toBe(200);
  });

  it('returns no run, the open run with live readiness, or the completed snapshot', async () => {
    let res = await app(UserRole.VIEWER).request('/v1/onboarding/wizard');
    expect(await body(res)).toEqual({ data: null, readiness: null });
    fake.seed('tenant_onboarding_wizards', wizard());
    res = await app(UserRole.VIEWER).request('/v1/onboarding/wizard');
    expect((await body(res)).readiness).toEqual(readiness);
    expect(calls.onboarding_wizard_readiness).toHaveLength(1);
  });

  it('serves a completed run from its stored snapshot', async () => {
    const snapshot = { ...readiness, ready: true };
    fake.seed('tenant_onboarding_wizards', wizard({ status: 'completed', readiness: snapshot }));
    const res = await app().request('/v1/onboarding/wizard');
    expect((await body(res)).readiness).toEqual(snapshot);
    expect(calls.onboarding_wizard_readiness).toBeUndefined();
  });

  it('passes only the step fields to the database, normalising the email', async () => {
    const res = await post(`/onboarding/wizard/${WIZARD}/steps`, company);
    expect(res.status).toBe(200);
    expect(calls.advance_onboarding_wizard?.[0]).toMatchObject({
      p_wizard_id: WIZARD,
      p_step: 'company',
      p_expected_version: 1,
      p_payload: {
        isSdf: false,
        processesChildrenData: false,
        processesHealthData: true,
        dpoName: 'Asha Rao',
        dpoEmail: 'dpo@example.in',
      },
    });
  });

  it('refuses malformed or unknown-field bodies before the database', async () => {
    for (const body of [
      { ...company, extra: true },
      { step: 'estate', expectedVersion: 1, estateId: 'nope' },
      { step: 'grants', expectedVersion: 1, acknowledged: false },
      { step: 'unknown', expectedVersion: 1 },
    ])
      expect((await post(`/onboarding/wizard/${WIZARD}/steps`, body)).status).toBe(400);
    expect((await post('/onboarding/wizard/not-a-uuid/steps', company)).status).toBe(400);
    expect(calls.advance_onboarding_wizard).toBeUndefined();
  });

  it('requires estate management for steps', async () => {
    const body = { step: 'estate', expectedVersion: 2, estateId: ESTATE };
    expect((await post(`/onboarding/wizard/${WIZARD}/steps`, body, UserRole.APPROVER)).status).toBe(
      403,
    );
    expect(calls.advance_onboarding_wizard).toBeUndefined();
  });

  it('maps database refusals with their detail', async () => {
    advance = () => ({ error: 'step_out_of_order', nextStep: 'company' });
    let res = await post(`/onboarding/wizard/${WIZARD}/steps`, {
      step: 'estate',
      expectedVersion: 1,
      estateId: ESTATE,
    });
    expect(res.status).toBe(409);
    expect((await body(res)).error).toMatchObject({
      code: 'step_out_of_order',
      nextStep: 'company',
    });
    advance = () => ({ error: 'connection_path_missing', missing: 2 });
    res = await post(`/onboarding/wizard/${WIZARD}/steps`, {
      step: 'connectors',
      expectedVersion: 4,
      manualSystemIds: [],
    });
    expect((await body(res)).error).toMatchObject({ code: 'connection_path_missing', missing: 2 });
    advance = () => ({ error: 'not_ready', readiness });
    res = await post(`/onboarding/wizard/${WIZARD}/steps`, {
      step: 'readiness',
      expectedVersion: 6,
      confirmed: true,
    });
    expect(res.status).toBe(409);
    expect((await body(res)).error?.readiness).toEqual(readiness);
    advance = () => ({ error: 'surprise' });
    expect((await post(`/onboarding/wizard/${WIZARD}/steps`, company)).status).toBe(503);
  });
});
