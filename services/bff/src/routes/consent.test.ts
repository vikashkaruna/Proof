import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const FOREIGN = '99999999-9999-4999-8999-999999999999';
const USER = '00000000-0000-4000-8000-0000000000aa';
const PURPOSE = '22222222-2222-4222-8222-22222222000a';
const RECORD = '22222222-2222-4222-8222-22222222000b';
const WITHDRAWAL = '22222222-2222-4222-8222-22222222000c';
const NOW = '2026-09-27T08:00:00.000Z';
const state = vi.hoisted(() => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    SUPABASE_URL: 'https://local.supabase.co',
    SUPABASE_ANON_KEY: 'a'.repeat(40),
    SUPABASE_SERVICE_KEY: 'b'.repeat(40),
    APPROVAL_SIGNING_KEY: 'k'.repeat(48),
  });
  return { db: null as FakeDb | null };
});
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));
vi.mock('@axiom/supabase', () => ({ createSupabaseAdmin: () => state.db!.client }));
let fake: FakeDb;
let calls: { fn: string; args: Record<string, unknown> }[];
const grant = {
  purposeId: PURPOSE,
  expectedNoticeVersion: 1,
  principalType: 'cookie_id',
  principalRef: 'consent-fixture',
  language: 'hi',
  channel: 'form',
};
const purpose = {
  purposeKey: 'newsletter',
  nameEn: 'Newsletter',
  nameHi: 'समाचार',
  lawfulBasis: 'consent',
  noticeEn: 'Email the monthly newsletter.',
  noticeHi: 'मासिक समाचार ईमेल करें।',
  reviewed: true,
};
const publication = {
  expectedNoticeVersion: 1,
  noticeEn: 'Revised notice.',
  noticeHi: 'संशोधित सूचना।',
  reviewed: true,
};
const writes = [
  {
    path: '/records',
    body: grant,
    fn: 'record_consent',
    actor: 'p_granted_by',
    result: {
      consent_id: RECORD,
      status: 'granted',
      notice_version: 1,
      notice_snapshot_sha256: 'a'.repeat(64),
    },
    status: 201,
    refusals: [
      'invalid_request',
      'purpose_not_found',
      'purpose_inactive',
      'already_granted',
      'stale_notice_version',
      'missing_notice',
      'notice_unavailable',
      'consent_not_applicable',
      'forbidden',
    ],
  },
  {
    path: `/records/${RECORD}/withdraw`,
    body: { language: 'hi', reason: 'No longer needed' },
    fn: 'withdraw_consent',
    actor: 'p_requested_by',
    result: { consent_id: RECORD, withdrawal_id: WITHDRAWAL, withdrawn_at: NOW },
    status: 200,
    refusals: ['invalid_request', 'not_found', 'already_withdrawn'],
  },
  {
    path: `/records/${RECORD}/legal-hold`,
    body: { hold: true },
    fn: 'set_consent_legal_hold',
    actor: 'p_held_by',
    result: { consent_id: RECORD, legal_hold: true },
    status: 200,
    refusals: ['invalid_request', 'not_found'],
  },
  {
    path: `/withdrawals/${WITHDRAWAL}/complete`,
    body: {},
    fn: 'complete_withdrawal_downstream',
    actor: 'p_completed_by',
    result: { withdrawal_id: WITHDRAWAL, completed_at: NOW },
    status: 200,
    refusals: ['invalid_request', 'not_found', 'already_completed'],
  },
  {
    path: '/purposes',
    body: purpose,
    fn: 'register_consent_purpose',
    actor: 'p_created_by',
    result: { purpose_id: PURPOSE, notice_version: 1 },
    status: 201,
    refusals: ['invalid_request', 'purpose_exists', 'forbidden'],
  },
  {
    path: `/purposes/${PURPOSE}/versions`,
    body: publication,
    fn: 'publish_consent_notice',
    actor: 'p_published_by',
    result: { purpose_id: PURPOSE, notice_version: 2 },
    status: 201,
    refusals: [
      'invalid_request',
      'purpose_not_found',
      'stale_notice_version',
      'version_exhausted',
      'forbidden',
    ],
  },
  {
    path: `/purposes/${PURPOSE}/status`,
    body: { active: false },
    fn: 'set_consent_purpose_active',
    actor: 'p_changed_by',
    result: { purpose_id: PURPOSE, is_active: false },
    status: 200,
    refusals: ['invalid_request', 'purpose_not_found', 'status_unchanged', 'forbidden'],
  },
];

beforeEach(() => {
  fake = createFakeDb();
  state.db = fake;
  calls = [];
  for (const write of writes) {
    fake.onRpc(write.fn, (args) => {
      calls.push({ fn: write.fn, args });
      return write.result;
    });
  }
});

async function app(role: UserRole = UserRole.ADMIN, tenant = TENANT) {
  const { v1Routes } = await import('./v1.js');
  const instance = new Hono<{ Variables: Variables }>();
  instance.use('*', async (c, next) => {
    c.set('user', { id: USER } as never);
    c.set('tenantId', tenant);
    c.set('role', role);
    c.set('approvalScopes', []);
    await next();
  });
  instance.route(
    '/v1',
    v1Routes({
      approvalEngine: {} as never,
      killSwitch: {} as never,
      ledger: {} as never,
      mfa: {} as never,
      realtime: {} as never,
    }),
  );
  return instance;
}
async function post(path: string, body: unknown, role: UserRole = UserRole.ADMIN, tenant = TENANT) {
  return (await app(role, tenant)).request(`/v1/consent${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('consent route authority and RPC contracts', () => {
  for (const write of writes) {
    it(`${write.fn} binds tenant, actor and fresh correlation to the authenticated context`, async () => {
      const res = await post(write.path, write.body);
      expect(res.status).toBe(write.status);
      expect(await res.json()).toEqual({ data: write.result });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.fn).toBe(write.fn);
      expect(calls[0]?.args).toMatchObject({ p_tenant_id: TENANT, [write.actor]: USER });
      const firstCorrelation = calls[0]?.args.p_correlation_id;
      expect(firstCorrelation).toMatch(/^[0-9a-f-]{36}$/);
      await post(write.path, write.body, UserRole.ADMIN, FOREIGN);
      expect(calls[1]?.args.p_tenant_id).toBe(FOREIGN);
      expect(calls[1]?.args.p_correlation_id).not.toBe(firstCorrelation);
    });
    it.each([UserRole.AGENT, UserRole.VIEWER, UserRole.AXIOM_ANALYST, UserRole.APPROVER])(
      `${write.fn} refuses %s before touching the RPC`,
      async (role) => {
        expect((await post(write.path, write.body, role)).status).toBe(403);
        expect(calls).toHaveLength(0);
      },
    );
    it.each(write.refusals)(`${write.fn} preserves domain refusal %s as409`, async (code) => {
      fake.onRpc(write.fn, () => ({ error: code }));
      const res = await post(write.path, write.body);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: { code } });
    });
    it(`${write.fn} refuses tenant, actor and clock spoofing`, async () => {
      for (const injected of [
        { tenantId: FOREIGN },
        { [write.actor]: FOREIGN },
        { correlationId: FOREIGN },
        { grantedAt: NOW },
        { downstreamCompletedAt: NOW },
      ]) {
        expect((await post(write.path, { ...write.body, ...injected })).status).toBe(400);
      }
      expect(calls).toHaveLength(0);
    });
    it(`${write.fn} fails closed on transport errors or malformed success`, async () => {
      fake.failNextRpc(write.fn);
      expect((await post(write.path, write.body)).status).toBe(500);
      const idField =
        'consent_id' in write.result
          ? 'consent_id'
          : 'purpose_id' in write.result
            ? 'purpose_id'
            : 'withdrawal_id';
      for (const result of [null, {}, { ok: true }, { ...write.result, [idField]: 'bad' }]) {
        fake.onRpc(write.fn, () => result);
        const res = await post(write.path, write.body);
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: { code: 'persistence_failed' } });
      }
    });
    it(`${write.fn} rejects malformed JSON`, async () => {
      const res = await (
        await app()
      ).request(`/v1/consent${write.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });
  }

  it('passes every grant argument explicitly while leaving principal shape and expiry semantics to the RPC', async () => {
    await post('/records', grant);
    expect(calls[0]?.args).toEqual({
      p_tenant_id: TENANT,
      p_purpose_id: PURPOSE,
      p_expected_notice_version: 1,
      p_principal_type: 'cookie_id',
      p_principal_ref: 'consent-fixture',
      p_language: 'hi',
      p_channel: 'form',
      p_expires_at: null,
      p_granted_by: USER,
      p_correlation_id: expect.any(String),
    });
    await post('/records', { ...grant, expiresAt: NOW });
    expect(calls[1]?.args.p_expires_at).toBe(NOW);
  });
  it.each([
    { purposeId: 'not-a-uuid' },
    { expectedNoticeVersion: 0 },
    { expectedNoticeVersion: 1.5 },
    { principalType: 'free_text' },
    { principalRef: 'x'.repeat(321) },
    { language: 'fr' },
    { channel: 'agent' },
    { expiresAt: 'tomorrow' },
  ])('rejects invalid grant fields %j', async (patch) => {
    expect((await post('/records', { ...grant, ...patch })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it('passes withdrawal intent and an explicit nullable reason, never a timestamp', async () => {
    await post(`/records/${RECORD}/withdraw`, { language: 'en' });
    expect(calls[0]?.args).toEqual({
      p_tenant_id: TENANT,
      p_consent_record_id: RECORD,
      p_reason: null,
      p_language: 'en',
      p_requested_by: USER,
      p_correlation_id: expect.any(String),
    });
    expect(
      (await post(`/records/${RECORD}/withdraw`, { language: 'en', reason: 'x'.repeat(501) }))
        .status,
    ).toBe(400);
  });
  it('can explicitly release a legal hold without truthy string coercion', async () => {
    await post(`/records/${RECORD}/legal-hold`, { hold: false });
    expect(calls[0]?.args.p_hold).toBe(false);
    expect((await post(`/records/${RECORD}/legal-hold`, { hold: 'false' })).status).toBe(400);
  });
  it.each(writes.filter((write) => /[0-9a-f]{8}-/.test(write.path)))(
    'rejects malformed path IDs before $fn',
    async (write) => {
      expect(
        (
          await post(
            write.path.replace(RECORD, 'bad').replace(WITHDRAWAL, 'bad').replace(PURPOSE, 'bad'),
            write.body,
          )
        ).status,
      ).toBe(400);
      expect(calls).toHaveLength(0);
    },
  );
});

describe('consent reads are real tenant-scoped bounded lists', () => {
  for (const table of ['purposes', 'records', 'withdrawals']) {
    it(`${table} shows only the selected tenant, with honest empty state`, async () => {
      fake.seed(`consent_${table}`, { id: RECORD, tenant_id: TENANT, created_at: NOW });
      fake.seed(`consent_${table}`, { id: WITHDRAWAL, tenant_id: FOREIGN, created_at: NOW });
      const res = await (await app(UserRole.VIEWER)).request(`/v1/consent/${table}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { id: string }[]; meta: { hasMore: boolean } };
      expect(body.data.map((r) => r.id)).toEqual([RECORD]);
      expect(body.meta.hasMore).toBe(false);
      const empty = await (await app(UserRole.VIEWER, PURPOSE)).request(`/v1/consent/${table}`);
      expect(await empty.json()).toEqual({ data: [], meta: { hasMore: false } });
    });
    it(`${table} distinguishes incomplete lists from full results`, async () => {
      for (let index = 0; index < 201; index++) {
        fake.seed(`consent_${table}`, { id: String(index), tenant_id: TENANT, created_at: NOW });
      }
      const res = await (await app()).request(`/v1/consent/${table}`);
      const body = (await res.json()) as { data: unknown[]; meta: { hasMore: boolean } };
      expect(body.data).toHaveLength(200);
      expect(body.meta.hasMore).toBe(true);
    });
    it(`${table} refuses an agent and does not conceal database failure as an empty list`, async () => {
      expect((await (await app(UserRole.AGENT)).request(`/v1/consent/${table}`)).status).toBe(403);
      fake.failNext(`consent_${table}`);
      const res = await (await app()).request(`/v1/consent/${table}`);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: { code: 'query_failed' } });
    });
  }
  it('has no delete surface', async () => {
    const instance = await app();
    expect(
      (await instance.request(`/v1/consent/records/${RECORD}`, { method: 'DELETE' })).status,
    ).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe('reviewed purpose and immutable notice route contracts', () => {
  it('records bilingual registration and explicit human review, with nullable descriptions', async () => {
    await post('/purposes', purpose);
    expect(calls[0]?.args).toEqual({
      p_tenant_id: TENANT,
      p_purpose_key: purpose.purposeKey,
      p_name_en: purpose.nameEn,
      p_name_hi: purpose.nameHi,
      p_description_en: null,
      p_description_hi: null,
      p_lawful_basis: 'consent',
      p_notice_en: purpose.noticeEn,
      p_notice_hi: purpose.noticeHi,
      p_reviewed: true,
      p_created_by: USER,
      p_correlation_id: expect.any(String),
    });
  });
  it.each([
    { reviewed: false },
    { reviewed: undefined },
    { noticeHi: null },
    { noticeHi: '   ' },
    { noticeEn: '' },
    { noticeEn: 'x'.repeat(20001) },
  ])(
    'requires bounded bilingual reviewed notice at register and publication: %j',
    async (patch) => {
      expect((await post('/purposes', { ...purpose, ...patch })).status).toBe(400);
      expect(
        (await post(`/purposes/${PURPOSE}/versions`, { ...publication, ...patch })).status,
      ).toBe(400);
      expect(calls).toHaveLength(0);
    },
  );
  it('binds publication to the version the caller reviewed and the human publisher', async () => {
    await post(`/purposes/${PURPOSE}/versions`, publication);
    expect(calls[0]?.args).toEqual({
      p_tenant_id: TENANT,
      p_purpose_id: PURPOSE,
      p_expected_notice_version: 1,
      p_notice_en: publication.noticeEn,
      p_notice_hi: publication.noticeHi,
      p_reviewed: true,
      p_published_by: USER,
      p_correlation_id: expect.any(String),
    });
  });
  it('passes explicit activation state with caller authority', async () => {
    await post(`/purposes/${PURPOSE}/status`, { active: false });
    expect(calls[0]?.args).toEqual({
      p_tenant_id: TENANT,
      p_purpose_id: PURPOSE,
      p_is_active: false,
      p_changed_by: USER,
      p_correlation_id: expect.any(String),
    });
    expect((await post(`/purposes/${PURPOSE}/status`, { active: 'true' })).status).toBe(400);
  });
  it('rejects grant or publication without an expected version', async () => {
    const { expectedNoticeVersion: _grantVersion, ...unboundGrant } = grant;
    const { expectedNoticeVersion: _publishVersion, ...unboundPublication } = publication;
    expect((await post('/records', unboundGrant)).status).toBe(400);
    expect((await post(`/purposes/${PURPOSE}/versions`, unboundPublication)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it('reads immutable history scoped by tenant AND purpose and preserves legacy provenance', async () => {
    for (const [tenant, purposeId, version] of [
      [TENANT, PURPOSE, 1],
      [TENANT, RECORD, 7],
      [FOREIGN, PURPOSE, 9],
    ] as const) {
      fake.seed('consent_notice_versions', {
        tenant_id: tenant,
        purpose_id: purposeId,
        notice_version: version,
        provenance: 'legacy_current',
      });
    }
    const res = await (await app()).request(`/v1/consent/purposes/${PURPOSE}/versions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { notice_version: number; provenance: string }[];
      meta: { hasMore: boolean };
    };
    expect(body.data.map((row) => row.notice_version)).toEqual([1]);
    expect(body.data[0]?.provenance).toBe('legacy_current');
    expect(body.meta.hasMore).toBe(false);
  });
  it('refuses unprivileged, malformed and unavailable history reads', async () => {
    expect(
      (await (await app(UserRole.AGENT)).request(`/v1/consent/purposes/${PURPOSE}/versions`))
        .status,
    ).toBe(403);
    expect((await (await app()).request('/v1/consent/purposes/bad/versions')).status).toBe(400);
    fake.failNext('consent_notice_versions');
    const res = await (await app()).request(`/v1/consent/purposes/${PURPOSE}/versions`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'query_failed' } });
  });
});
