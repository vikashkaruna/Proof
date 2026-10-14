import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { canonicalJson, sha256 } from '@axiom/ledger';
import { UserRole } from '@axiom/types';
import type { User } from '@supabase/supabase-js';
import type { Variables } from '../types.js';
import { createFakeDb } from '../test/fake-postgrest.js';
import { retainedSanketRoutes } from './retained-sanket.js';
import type { GenericAgentInvocationDeps } from '../services/generic-agent-invocation.js';
import { retainedSanketInput } from '../services/retained-sanket-source.js';
import { createMfaService } from '../services/mfa.js';

vi.hoisted(() =>
  Object.assign(process.env, {
    ENVIRONMENT: 'test',
    AXIOM_AUTH_MODE: 'strict',
    SUPABASE_URL: 'http://localhost:55321',
    SUPABASE_ANON_KEY: 'a'.repeat(40),
    SUPABASE_SERVICE_KEY: 'b'.repeat(40),
    APPROVAL_SIGNING_KEY: 'k'.repeat(48),
  }),
);
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const base = '/v1/retained-public-observations';
const actor: User = {
  id: id(2),
  aud: 'authenticated',
  app_metadata: {},
  user_metadata: {},
  created_at: '2026-10-08T00:00:00Z',
};
let db: ReturnType<typeof createFakeDb>,
  source: Awaited<ReturnType<typeof fixture>>,
  saved: Record<string, unknown> | null;
let rpc: ReturnType<typeof vi.fn>, runtime: ReturnType<typeof vi.fn<typeof fetch>>;
let role: UserRole,
  enabled: boolean,
  killed: boolean,
  enrolled: boolean,
  verified: boolean,
  authPresent: boolean,
  authorityError: boolean,
  configured: boolean;
async function fixture() {
  const raw = {
    requestedUrl: 'https://axiomminds.ai/',
    finalUrl: 'https://axiomminds.ai/',
    checkedAt: '2026-10-08T07:41:58.139Z',
    status: 'checked',
    httpStatus: 200,
    bytes: 170,
    contentSha256: 'a'.repeat(64),
    title: 'Synthetic services',
    headings: ['Public information'],
    privateDiscardedField: 'server-only-witness-sentinel',
  };
  const text = JSON.stringify(raw),
    capture = {
      check_id: id(6),
      capture_actor_id: id(7),
      capture_correlation_id: id(8),
      capture_receipt: '10',
      result_sha256: await sha256(text),
      requested_url: raw.requestedUrl,
      final_url: raw.finalUrl,
      checked_at: raw.checkedAt,
      content_sha256: raw.contentSha256,
      byte_size: 170,
      title: raw.title,
      headings: raw.headings,
    };
  const input = retainedSanketInput(id(1), id(3), id(5), capture);
  const output = {
    signals: [],
    high_intent: [],
    processing_mode: 'verified_public_capture_review',
    source_observations: [
      {
        requested_url: raw.requestedUrl,
        final_url: raw.finalUrl,
        checked_at: raw.checkedAt,
        content_sha256: raw.contentSha256,
        projection_sha256: await sha256(
          canonicalJson({
            requested_url: raw.requestedUrl,
            final_url: raw.finalUrl,
            checked_at: raw.checkedAt,
            content_sha256: raw.contentSha256,
            byte_size: 170,
            title: raw.title,
            headings: raw.headings,
            capture_reference: id(6),
          }),
        ),
        capture_reference: id(6),
        observed_notice_kinds: [],
        requires_human_review: true,
      },
    ],
    notes:
      'Processed only supplied approved public captures and explicit title/heading markers. Zero score and empty high-intent list preserve unknown buying intent. Capture time is not notice publication time. Sector/geography preferences do not establish source-company classification. No contact records, outreach, login or message delivery is performed.',
  };
  return {
    preview: {
      source: capture,
      source_hash: await sha256(canonicalJson(capture)),
      capture_result_text: text,
    },
    input,
    output,
  };
}
beforeEach(async () => {
  db = createFakeDb();
  db.seed('tenants', { id: id(1), mfa_required_roles: [] });
  source = await fixture();
  saved = null;
  role = UserRole.FOUNDER;
  enabled = true;
  killed = false;
  enrolled = true;
  verified = true;
  authPresent = true;
  authorityError = false;
  configured = true;
  db.onRpc('preview_retained_sanket_source', () => source.preview);
  db.onRpc('recover_retained_sanket_output', () => saved ?? { missing: true });
  db.onRpc('start_retained_sanket_dispatch', () => ({
    run_id: id(4),
    created: true,
    status: 'running',
  }));
  db.onRpc('settle_retained_sanket_output', (args) => {
    saved = {
      run_id: id(4),
      input_hash: args.p_request_hash,
      output_hash: args.p_response_hash,
      output_text: args.p_output_text,
      requested_receipt: '20',
      started_receipt: '21',
      completed_receipt: '22',
      settled_receipt: '23',
    };
    return { run_id: id(4), status: 'succeeded', replayed: false };
  });
  db.onRpc('record_generic_agent_run_finish', () => ({
    run_id: id(4),
    status: 'failed',
    replayed: false,
  }));
  rpc = vi.fn((name: string, args: Record<string, unknown>) => db.client.rpc(name, args));
  runtime = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          agent: 'sanket',
          correlation_id: id(5),
          status: 'succeeded',
          latency_ms: 1,
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: 0,
          error: null,
          output: source.output,
          ledger_entry_ids: ['21', '22'],
        }),
      ),
  );
});
function app(mounted = true) {
  const app = new Hono<{ Variables: Variables }>();
  const loginMfa = createMfaService(() => db.client as never, {
    // Deliberately non-secret unit-fixture material; never a deployed key.
    encryptionKey: 'a'.repeat(64),
  });
  // Synthetic context only. Actual GoTrue/Auth transport acceptance is pending
  // coherent parent mount; this fixture does not claim a live login or DB proof.
  app.use('/v1/*', async (c, next) => {
    if (authPresent) {
      c.set('user', actor);
      c.set('tenantId', id(1));
      c.set('role', role);
      c.set('sessionId', 'synthetic-session');
    }
    await next();
  });
  if (mounted)
    app.route(
      '/v1',
      retainedSanketRoutes({
        enabled,
        runtimeUrl: configured ? 'http://runtime.invalid' : undefined,
        runtimeToken: configured ? 'synthetic-peer' : undefined,
        writerFactory: () =>
          ({ rpc }) as unknown as ReturnType<
            NonNullable<GenericAgentInvocationDeps['writerFactory']>
          >,
        realtime: { broadcast: vi.fn() },
        fetchImpl: runtime,
        authHeaders: async () => ({}),
        mfa: {
          requiresLoginMfa: async (context) => {
            if (authorityError) throw new Error('private-authority-sentinel');
            return loginMfa.requiresLoginMfa(context);
          },
          isEnrolled: async () => enrolled,
          sessionAttestation: async () =>
            verified
              ? {
                  id: id(9),
                  satisfiedAt: '2026-10-08T00:00:00Z',
                  expiresAt: '2026-10-09T00:00:00Z',
                }
              : null,
        },
        killSwitch: { isActive: async () => killed },
      }),
    );
  app.get('/v1/unrelated', (c) => c.json({ unrelated: true }));
  app.post('/v1/unrelated', (c) => c.json({ unrelated: true }));
  return app;
}
function body() {
  return {
    engagementId: id(3),
    checkId: id(6),
    sourceDigest: source.preview.source_hash,
    operationKey: id(5),
    confirmSourceReview: true,
  };
}
function headers() {
  return {
    'Content-Type': 'application/json',
    'X-Expected-Actor-Id': id(2),
    'Idempotency-Key': id(5),
  };
}
function post(instance = app(), value: unknown = body(), extra = {}) {
  return instance.request(base + '/runs', {
    method: 'POST',
    headers: { ...headers(), ...extra },
    body: JSON.stringify(value),
  });
}
function query() {
  return new URLSearchParams({
    engagementId: id(3),
    checkId: id(6),
    sourceDigest: source.preview.source_hash,
  });
}
it.each([
  UserRole.FOUNDER,
  UserRole.AXIOM_ANALYST,
  UserRole.OWNER,
  UserRole.ADMIN,
  UserRole.APPROVER,
])(
  'requires real mandatory-role policy before retained invocation authority for %s',
  async (requiredRole) => {
    role = requiredRole;
    enrolled = false;
    const missing = await post();
    expect(missing.status).toBe(403);
    expect(await missing.json()).toEqual({ error: { code: 'mfa_enrolment_required' } });
    enrolled = true;
    verified = false;
    const unverified = await post();
    expect(unverified.status).toBe(401);
    expect(await unverified.json()).toEqual({ error: { code: 'mfa_verification_required' } });
    expect(runtime).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  },
);
it('returns bounded public source projection without server-only PG witness', async () => {
  const response = await app().request(`${base}/source?engagementId=${id(3)}&checkId=${id(6)}`, {
    headers: headers(),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    source: source.preview.source,
    sourceDigest: source.preview.source_hash,
  });
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(runtime).not.toHaveBeenCalled();
});
it('enabled dedicated path sends only IDs then returns independently recovered bound output', async () => {
  const response = await post();
  expect(response.status).toBe(201);
  const result = await response.json();
  expect(result).toMatchObject({ outputProof: { actorId: id(2), settledReceipt: '23' } });
  expect(runtime).toHaveBeenCalledOnce();
  expect(runtime.mock.calls[0]?.[0]).toBe(
    'http://runtime.invalid/retained-public-sources/agents/sanket/invoke',
  );
  expect(JSON.parse(String(runtime.mock.calls[0]?.[1]?.body))).toEqual({
    tenant_id: id(1),
    run_id: id(4),
    operation_key: id(5),
  });
  expect(rpc.mock.calls.map(([name]) => name)).toEqual([
    'preview_retained_sanket_source',
    'recover_retained_sanket_output',
    'start_retained_sanket_dispatch',
    'settle_retained_sanket_output',
    'recover_retained_sanket_output',
  ]);
});
it('lost acknowledgement retry resolves the same stored result without second runtime work', async () => {
  expect((await post()).status).toBe(201);
  runtime.mockClear();
  rpc.mockClear();
  expect((await post()).status).toBe(200);
  expect(runtime).not.toHaveBeenCalled();
  expect(rpc.mock.calls.map(([name]) => name)).toEqual([
    'preview_retained_sanket_source',
    'recover_retained_sanket_output',
  ]);
  expect(
    (await app().request(`${base}/runs/${id(5)}?${query()}`, { headers: headers() })).status,
  ).toBe(200);
});
it.each([
  'auth',
  'viewer',
  'owner',
  'unenrolled',
  'unverified',
  'actor',
  'kill',
  'authority',
  'disabled',
])('refuses changed current %s before source or work', async (change) => {
  if (change === 'auth') authPresent = false;
  if (change === 'viewer') role = UserRole.VIEWER;
  if (change === 'owner') role = UserRole.OWNER;
  if (change === 'unenrolled') enrolled = false;
  if (change === 'unverified') verified = false;
  if (change === 'kill') killed = true;
  if (change === 'authority') authorityError = true;
  if (change === 'disabled') enabled = false;
  const response = await post(
    app(),
    body(),
    change === 'actor' ? { 'X-Expected-Actor-Id': id(99) } : {},
  );
  expect(response.status).toBe(
    {
      auth: 401,
      viewer: 403,
      owner: 403,
      unenrolled: 403,
      unverified: 401,
      actor: 409,
      kill: 423,
      authority: 503,
      disabled: 503,
    }[change],
  );
  expect(rpc).not.toHaveBeenCalled();
  expect(runtime).not.toHaveBeenCalled();
  expect(await response.text()).not.toContain('private-authority-sentinel');
});
it.each(['review', 'key', 'extra', 'digest'])(
  'rejects changed request %s before dispatch',
  async (change) => {
    const value = { ...body() };
    if (change === 'review') value.confirmSourceReview = false;
    if (change === 'key') value.operationKey = id(99);
    if (change === 'extra') Object.assign(value, { source: source.preview.source });
    if (change === 'digest') value.sourceDigest = 'f'.repeat(64);
    expect((await post(app(), value)).status).toBe(change === 'digest' ? 409 : 400);
    expect(runtime).not.toHaveBeenCalled();
    expect(rpc.mock.calls.some(([name]) => name === 'start_retained_sanket_dispatch')).toBe(false);
  },
);
it('never creates a new run after an existing uncertain claim', async () => {
  db.onRpc('start_retained_sanket_dispatch', () => ({
    run_id: id(4),
    created: false,
    status: 'running',
  }));
  expect((await post()).status).toBe(409);
  expect(runtime).not.toHaveBeenCalled();
});
it('missing runtime configuration causes no new request, while saved output remains recoverable', async () => {
  expect((await post()).status).toBe(201);
  configured = false;
  expect((await post()).status).toBe(200);
  saved = null;
  runtime.mockClear();
  rpc.mockClear();
  expect((await post()).status).toBe(503);
  expect(runtime).not.toHaveBeenCalled();
  expect(rpc.mock.calls.some(([name]) => name === 'start_retained_sanket_dispatch')).toBe(false);
});
it('read-only recovery is missing rather than complete and never calls a write RPC', async () => {
  expect(
    (await app().request(`${base}/runs/${id(5)}?${query()}`, { headers: headers() })).status,
  ).toBe(404);
  expect(rpc.mock.calls.map(([name]) => name)).toEqual([
    'preview_retained_sanket_source',
    'recover_retained_sanket_output',
  ]);
});
it('rejects duplicate query and POST query before source reads', async () => {
  expect(
    (
      await app().request(`${base}/runs/${id(5)}?${query()}&checkId=${id(6)}`, {
        headers: headers(),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await app().request(base + '/runs?extra=1', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body()),
      })
    ).status,
  ).toBe(400);
  expect(rpc).not.toHaveBeenCalled();
});
it('streaming ingress refuses oversized chunked body without trusting Content-Length', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ ...body(), padding: 'x'.repeat(5000) }));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const request = new Request('http://local.invalid' + base + '/runs', {
    method: 'POST',
    headers: { ...headers(), 'Content-Length': '1' },
    body: stream,
    duplex: 'half',
  } as RequestInit);
  expect((await app().fetch(request)).status).toBe(413);
  expect(rpc).not.toHaveBeenCalled();
});
it('disabled and unmounted feature leaves unrelated methods untouched', async () => {
  enabled = false;
  const disabled = app();
  expect((await post(disabled)).status).toBe(503);
  expect(
    (await disabled.request('/v1/unrelated', { method: 'POST', body: 'x'.repeat(10000) })).status,
  ).toBe(200);
  expect((await disabled.request('/v1/unrelated')).status).toBe(200);
  const unmounted = app(false);
  expect((await post(unmounted)).status).toBe(404);
  expect((await unmounted.request('/v1/unrelated')).status).toBe(200);
  expect(rpc).not.toHaveBeenCalled();
});
it('adjacent methods and paths never inherit POST body handling', async () => {
  const instance = app();
  expect(
    (await instance.request(base + '/runs', { method: 'PUT', body: 'x'.repeat(10000) })).status,
  ).toBe(404);
  expect(
    (await instance.request(base + '/runs/extra', { method: 'POST', body: 'x'.repeat(10000) }))
      .status,
  ).toBe(404);
  expect(rpc).not.toHaveBeenCalled();
});
