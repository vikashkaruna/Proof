import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { AssessmentSnapshotSchema, UserRole } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';
const T = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const E = '33333333-3333-4333-8333-333333333333';
const OLD = '44444444-4444-4444-8444-444444444444';
const PROOF = '55555555-5555-4555-8555-555555555555';
const db = vi.hoisted(() => ({ current: null as FakeDb | null }));
vi.mock('@axiom/supabase', () => ({ createSupabaseAdmin: () => db.current!.client }));
import { assessmentRoutes } from './assessment.js';
let fake: FakeDb;
function request(query = '', role: UserRole = UserRole.OWNER) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: T } as never);
    c.set('tenantId', T as never);
    c.set('role', role);
    await next();
  });
  app.route('/v1', assessmentRoutes());
  return app.request(`/v1/assessment${query}`);
}
const control = (id: string, version = 'v1') => ({
  id,
  library_version: version,
  title: `${id} ${version}`,
  domain: 'SEC',
  citations: [{ instrument: 'Fixture', reference: 'Test citation' }],
});
const finding = (id: string, score: unknown) => ({
  tenant_id: T,
  engagement_id: E,
  library_version: 'v1',
  control_id: id,
  score,
  evidence_ids: [],
});
beforeEach(() => {
  fake = createFakeDb({
    control_libraries: [
      { version: 'v1', control_count: 4, status: 'published' },
      { version: 'v0', control_count: 1, status: 'deprecated' },
    ],
    tenants: [
      { id: OTHER, is_sdf: true },
      { id: T, is_sdf: false },
    ],
    engagements: [
      {
        id: OLD,
        tenant_id: T,
        title: 'Old',
        library_version: 'v0',
        status: 'completed',
        estimated_exposure_inr: 999,
        created_at: '2020-01-01',
      },
      {
        id: E,
        tenant_id: T,
        title: 'Owned',
        library_version: 'v1',
        status: 'assessment',
        estimated_exposure_inr: 0,
        created_at: '2026-01-01',
      },
      {
        id: OTHER,
        tenant_id: OTHER,
        title: 'Foreign',
        library_version: 'v2',
        status: 'completed',
        estimated_exposure_inr: 123,
        created_at: '2030-01-01',
      },
    ],
    controls: [
      control('A'),
      control('B'),
      control('C'),
      control('D'),
      control('A', 'v0'),
      control('A', 'v2'),
    ],
    findings: [
      finding('A', 0),
      finding('B', '60.00'),
      finding('C', 100),
      { ...finding('D', 100), engagement_id: OLD },
      { ...finding('D', 100), tenant_id: OTHER },
      { ...finding('D', 100), library_version: 'v0' },
    ],
    evidence: [],
  });
  db.current = fake;
});

describe('saved assessment projection', () => {
  it('binds all data to one owned engagement and its exact library, preserving measured zeros', async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const result = AssessmentSnapshotSchema.parse(await response.json());
    expect(result.engagement).toEqual({
      id: E,
      title: 'Owned',
      libraryVersion: 'v1',
      status: 'assessment',
    });
    expect(result.isSdf).toBe(false);
    expect(result.exposureInr).toBe(0);
    expect(result.controls.map((row) => [row.id, row.score, row.status])).toEqual([
      ['A', 0, 'fail'],
      ['B', 60, 'partial'],
      ['C', 100, 'pass'],
      ['D', null, 'unassessed'],
    ]);
    expect(result.summary).toEqual({ pass: 1, partial: 1, fail: 1, unassessed: 1 });
    expect(result.controls.every((row) => row.evidenceIds.length === 0)).toBe(true);
  });
  it('selects an explicit historical assessment without mixing current results', async () => {
    const response = await request(`?engagementId=${OLD}`);
    const result = AssessmentSnapshotSchema.parse(await response.json());
    expect(result.engagement?.id).toBe(OLD);
    expect(result.controls).toHaveLength(1);
    expect(result.controls[0]?.status).toBe('unassessed');
  });
  it.each([OTHER, PROOF])('does not reveal foreign or missing engagement %s', async (id) => {
    expect((await request(`?engagementId=${id}`)).status).toBe(404);
  });
  it('rejects an invalid engagement identifier', async () => {
    expect((await request('?engagementId=not-an-id')).status).toBe(400);
  });
  it('returns no invented controls/exposure when there is no saved engagement', async () => {
    fake.rows('engagements').splice(0);
    const result = AssessmentSnapshotSchema.parse(await (await request()).json());
    expect(result.engagement).toBeNull();
    expect(result.exposureInr).toBeNull();
    expect(result.controls).toEqual([]);
  });
  it('keeps absent exposure distinct from zero', async () => {
    fake.rows('engagements')[1]!.estimated_exposure_inr = null;
    expect(AssessmentSnapshotSchema.parse(await (await request()).json()).exposureInr).toBeNull();
  });
  it('returns only real evidence IDs cited by the finding and owned by this engagement', async () => {
    fake.rows('findings')[0]!.evidence_ids = [PROOF, OTHER, OLD, PROOF];
    fake.seed('evidence', { id: PROOF, tenant_id: T, engagement_id: E });
    fake.seed('evidence', { id: OTHER, tenant_id: OTHER, engagement_id: E });
    fake.seed('evidence', { id: OLD, tenant_id: T, engagement_id: OLD });
    const result = AssessmentSnapshotSchema.parse(await (await request()).json());
    expect(result.controls[0]?.evidenceIds).toEqual([PROOF]);
  });
  it.each(['engagements', 'tenants', 'control_libraries', 'controls', 'findings', 'evidence'])(
    'fails closed on %s query failure',
    async (table) => {
      fake.failNext(table);
      const response = await request();
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('connection lost');
    },
  );
  it.each([null, '', 'invalid', -1, 101])('refuses malformed persisted score %s', async (score) => {
    fake.rows('findings')[0]!.score = score;
    expect((await request()).status).toBe(503);
  });
  it('refuses a missing control library instead of using the current bundled library', async () => {
    fake.rows('controls').splice(0);
    expect((await request()).status).toBe(503);
  });
  it('refuses duplicate results and does not arbitrarily choose one', async () => {
    fake.seed('findings', finding('A', 100));
    expect((await request()).status).toBe(503);
  });
  it('refuses incomplete result sets at the size limit', async () => {
    for (let i = 0; i < 1001; i++) fake.seed('controls', control(`extra-${i}`));
    expect((await request()).status).toBe(503);
  });
  it('does not truncate the control display to sixteen rows', async () => {
    for (let i = 0; i < 20; i++) fake.seed('controls', control(`extra-${i}`));
    fake.rows('control_libraries')[0]!.control_count = 24;
    const result = AssessmentSnapshotSchema.parse(await (await request()).json());
    expect(result.controls).toHaveLength(24);
    expect(result.summary.unassessed).toBe(21);
  });
  it('refuses a partly populated published library', async () => {
    fake.rows('control_libraries')[0]!.control_count = 5;
    expect((await request()).status).toBe(503);
  });
  it('refuses a draft library as a published assessment baseline', async () => {
    fake.rows('control_libraries')[0]!.status = 'draft';
    expect((await request()).status).toBe(503);
  });
  it('requires posture read capability', async () => {
    expect((await request('', UserRole.AGENT)).status).toBe(403);
  });
});
