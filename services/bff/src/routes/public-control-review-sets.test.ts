import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@axiom/ledger';
import {
  PUBLIC_CONTROL_REVIEW_MAX_BYTES,
  PUBLIC_CONTROL_REVIEW_REQUEST_CODEC_V2,
  PUBLIC_CONTROL_REVIEW_SNAPSHOT_CODEC_V2,
  encodePublicWebsiteAssetRequest,
  UserRole,
} from '@axiom/types';
import type { Variables } from '../types.js';
import {
  publicControlReviewSetFixture,
  reviewIds as ids,
} from '../test/public-control-review-set-fixture.js';
const mocks = vi.hoisted(() => ({ admin: vi.fn(), writer: vi.fn(), cache: vi.fn() }));
vi.mock('@axiom/supabase', () => ({
  createSupabaseAdmin: () => ({ rpc: mocks.admin }),
  createHumanActionWriter: () => ({ rpc: mocks.writer }),
}));
vi.mock('@axiom/config', () => ({
  loadEnv: () => ({
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_SERVICE_KEY: 'synthetic-test-service-key',
  }),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ rpc: mocks.cache }) }));
import { idempotency } from '../middleware/idempotency.js';
import { boundedJsonBody } from '../middleware/evidence-body-limit.js';
import {
  publicControlReviewSetRoutes,
  verifyPublicControlReviewRow,
} from './public-control-review-sets.js';
let fixture: ReturnType<typeof publicControlReviewSetFixture>;
let writerError: string | null, current: boolean;
beforeEach(() => {
  fixture = publicControlReviewSetFixture();
  writerError = null;
  current = true;
  vi.clearAllMocks();
  mocks.cache.mockRejectedValue(
    new Error('Generic response caching must not hide live review checks'),
  );
  mocks.admin.mockImplementation((name: string) => ({
    abortSignal: async () => ({
      error: null,
      data:
        name === 'read_public_control_review_head'
          ? { context: fixture.context, data: fixture.row }
          : { state: 'recorded', data: fixture.row, isCurrent: current, contextCurrent: current },
    }),
  }));
  mocks.writer.mockImplementation((name: string) => ({
    abortSignal: async () => ({
      error: null,
      data: writerError
        ? { error: writerError }
        : name === 'record_public_control_review_set'
          ? { data: fixture.row, replayed: false }
          : { data: fixture.row, isCurrent: current, contextCurrent: current },
    }),
  }));
});
function app(role: UserRole = UserRole.OWNER) {
  const a = new Hono<{ Variables: Variables }>();
  a.use('*', async (c, next) => {
    c.set('tenantId', ids.tenant);
    c.set('user', { id: ids.actor } as never);
    c.set('role', role);
    c.set('sessionId', 'synthetic-human-session');
    await next();
  });
  a.use('/v1/public-control-review-sets', boundedJsonBody(PUBLIC_CONTROL_REVIEW_MAX_BYTES));
  a.use(
    '/v1/public-control-review-sets/*',
    boundedJsonBody(PUBLIC_CONTROL_REVIEW_MAX_BYTES + 8192),
  );
  a.use('*', idempotency);
  a.route('/v1', publicControlReviewSetRoutes());
  return a;
}
function post(
  body = canonicalJson(fixture.request),
  actor = ids.actor,
  role: UserRole = UserRole.OWNER,
) {
  return app(role).request('/v1/public-control-review-sets', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': ids.operation,
      'x-expected-actor-id': actor,
    },
    body,
  });
}
async function responseBody(response: Response) {
  return z
    .object({
      data: z
        .object({
          review: z
            .object({
              receipt_id: z.string(),
              snapshot: z.object({
                declarationsVerified: z.boolean(),
                requiresHumanReview: z.boolean(),
              }),
            })
            .optional(),
          data: z.object({ receipt_id: z.string() }).passthrough().optional(),
          state: z.enum(['not_found', 'recorded', 'cancelled']).optional(),
          isCurrent: z.boolean().optional(),
          contextCurrent: z.boolean().optional(),
        })
        .passthrough(),
    })
    .parse(await response.json());
}
it('records only the exact human declaration through the narrow writer and confirms current status', async () => {
  const r = await post();
  expect(r.status).toBe(201);
  const body = await responseBody(r);
  expect(body.data.review?.receipt_id).toBe('9223372036854775807');
  expect(body.data.review?.snapshot.declarationsVerified).toBe(false);
  expect(body.data.review?.snapshot.requiresHumanReview).toBe(true);
  expect(mocks.cache).not.toHaveBeenCalled();
  expect(mocks.admin).not.toHaveBeenCalled();
  expect(mocks.writer).toHaveBeenCalledWith('record_public_control_review_set', {
    p_tenant_id: ids.tenant,
    p_actor_id: ids.actor,
    p_request_text: canonicalJson(fixture.request),
  });
});
it('reads a verified current context without exposing raw retained page bytes', async () => {
  const r = await app().request(
    `/v1/public-control-review-sets/current?engagementId=${ids.engagement}&checkId=${ids.check}`,
  );
  expect(r.status).toBe(200);
  const text = await r.text();
  expect(text).not.toContain('payloadText');
  expect(JSON.parse(text).data.expectedSource).toEqual(fixture.request.expectedSource);
  expect(mocks.writer).not.toHaveBeenCalled();
});
it.each([UserRole.VIEWER, UserRole.PARTNER, UserRole.AGENT])(
  'refuses a forbidden recording role %s before custody access',
  async (role) => {
    expect((await post(undefined, ids.actor, role)).status).toBe(403);
    expect(mocks.writer).not.toHaveBeenCalled();
    expect(mocks.cache).not.toHaveBeenCalled();
  },
);
it('refuses changed actors and duplicate JSON keys before calling the writer', async () => {
  expect((await post(undefined, ids.check)).status).toBe(409);
  const text = canonicalJson(fixture.request).replace('"version":1', '"version":1,"version":1');
  expect((await post(text)).status).toBe(400);
  expect(mocks.writer).not.toHaveBeenCalled();
});
it('bounds actual request bytes before replay or RPC access', async () => {
  expect((await post(' '.repeat(PUBLIC_CONTROL_REVIEW_MAX_BYTES + 1))).status).toBe(413);
  expect(mocks.writer).not.toHaveBeenCalled();
  expect(mocks.cache).not.toHaveBeenCalled();
});
it.each(['stale_review', 'idempotency_conflict'])(
  'keeps a typed %s refusal and rechecks it on every retry',
  async (code) => {
    writerError = code;
    expect((await post()).status).toBe(409);
    expect((await post()).status).toBe(409);
    expect(mocks.writer).toHaveBeenCalledTimes(2);
    expect(mocks.cache).not.toHaveBeenCalled();
  },
);
it('withholds success when retained bytes change even if their replacement hash is plausible', async () => {
  fixture.row.snapshot_text += ' ';
  fixture.row.snapshot_sha256 = createHash('sha256')
    .update(fixture.row.snapshot_text)
    .digest('hex');
  expect((await post()).status).toBe(503);
});
it('rejects inferred values for unreviewed questions', () => {
  const [control, questions] = Object.entries(fixture.snapshot.normalizedAnswers).find(
    ([c]) => !fixture.request.answers[c],
  )!;
  const question = Object.keys(questions)[0]!;
  const changed = {
    ...fixture.snapshot,
    normalizedAnswers: {
      ...fixture.snapshot.normalizedAnswers,
      [control]: { ...questions, [question]: true },
    },
  };
  fixture.row.snapshot_text = canonicalJson(changed);
  fixture.row.snapshot_sha256 = createHash('sha256')
    .update(fixture.row.snapshot_text)
    .digest('hex');
  expect(() => verifyPublicControlReviewRow(fixture.row, { tenantId: ids.tenant })).toThrow();
});
it('reconciles a committed historical operation without calling the writer or claiming it is current', async () => {
  current = false;
  const r = await app().request(
    `/v1/public-control-review-sets/operations/${ids.operation}?engagementId=${ids.engagement}&checkId=${ids.check}`,
  );
  expect(r.status).toBe(200);
  const body = await responseBody(r);
  expect(body.data.isCurrent).toBe(false);
  expect(body.data.contextCurrent).toBe(false);
  expect(mocks.writer).not.toHaveBeenCalled();
});

function cancelled() {
  const reason = 'Correct a stale unrecorded review request.';
  const cancellation = canonicalJson({
    version: 1,
    tenantId: ids.tenant,
    actorId: ids.actor,
    engagementId: ids.engagement,
    checkId: ids.check,
    operationKey: ids.operation,
    requestSha256: fixture.row.request_sha256,
    reason,
  });
  return {
    id: ids.review,
    tenant_id: ids.tenant,
    actor_id: ids.actor,
    engagement_id: ids.engagement,
    check_id: ids.check,
    operation_key: ids.operation,
    request_codec: fixture.row.request_codec,
    request_text: fixture.row.request_text,
    request_sha256: fixture.row.request_sha256,
    cancellation_codec: 'axiom-public-control-review-cancellation-pg-canonical-json-1',
    cancellation_text: cancellation,
    cancellation_sha256: createHash('sha256').update(cancellation).digest('hex'),
    reason,
    receipt_id: '9223372036854775806',
    created_at: fixture.row.created_at,
  };
}
function cancel(
  body: unknown = { request: fixture.request, reason: cancelled().reason },
  actor = ids.actor,
  role: UserRole = UserRole.OWNER,
) {
  return app(role).request(`/v1/public-control-review-sets/operations/${ids.operation}/cancel`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': ids.operation,
      'x-expected-actor-id': actor,
    },
    body: JSON.stringify(body),
  });
}
it('cancels an exact owned unrecorded intent through the durable writer without response caching', async () => {
  mocks.writer.mockImplementation(() => ({
    abortSignal: async () => ({ error: null, data: { state: 'cancelled', data: cancelled() } }),
  }));
  const r = await cancel();
  expect(r.status).toBe(200);
  expect((await responseBody(r)).data.data?.receipt_id).toBe('9223372036854775806');
  expect(mocks.writer).toHaveBeenCalledWith('cancel_public_control_review_operation', {
    p_tenant_id: ids.tenant,
    p_actor_id: ids.actor,
    p_request_text: fixture.row.request_text,
    p_reason: cancelled().reason,
  });
  expect(mocks.cache).not.toHaveBeenCalled();
});
it.each([UserRole.VIEWER, UserRole.PARTNER, UserRole.AGENT])(
  'refuses unauthorized cancellation %s before writer custody',
  async (role) => {
    expect((await cancel(undefined, ids.actor, role)).status).toBe(403);
    expect(mocks.writer).not.toHaveBeenCalled();
  },
);
it('rejects a changed actor before cancellation custody', async () => {
  expect((await cancel(undefined, ids.review)).status).toBe(409);
  expect(mocks.writer).not.toHaveBeenCalled();
});
it('returns positive already-recorded proof from cancellation rather than pretending to undo the review', async () => {
  mocks.writer.mockImplementation(() => ({
    abortSignal: async () => ({
      error: null,
      data: { state: 'recorded', data: fixture.row, isCurrent: false, contextCurrent: false },
    }),
  }));
  const r = await cancel();
  expect(r.status).toBe(200);
  expect((await responseBody(r)).data.state).toBe('recorded');
});
it.each(['changed-actor', 'changed-reason', 'forged-hash', 'not-found'] as const)(
  'withholds cancellation success for %s',
  async (kind) => {
    const row = cancelled();
    if (kind === 'changed-actor') row.actor_id = ids.review;
    if (kind === 'changed-reason') row.reason = 'A different decision.';
    if (kind === 'forged-hash') row.cancellation_sha256 = '0'.repeat(64);
    mocks.writer.mockImplementation(() => ({
      abortSignal: async () => ({
        error: null,
        data: kind === 'not-found' ? { state: 'not_found' } : { state: 'cancelled', data: row },
      }),
    }));
    expect((await cancel()).status).toBe(503);
  },
);
it('allows a read-only cancellation reconciliation but never fabricates a missing outcome', async () => {
  mocks.admin.mockImplementation(() => ({
    abortSignal: async () => ({ error: null, data: { state: 'not_found' } }),
  }));
  const r = await app().request(
    `/v1/public-control-review-sets/operations/${ids.operation}?engagementId=${ids.engagement}&checkId=${ids.check}`,
  );
  expect(r.status).toBe(200);
  expect((await responseBody(r)).data).toEqual({ state: 'not_found' });
  expect(mocks.writer).not.toHaveBeenCalled();
});
it.each(['catalogueManifestSha256', 'questionnaireDigest'] as const)(
  'refuses a rehashed stored review with a foreign %s',
  async (field) => {
    const changed = {
      ...fixture.request,
      expectedSource: { ...fixture.request.expectedSource, [field]: '0'.repeat(64) },
    };
    fixture.row.request_text = canonicalJson(changed);
    fixture.row.request_sha256 = createHash('sha256')
      .update(fixture.row.request_text)
      .digest('hex');
    fixture.row.snapshot_text = canonicalJson({ ...fixture.snapshot, request: changed });
    fixture.row.snapshot_sha256 = createHash('sha256')
      .update(fixture.row.snapshot_text)
      .digest('hex');
    expect(() => verifyPublicControlReviewRow(fixture.row, { tenantId: ids.tenant })).toThrow();
  },
);
it('bounds a cancellation wrapper before generic idempotency or privileged RPC', async () => {
  const r = await app().request(
    `/v1/public-control-review-sets/operations/${ids.operation}/cancel`,
    {
      method: 'POST',
      headers: { 'idempotency-key': ids.operation },
      body: 'x'.repeat(PUBLIC_CONTROL_REVIEW_MAX_BYTES + 8193),
    },
  );
  expect(r.status).toBe(413);
  expect(mocks.writer).not.toHaveBeenCalled();
  expect(mocks.cache).not.toHaveBeenCalled();
});

it('refuses a self-consistent cancellation receipt for a different human reason', async () => {
  const row = cancelled();
  row.reason = 'A different human decision.';
  row.cancellation_text = canonicalJson({
    ...JSON.parse(row.cancellation_text),
    reason: row.reason,
  });
  row.cancellation_sha256 = createHash('sha256').update(row.cancellation_text).digest('hex');
  mocks.writer.mockImplementation(() => ({
    abortSignal: async () => ({ error: null, data: { state: 'cancelled', data: row } }),
  }));
  expect((await cancel()).status).toBe(503);
});

it.each(['payloadSha256', 'checkedAt', 'captureReceipt'] as const)(
  'rejects independently rehashed current capture mismatch %s',
  async (field) => {
    const snapshot = structuredClone(fixture.snapshot);
    if (field === 'payloadSha256') {
      snapshot.request.expectedSource.payloadSha256 = '0'.repeat(64);
      fixture.row.request_text = canonicalJson(snapshot.request);
      fixture.row.request_sha256 = createHash('sha256')
        .update(fixture.row.request_text)
        .digest('hex');
    } else if (field === 'checkedAt') snapshot.checkedAt = '2026-10-15T00:00:00.000Z';
    else snapshot.captureReceipt = '501';
    fixture.row.snapshot_text = canonicalJson(snapshot);
    fixture.row.snapshot_sha256 = createHash('sha256')
      .update(fixture.row.snapshot_text)
      .digest('hex');
    const r = await app().request(
      `/v1/public-control-review-sets/current?engagementId=${ids.engagement}&checkId=${ids.check}`,
    );
    expect(r.status).toBe(503);
  },
);
it('preserves the historical head when estate context changes without disguising its recorded estate', async () => {
  const changedContext = { ...fixture.context, estateId: ids.review };
  mocks.admin.mockImplementation(() => ({
    abortSignal: async () => ({
      error: null,
      data: { context: changedContext, data: fixture.row },
    }),
  }));
  const r = await app().request(
    `/v1/public-control-review-sets/current?engagementId=${ids.engagement}&checkId=${ids.check}`,
  );
  const body = z
    .object({ data: z.object({ estateId: z.string(), review: z.object({ estate_id: z.null() }) }) })
    .parse(await r.json());
  expect(r.status).toBe(200);
  expect(body.data.estateId).toBe(ids.review);
  expect(body.data.review.estate_id).toBeNull();
});

function linkedRow() {
  const legacy = publicControlReviewSetFixture();
  const estate = '11111111-1111-4111-8111-111111111111',
    system = '22222222-2222-4222-8222-222222222222';
  const targetId = '33333333-3333-4333-8333-333333333333',
    associationId = '44444444-4444-4444-8444-444444444444';
  const hash = (s: string) => createHash('sha256').update(s).digest('hex');
  const bundle = (request: unknown, snapshot: unknown, n: number) => {
    const request_text = encodePublicWebsiteAssetRequest(request),
      snapshot_text = canonicalJson(snapshot);
    return {
      actor_id: ids.actor,
      operation_key: n === 1 ? estate : system,
      request_codec: 'axiom-public-website-asset-request-canonical-json-1',
      request_text,
      request_sha256: hash(request_text),
      snapshot_codec: 'axiom-public-website-asset-snapshot-canonical-json-1',
      snapshot_text,
      snapshot_sha256: hash(snapshot_text),
      receipt: { id: String(n), entry_hash: String(n).repeat(64) },
    };
  };
  const base = {
    version: 1,
    tenantId: ids.tenant,
    actorId: ids.actor,
    ownershipVerified: false,
    connectorAccessGranted: false,
  };
  const target = bundle(
    {
      version: 1,
      kind: 'register_target',
      confirmed: true,
      operationKey: estate,
      estateId: estate,
      systemId: system,
      expectedEstateVersion: 1,
      expectedSystemVersion: 1,
      url: 'https://public.org/',
    },
    {
      ...base,
      id: targetId,
      kind: 'target',
      estateId: estate,
      systemId: system,
      estateVersion: 1,
      systemVersion: 1,
      targetVersion: 1,
      estateName: 'Estate',
      systemName: 'Website',
      url: 'https://public.org/',
    },
    1,
  );
  const association = bundle(
    {
      version: 1,
      kind: 'associate_capture',
      confirmed: true,
      operationKey: system,
      targetId,
      expectedTargetSha256: target.snapshot_sha256,
      checkId: ids.check,
      expectedPayloadSha256: legacy.request.expectedSource.payloadSha256,
      expectedCaptureReceipt: '500',
    },
    {
      ...base,
      id: associationId,
      kind: 'association',
      targetId,
      targetSha256: target.snapshot_sha256,
      checkId: ids.check,
      payloadSha256: legacy.request.expectedSource.payloadSha256,
      captureReceipt: { id: '500', entryHash: 'c'.repeat(64) },
      requestedUrl: 'https://public.org/',
      finalUrl: 'https://public.org/',
      checkedAt: legacy.snapshot.checkedAt,
    },
    2,
  );
  const request = {
    ...legacy.request,
    version: 2,
    expectedEstateId: estate,
    associationRef: {
      associationId,
      associationSha256: association.snapshot_sha256,
      targetId,
      targetSha256: target.snapshot_sha256,
      associationReceipt: { id: '2', entryHash: '2'.repeat(64) },
    },
  };
  const snapshot = {
    ...legacy.snapshot,
    version: 2,
    estateId: estate,
    request,
    assetProvenance: {
      schema_version: 1,
      kind: 'public_website_asset_binding',
      tenant_id: ids.tenant,
      estate_id: estate,
      system_id: system,
      target,
      association,
      ownership_verified: false,
      connector_access_granted: false,
      review_required: true,
    },
  };
  const row = {
    ...legacy.row,
    estate_id: estate,
    request_codec: PUBLIC_CONTROL_REVIEW_REQUEST_CODEC_V2,
    request_text: canonicalJson(request),
    request_sha256: hash(canonicalJson(request)),
    snapshot_codec: PUBLIC_CONTROL_REVIEW_SNAPSHOT_CODEC_V2,
    snapshot_text: canonicalJson(snapshot),
    snapshot_sha256: hash(canonicalJson(snapshot)),
  };
  return { row, snapshot, request, hash };
}
it('decodes an explicit v2 review and retains its exact asset snapshot without changing normalized worker answers', () => {
  const f = linkedRow();
  const result = verifyPublicControlReviewRow(f.row, { tenantId: ids.tenant });
  expect(result.snapshot.version).toBe(2);
  expect(result.snapshot.normalizedAnswers).toEqual(f.snapshot.normalizedAnswers);
});
it.each(['associationSha256', 'targetSha256', 'associationId', 'targetId'] as const)(
  'refuses self-hashed review with swapped %s',
  (field) => {
    const f = linkedRow();
    f.snapshot.request.associationRef[field] = field.endsWith('Sha256')
      ? 'f'.repeat(64)
      : ids.actor;
    f.row.request_text = canonicalJson(f.snapshot.request);
    f.row.request_sha256 = f.hash(f.row.request_text);
    f.row.snapshot_text = canonicalJson(f.snapshot);
    f.row.snapshot_sha256 = f.hash(f.row.snapshot_text);
    expect(() => verifyPublicControlReviewRow(f.row, { tenantId: ids.tenant })).toThrow();
  },
);
it('refuses valid-looking v2 receipts with a v1 codec or an altered embedded operation hash', () => {
  const f = linkedRow();
  expect(() =>
    verifyPublicControlReviewRow(
      { ...f.row, request_codec: 'axiom-public-control-review-request-canonical-json-1' },
      { tenantId: ids.tenant },
    ),
  ).toThrow();
  f.snapshot.assetProvenance.target.request_sha256 = 'f'.repeat(64);
  f.row.snapshot_text = canonicalJson(f.snapshot);
  f.row.snapshot_sha256 = f.hash(f.row.snapshot_text);
  expect(() => verifyPublicControlReviewRow(f.row, { tenantId: ids.tenant })).toThrow();
});
it('refuses a self-hashed review timestamp that disagrees with its captured asset snapshot', () => {
  const f = linkedRow();
  f.snapshot.checkedAt = '2026-10-17T00:00:00.000Z';
  f.row.snapshot_text = canonicalJson(f.snapshot);
  f.row.snapshot_sha256 = f.hash(f.row.snapshot_text);
  expect(() => verifyPublicControlReviewRow(f.row, { tenantId: ids.tenant })).toThrow();
});
