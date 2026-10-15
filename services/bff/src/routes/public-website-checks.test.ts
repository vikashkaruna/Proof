import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';
import { PublicWebsiteRefused, type WebsiteCheck } from '../connectors/public-website.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const FOREIGN = '22222222-2222-4222-8222-222222222222';
const USER = '00000000-0000-4000-8000-000000000001';
const check: WebsiteCheck = {
  requestedUrl: 'https://public.org/',
  finalUrl: 'https://public.org/',
  checkedAt: '2026-10-04T00:00:00.000Z',
  status: 'checked',
  httpStatus: 200,
  bytes: 32,
  contentSha256: 'a'.repeat(64),
  title: 'Public notice',
  headings: ['Privacy'],
  publicLinks: [{ label: 'Privacy', url: 'https://public.org/privacy' }],
  auditPages: [
    {
      kind: 'privacy',
      requestedUrl: 'https://public.org/privacy',
      status: 'checked',
      finalUrl: 'https://public.org/privacy',
      title: 'Privacy',
      contentSha256: 'b'.repeat(64),
    },
  ],
  observations: [
    { kind: 'privacy', status: 'retrieved' },
    { kind: 'contact', status: 'not_linked' },
    { kind: 'terms', status: 'not_linked' },
  ],
};
const db = vi.hoisted(() => ({ current: null as FakeDb | null }));
vi.mock('@axiom/supabase', () => ({
  createSupabaseAdmin: () => db.current!.client,
  createHumanActionWriter: () => db.current!.client,
}));
import { validateFreshPublicCapture } from '../connectors/public-capture-validation-v2.js';
import { encodePublicEvidencePayloadV2 } from '../connectors/public-evidence-codec-v2.js';
import { publicWebsiteCheckRoutes } from './public-website-checks.js';

function captureFixture(result: WebsiteCheck) {
  const pages = (['root', 'privacy', 'contact', 'terms', 'consent'] as const).map((page) => {
    const audit = result.auditPages.find((p) => p.kind === page);
    return {
      page,
      state:
        page === 'root' || audit?.status === 'checked'
          ? ('examined' as const)
          : ('unexamined' as const),
      ...(page === 'root'
        ? { contentSha256: result.contentSha256 }
        : audit?.contentSha256
          ? { contentSha256: audit.contentSha256 }
          : {}),
      truncated: false,
      coverageReasons: [],
    };
  });
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
    check: result,
    evidence: {
      codec: encoded.codec,
      payloadText: encoded.payloadText,
      payloadSha256: encoded.payloadSha256,
      pageSources: pages.map((p) => ({
        page: p.page,
        state: p.state,
        contentSha256: p.contentSha256 ?? null,
        requestedUrl:
          p.page === 'root'
            ? result.requestedUrl
            : (result.auditPages.find((a) => a.kind === p.page)?.requestedUrl ?? null),
        finalUrl:
          p.page === 'root'
            ? result.finalUrl
            : (result.auditPages.find((a) => a.kind === p.page)?.finalUrl ?? null),
      })),
    },
  };
}

let fake: FakeDb;
let recorded: Record<string, unknown>[];
beforeEach(() => {
  fake = createFakeDb({
    public_website_checks: [
      {
        id: '1',
        tenant_id: FOREIGN,
        status: 'checked',
        checked_at: '2026-10-04',
        result: { ...check, title: 'Foreign' },
      },
      { id: '2', tenant_id: TENANT, status: 'checked', checked_at: '2026-10-04', result: check },
      { id: '3', tenant_id: TENANT, status: 'failed', checked_at: '2026-10-04', result: null },
    ],
  });
  db.current = fake;
  recorded = [];
  fake.onRpc('record_public_website_control_capture', (args) => {
    recorded.push(args);
    return { id: 'new-check' };
  });
});
function app(role: UserRole, probe = async () => check) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: USER } as never);
    c.set('tenantId', TENANT as never);
    c.set('role', role);
    await next();
  });
  app.route(
    '/v1',
    publicWebsiteCheckRoutes({ capture: async () => captureFixture(await probe()) }),
  );
  return app;
}
const post = (role: UserRole, probe?: () => Promise<WebsiteCheck>) =>
  app(role, probe).request('/v1/public-website-checks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://public.org/' }),
  });

describe('public website check API', () => {
  it('shows only current-tenant successful observations to read roles', async () => {
    const response = await app(UserRole.VIEWER).request('/v1/public-website-checks');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [{ id: '2', ...check }] });
  });

  it('fails closed on a malformed stored observation instead of showing partial evidence', async () => {
    fake.seed('public_website_checks', {
      id: '4',
      tenant_id: TENANT,
      status: 'checked',
      checked_at: '2026-10-05',
      result: { title: 'Partial' },
    });
    const response = await app(UserRole.VIEWER).request('/v1/public-website-checks');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'website_checks_unavailable' } });
  });

  it('records a human-triggered owner check and returns its exact metadata', async () => {
    const response = await post(UserRole.OWNER);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ data: { id: 'new-check', ...check } });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      p_tenant_id: TENANT,
      p_actor_id: USER,
      p_requested_url: check.requestedUrl,
      p_final_url: check.finalUrl,
      p_result: check,
    });
  });

  it.each([UserRole.VIEWER, UserRole.PARTNER, UserRole.REVIEWER, UserRole.APPROVER])(
    'refuses %s before any outbound check',
    async (role) => {
      let probes = 0;
      const response = await post(role, async () => {
        probes++;
        return check;
      });
      expect(response.status).toBe(403);
      expect(probes).toBe(0);
      expect(recorded).toHaveLength(0);
    },
  );

  it('returns controlled fetch refusals without recording a false success', async () => {
    const response = await post(UserRole.OWNER, async () => {
      throw new PublicWebsiteRefused('non_public_target');
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: 'non_public_target' } });
    expect(recorded).toHaveLength(0);
  });

  it('refuses an exhausted or unavailable shared budget before outbound fetch', async () => {
    let probes = 0;
    fake.onRpc('take_rate_limit', () => ({ allowed: false, retry_after: 60 }));
    const limited = await post(UserRole.OWNER, async () => {
      probes++;
      return check;
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    expect(probes).toBe(0);
    fake.failNextRpc('take_rate_limit');
    const unavailable = await post(UserRole.OWNER, async () => {
      probes++;
      return check;
    });
    expect(unavailable.status).toBe(503);
    expect(probes).toBe(0);
  });

  it('fails closed when the human audit writer is unavailable', async () => {
    fake.failNextRpc('record_public_website_control_capture');
    const response = await post(UserRole.OWNER);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'website_check_record_unavailable' } });
  });
});

describe('versioned public form metadata storage boundary', () => {
  const metadata = {
    version: 1 as const,
    scope: 'static_html_form_descendants' as const,
    sourceSha256: check.contentSha256,
    observedFormCount: 0,
    formsTruncated: false,
    forms: [],
  };
  it('preserves optional per-page metadata through the human writer and tenant list', async () => {
    const observed = {
      ...check,
      formMetadata: metadata,
      auditPages: check.auditPages.map((page) => ({
        ...page,
        formMetadata: { ...metadata, sourceSha256: page.contentSha256! },
      })),
    };
    const response = await post(UserRole.OWNER, async () => observed);
    expect(response.status).toBe(201);
    expect(recorded[0]?.p_result).toEqual(observed);
    fake.seed('public_website_checks', {
      id: 'metadata-check',
      tenant_id: TENANT,
      status: 'checked',
      checked_at: '2026-10-05',
      result: observed,
    });
    const history = await app(UserRole.VIEWER).request('/v1/public-website-checks');
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({
      data: expect.arrayContaining([{ id: 'metadata-check', ...observed }]),
    });
  });

  it.each([
    { ...check, formMetadata: { ...metadata, sourceSha256: 'c'.repeat(64) } },
    { ...check, formMetadata: { ...metadata, rawValue: 'not permitted' } },
    { ...check, formMetadata: { ...metadata, observedFormCount: 1 } },
    { ...check, auditPages: [{ ...check.auditPages[0], formMetadata: metadata }] },
    {
      ...check,
      auditPages: [
        {
          kind: 'contact',
          requestedUrl: 'https://public.org/contact',
          status: 'unavailable',
          formMetadata: metadata,
        },
      ],
    },
  ])(
    'refuses malformed or unbound page metadata before recording and on list %#',
    async (observed) => {
      const response = await post(UserRole.OWNER, async () => observed as WebsiteCheck);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { code: 'website_check_invalid_result' } });
      expect(recorded).toHaveLength(0);
      fake.seed('public_website_checks', {
        id: 'invalid-metadata',
        tenant_id: TENANT,
        status: 'checked',
        checked_at: '2026-10-05',
        result: observed,
      });
      const history = await app(UserRole.VIEWER).request('/v1/public-website-checks');
      expect(history.status).toBe(503);
      expect(await history.json()).toEqual({ error: { code: 'website_checks_unavailable' } });
    },
  );

  it('refuses excessive UTF-8 total results even when each bounded string is valid', async () => {
    const observed = {
      ...check,
      formMetadata: metadata,
      headings: Array.from({ length: 12 }, () => '界'.repeat(300)),
      publicLinks: Array.from({ length: 12 }, () => ({
        label: '界'.repeat(300),
        url: 'https://public.org/' + 'a'.repeat(1800),
      })),
    };
    expect(Buffer.byteLength(JSON.stringify(observed), 'utf8')).toBeGreaterThan(32_768);
    const response = await post(UserRole.OWNER, async () => observed);
    expect(response.status).toBe(503);
    expect(recorded).toHaveLength(0);
  });
});

describe('fresh evidence atomic capture boundary', () => {
  it('sends canonical evidence and provenance to the same atomic record RPC', async () => {
    expect((await post(UserRole.OWNER)).status).toBe(201);
    const args = recorded[0]!;
    expect(args.p_codec).toBe('axiom-public-evidence-v2-canonical-json-1');
    expect(args.p_payload_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(args.p_page_sources).toHaveLength(5);
    expect(JSON.parse(String(args.p_payload_text)).pages[0].contentSha256).toBe(
      check.contentSha256,
    );
    expect(args.p_result).toEqual(check);
  });
});

it.each([
  'hash',
  'bytes',
  'root',
  'foreign_origin',
  'missing_page',
  'duplicate_page',
  'unexamined_url',
  'final_url',
])('refuses invalid fresh evidence provenance before any write: %s', (kind) => {
  const capture = captureFixture(check);
  expect(validateFreshPublicCapture(capture)).toBe(true);
  if (kind === 'hash') capture.evidence.payloadSha256 = 'f'.repeat(64);
  if (kind === 'bytes') capture.evidence.payloadText += ' ';
  if (kind === 'root') capture.check = { ...check, contentSha256: 'f'.repeat(64) };
  if (kind === 'foreign_origin')
    capture.evidence.pageSources[1]!.finalUrl = 'https://foreign.org/privacy';
  if (kind === 'missing_page') capture.evidence.pageSources.pop();
  if (kind === 'duplicate_page') capture.evidence.pageSources[2]!.page = 'root';
  if (kind === 'unexamined_url')
    capture.evidence.pageSources[4]!.requestedUrl = 'https://public.org/consent';
  if (kind === 'final_url')
    capture.evidence.pageSources[0]!.finalUrl = 'https://public.org/changed';
  expect(validateFreshPublicCapture(capture)).toBe(false);
});
