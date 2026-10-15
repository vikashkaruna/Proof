import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { buildLibrarySeed } from '@axiom/control-library';
import { z } from 'zod';
import { UserRole, publicControlAssessmentV2Schema } from '@axiom/types';
import { encodePublicEvidencePayloadV2 } from '../connectors/public-evidence-codec-v2.js';
import type { Variables } from '../types.js';
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@axiom/supabase', () => ({ createSupabaseAdmin: () => ({ rpc: mocks.rpc }) }));
import { publicWebsiteControlReviewRoutes } from './public-website-control-review.js';
const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  E = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
function fixture() {
  const seed = buildLibrarySeed();
  const rootHash = createHash('sha256').update('root').digest('hex');
  const pages = (['root', 'privacy', 'contact', 'terms', 'consent'] as const).map((page) => ({
    page,
    state: 'examined' as const,
    contentSha256: rootHash,
    truncated: false,
    coverageReasons: [],
  }));
  const encoded = encodePublicEvidencePayloadV2({
    version: 2,
    extractorVersion: 'public-static-evidence-1',
    pages,
    candidates: [],
    candidatesTruncated: false,
    scope: 'bounded_public_pages',
    requiresHumanReview: true,
  });
  return {
    tenantId: T,
    engagementId: E,
    checkId: C,
    checkedAt: '2026-10-15T17:00:00+00:00',
    rootContentSha256: rootHash,
    codec: encoded.codec,
    payloadText: encoded.payloadText,
    payloadSha256: encoded.payloadSha256,
    pageSources: pages.map((p) => ({
      page: p.page,
      state: p.state,
      contentSha256: p.contentSha256,
      requestedUrl: 'https://public.org/',
      finalUrl: 'https://public.org/',
    })),
    captureReceipt: '500',
    libraryVersion: seed.version,
    library: {
      version: seed.version,
      published_at: new Date(seed.publishedAt).toISOString(),
      published_by: seed.publishedBy,
      change_log: seed.changeLog,
      control_count: 46,
      status: 'published',
    },
    controls: seed.controls,
  };
}
let value: ReturnType<typeof fixture>;
beforeEach(() => {
  value = fixture();
  mocks.rpc.mockReset();
  mocks.rpc.mockImplementation(() => ({ abortSignal: async () => ({ data: value, error: null }) }));
});
function app(role: UserRole = UserRole.VIEWER) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: A } as never);
    c.set('tenantId', T);
    c.set('role', role);
    await next();
  });
  app.route('/v1', publicWebsiteControlReviewRoutes());
  return app;
}
const get = () => app().request(`/v1/public-website-checks/${C}/control-review?engagementId=${E}`);
it('reviews retained evidence against the engagement exact published catalogue without any write or model call', async () => {
  const r = await get();
  expect(r.status).toBe(200);
  expect(r.headers.get('Cache-Control')).toBe('private, no-store');
  const body = z
    .object({
      data: z.object({ assessment: publicControlAssessmentV2Schema, captureReceipt: z.string() }),
    })
    .parse(await r.json());
  expect(body.data.assessment.controls).toHaveLength(46);
  expect(body.data.captureReceipt).toBe('500');
  expect(body.data.assessment.requiresHumanReview).toBe(true);
  expect(body.data.assessment.source).toMatchObject({
    tenantId: T,
    engagementId: E,
    checkId: C,
    assessmentDate: '2026-10-15',
  });
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('read_public_website_control_review', {
    p_tenant_id: T,
    p_actor_id: A,
    p_engagement_id: E,
    p_check_id: C,
  });
  expect(
    body.data.assessment.controls.find(
      (c: { controlId: string }) => c.controlId === 'DPDPA-CHD-001',
    )!.applicability,
  ).toBe('conditional_unknown');
});
it('refuses agent credentials before reading', async () => {
  expect(
    (
      await app(UserRole.AGENT).request(
        `/v1/public-website-checks/${C}/control-review?engagementId=${E}`,
      )
    ).status,
  ).toBe(403);
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it('refuses malformed context before reading', async () => {
  expect(
    (await app().request(`/v1/public-website-checks/bad/control-review?engagementId=${E}`)).status,
  ).toBe(400);
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it.each(['tenantId', 'engagementId', 'checkId'] as const)(
  'refuses wrong retained %s',
  async (key) => {
    value[key] = A;
    expect((await get()).status).toBe(503);
  },
);
it.each(['payloadSha256', 'rootContentSha256'] as const)('refuses changed %s', async (key) => {
  value[key] = 'f'.repeat(64);
  expect((await get()).status).toBe(503);
});
it('refuses changed retained canonical bytes', async () => {
  value.payloadText += ' ';
  expect((await get()).status).toBe(503);
});
it('refuses a changed published question', async () => {
  value.controls[0]!.title += ' changed';
  expect((await get()).status).toBe(503);
});
it('refuses a changed publication identity', async () => {
  value.library.published_by = 'another publisher';
  expect((await get()).status).toBe(503);
});
it('refuses mismatched provenance', async () => {
  value.pageSources[1]!.contentSha256 = 'f'.repeat(64);
  expect((await get()).status).toBe(503);
});
it.each([
  'website_recapture_required',
  'forbidden',
  'context_refused',
  'source_refused',
  'catalogue_unavailable',
])('sanitizes %s', async (error) => {
  mocks.rpc.mockImplementation(() => ({
    abortSignal: async () => ({ data: { error }, error: null }),
  }));
  const r = await get();
  expect(r.status).toBe(
    error === 'website_recapture_required' ? 409 : error === 'catalogue_unavailable' ? 503 : 404,
  );
});
it('sanitizes transport failure and honors bounded cancellation', async () => {
  mocks.rpc.mockImplementation(() => ({
    abortSignal: async (signal: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      throw new Error('private secret');
    },
  }));
  const r = await get();
  expect(r.status).toBe(503);
  expect(await r.text()).not.toContain('secret');
});
