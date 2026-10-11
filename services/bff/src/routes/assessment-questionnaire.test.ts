import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { UserRole, AssessmentQuestionnaireSchema } from '@axiom/types';
import { canonicalJson } from '@axiom/ledger';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';
const state = vi.hoisted(() => ({ db: null as FakeDb | null, reads: [] as string[] }));
vi.mock('@axiom/supabase', () => ({
  createSupabaseAdmin: () => ({
    from: (table: string) => {
      state.reads.push(table);
      const builder = state.db!.client.from(table) as Record<string, unknown>;
      for (const op of ['insert', 'update', 'delete'])
        builder[op] = () => {
          throw new Error('write forbidden');
        };
      return builder;
    },
  }),
}));
import { assessmentQuestionnaireRoutes } from './assessment-questionnaire.js';
const tenant = '11111111-1111-4111-8111-111111111111';
const foreign = '22222222-2222-4222-8222-222222222222';
const engagement = '33333333-3333-4333-8333-333333333333';
let db: FakeDb;
beforeEach(() => {
  state.reads = [];
  db = createFakeDb({
    engagements: [
      { id: engagement, tenant_id: tenant, library_version: '0.1.1', status: 'intake' },
    ],
    control_libraries: [{ version: '0.1.1', status: 'published', control_count: 2 }],
    controls: [
      {
        id: 'B',
        title: 'Second',
        library_version: '0.1.1',
        assessment_questions: [
          { id: 'Q2', prompt: 'Evidence?', type: 'evidence', secret: 'EXCLUDE' },
        ],
      },
      {
        id: 'A',
        title: 'First',
        library_version: '0.1.1',
        assessment_questions: [{ id: 'Q1', prompt: 'Policy?', type: 'boolean' }],
      },
    ],
  });
  state.db = db;
});
function request(query = `engagementId=${engagement}`, role: UserRole = UserRole.OWNER) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('tenantId', tenant as never);
    c.set('role', role);
    await next();
  });
  app.route('/v1', assessmentQuestionnaireRoutes());
  return app.request(`/v1/assessment/questionnaire?${query}`);
}
it('returns complete pinned published metadata and a digest confined to its questionnaire projection', async () => {
  const before = JSON.stringify(db.rows('controls'));
  const response = await request();
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  const result = AssessmentQuestionnaireSchema.parse(await response.json());
  expect(result).toMatchObject({
    tenantId: tenant,
    engagementId: engagement,
    libraryVersion: '0.1.1',
    declarationsVerified: false,
    digestScope: 'ordered_questionnaire_projection_v1',
  });
  expect(result.controls.map((c) => c.id)).toEqual(['A', 'B']);
  expect(result.questionnaireDigest).toBe(
    createHash('sha256')
      .update(canonicalJson({ libraryVersion: result.libraryVersion, controls: result.controls }))
      .digest('hex'),
  );
  expect(JSON.stringify(result)).not.toContain('EXCLUDE');
  expect(JSON.stringify(db.rows('controls'))).toBe(before);
});
it('checks capability before reading and permits current viewers to read metadata', async () => {
  expect((await request(undefined, UserRole.AGENT)).status).toBe(403);
  expect(state.reads).toEqual([]);
  expect((await request(undefined, UserRole.VIEWER)).status).toBe(200);
});
it('is reachable through the existing assessment route aggregator', async () => {
  const { assessmentRoutes } = await import('./assessment.js');
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('tenantId', tenant as never);
    c.set('role', UserRole.OWNER);
    await next();
  });
  app.route('/v1', assessmentRoutes());
  expect(
    (await app.request(`/v1/assessment/questionnaire?engagementId=${engagement}`)).status,
  ).toBe(200);
});
it.each([
  '',
  'engagementId=bad',
  `engagementId=${engagement}&tenantId=${foreign}`,
  `engagementId=${engagement}&engagementId=${engagement}`,
])('rejects malformed or authority selecting query %s', async (query) => {
  expect((await request(query)).status).toBe(400);
  expect(state.reads).toEqual([]);
});
it('does not reveal a foreign engagement or allow an absent engagement', async () => {
  db.rows('engagements')[0]!.tenant_id = foreign;
  expect((await request()).status).toBe(404);
  expect(state.reads).toEqual(['engagements']);
});
it.each(['engagements', 'controls', 'control_libraries'])(
  'fails closed and sanitizes %s read errors',
  async (table) => {
    db.failNext(table);
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: 'assessment_questionnaire_unavailable' },
    });
  },
);
it.each(['draft', 'review'])('withholds unpublished library %s', async (status) => {
  db.rows('control_libraries')[0]!.status = status;
  expect((await request()).status).toBe(503);
});
it('preserves a valid deprecated engagement pin rather than replacing it with current library', async () => {
  db.rows('control_libraries')[0]!.status = 'deprecated';
  expect((await request()).status).toBe(200);
});
it.each([
  'count',
  'duplicate-control',
  'duplicate-question',
  'empty-prompt',
  'unsupported-type',
  'cancelled',
  'version',
])('withholds ambiguous or corrupt metadata %s', async (kind) => {
  if (kind === 'count') db.rows('control_libraries')[0]!.control_count = 3;
  if (kind === 'duplicate-control') db.rows('controls')[0]!.id = 'A';
  if (kind === 'duplicate-question')
    (db.rows('controls')[0]!.assessment_questions as unknown[]).push({
      id: 'Q2',
      prompt: 'Again?',
      type: 'boolean',
    });
  if (kind === 'empty-prompt')
    (db.rows('controls')[0]!.assessment_questions as Record<string, unknown>[])[0]!.prompt = '';
  if (kind === 'unsupported-type')
    (db.rows('controls')[0]!.assessment_questions as Record<string, unknown>[])[0]!.type = 'script';
  if (kind === 'cancelled') db.rows('engagements')[0]!.status = 'cancelled';
  if (kind === 'version') db.rows('controls')[0]!.library_version = '0.1.0';
  expect((await request()).status).toBe(503);
});
