import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsentClient, ConsentRecordProof } from './consent-client';
import {
  consentRequest,
  grantBody,
  listSchema,
  purposeSchema,
  recordSchema,
  versionSchema,
  type Purpose,
} from './consent-workflow';

const id = '11111111-1111-4111-8111-111111111111';
const sha = 'a'.repeat(64);
const purpose: Purpose = {
  id,
  purpose_key: 'marketing',
  name_en: 'Updates',
  name_hi: 'समाचार',
  lawful_basis: 'consent',
  notice_version: 3,
  notice_en: 'Receive updates.',
  notice_hi: 'समाचार प्राप्त करें।',
  is_active: true,
};
const values = (fields: Record<string, string> = {}) => {
  const form = new FormData();
  for (const [key, value] of Object.entries({
    principalType: 'email',
    principalRef: ' principal@example.test ',
    channel: 'form',
    confirmed: 'on',
    ...fields,
  }))
    form.set(key, value);
  return form;
};
afterEach(() => vi.unstubAllGlobals());

describe('recorded notice consent', () => {
  it.each(['en', 'hi'] as const)(
    'binds %s capture to the displayed purpose version and strips authoritative fields',
    (language) => {
      const body = grantBody(
        values({
          expectedNoticeVersion: '99',
          notice_snapshot_sha256: 'forged',
          tenantId: 'foreign',
          grantedAt: 'yesterday',
        }),
        purpose,
        language,
      );
      expect(body).toEqual({
        purposeId: id,
        expectedNoticeVersion: 3,
        principalType: 'email',
        principalRef: 'principal@example.test',
        language,
        channel: 'form',
      });
    },
  );
  it('refuses inactive or legitimate-use catalog entries rather than representing them as consent', () => {
    for (const candidate of [
      undefined,
      { ...purpose, is_active: false },
      { ...purpose, lawful_basis: 'legitimate_uses' as const },
    ])
      expect(() => grantBody(values(), candidate, 'en')).toThrow('active consent purpose');
  });
  it('requires the selected language notice and actual human acknowledgement', () => {
    expect(() => grantBody(values(), { ...purpose, notice_hi: null }, 'hi')).toThrow(
      'No reviewed notice',
    );
    expect(() => grantBody(values(), { ...purpose, notice_hi: '  ' }, 'hi')).toThrow(
      'No reviewed notice',
    );
    expect(() => grantBody(values({ confirmed: '' }), purpose, 'en')).toThrow(
      'Confirm the principal',
    );
    expect(() => grantBody(values({ principalRef: '  ' }), purpose, 'en')).toThrow(
      'principal identifier',
    );
  });
  it('preserves and renders the exact captured snapshot hash without implying a sealed artifact', () => {
    const record = recordSchema.parse({
      id,
      purpose_id: id,
      principal_type: 'email',
      principal_ref: 'principal@example.test',
      notice_version: 3,
      notice_snapshot_sha256: sha,
      language: 'hi',
      channel: 'offline',
      status: 'granted',
      granted_at: '2026-09-27T00:00:00Z',
      granted_by: '22222222-2222-4222-8222-222222222222',
      expires_at: '2026-09-28T00:00:00Z',
      legal_hold: false,
    });
    const html = renderToStaticMarkup(<ConsentRecordProof record={record} />);
    expect(html).toContain(`Notice snapshot SHA-256: ${sha}`);
    expect(html).toContain(id);
    expect(html).toContain('Channel: offline');
    expect(html).toContain('22222222-2222-4222-8222-222222222222');
    expect(html).toContain('2026-09-27T00:00:00Z');
    expect(html).toContain('2026-09-28T00:00:00Z');
    expect(html).toContain('does not change automatically at expiry');
    const withoutExpiry = renderToStaticMarkup(
      <ConsentRecordProof record={{ ...record, expires_at: null }} />,
    );
    expect(withoutExpiry).toContain('No expiry recorded');
    expect(withoutExpiry).not.toContain('Expires at');
    expect(html).not.toContain('sealed');
    expect(
      renderToStaticMarkup(
        <ConsentRecordProof record={{ ...record, notice_snapshot_sha256: null }} />,
      ),
    ).toContain('exact notice snapshot at capture is unproven');
    expect(
      renderToStaticMarkup(
        <ConsentRecordProof record={{ ...record, notice_snapshot_sha256: undefined }} />,
      ),
    ).toContain('Legacy record');
    expect(recordSchema.safeParse({ ...record, notice_snapshot_sha256: 'wrong' }).success).toBe(
      false,
    );
  });
  it('keeps loaded-empty, unavailable and bounded lists distinguishable', () => {
    expect(listSchema(purposeSchema).parse({ data: [], meta: { hasMore: false } })).toEqual({
      data: [],
      meta: { hasMore: false },
    });
    expect(listSchema(purposeSchema).safeParse({ error: { code: 'query_failed' } }).success).toBe(
      false,
    );
    expect(listSchema(purposeSchema).safeParse({ data: [] }).success).toBe(false);
    expect(
      listSchema(purposeSchema).parse({ data: [purpose], meta: { hasMore: true } }).meta.hasMore,
    ).toBe(true);
    expect(
      versionSchema.safeParse({
        purpose_id: id,
        notice_version: 1,
        notice_en: 'Old',
        notice_hi: null,
        snapshot_sha256: sha,
        provenance: 'legacy_current',
        created_at: '2026-09-27T00:00:00Z',
      }).success,
    ).toBe(true);
  });
  it('server render shows loading without fabricated empty lists or grant counts', () => {
    const html = renderToStaticMarkup(<ConsentClient tenantId={id} canManage={false} />);
    expect(html).toContain('Loading consent records');
    expect(html).toContain('Read-only access');
    expect(html).not.toContain('No consent records found');
    expect(html).not.toContain('Record consent');
    expect(html).not.toContain('98.7');
  });
});

describe('consent BFF bridge requests', () => {
  it('pins tenant and retry key without sending clocks or credentials and retains Hindi text', async () => {
    const fetcher = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ data: { purpose_id: id, notice_version: 4 } }), {
          status: 201,
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const body = {
      expectedNoticeVersion: 3,
      noticeEn: 'English',
      noticeHi: 'हिन्दी',
      reviewed: true,
    };
    for (let attempt = 0; attempt < 2; attempt++)
      await consentRequest(id, `/purposes/${id}/versions`, body, 'stable-attempt');
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, options] of fetcher.mock.calls) {
      expect(options).toMatchObject({
        method: 'POST',
        cache: 'no-store',
        headers: { 'x-tenant-id': id, 'Idempotency-Key': 'stable-attempt' },
        body: JSON.stringify(body),
      });
    }
  });
  it('binds cancellable reads to the rendered tenant without an idempotency header', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{"data":[],"meta":{"hasMore":false}}'));
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    await consentRequest(id, '/records', undefined, undefined, controller.signal);
    expect(fetcher).toHaveBeenCalledWith(
      '/api/bff/v1/consent/records',
      expect.objectContaining({
        method: 'GET',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'x-tenant-id': id },
      }),
    );
  });
  it.each(['notice_version_conflict', 'legal_hold_active', 'purpose_inactive', 'forbidden'])(
    'surfaces %s verbatim and does not retry it',
    async (code) => {
      const fetcher = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code } }), {
          status: code === 'forbidden' ? 403 : 409,
        }),
      );
      vi.stubGlobal('fetch', fetcher);
      await expect(consentRequest(id, '/records', {}, 'attempt')).rejects.toThrow(code);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('refuses malformed success including missing capture hashes and wrong mutation receipts', async () => {
    for (const payload of [
      { data: {} },
      { data: { consent_id: id, status: 'granted', notice_version: 3 } },
      { data: { purpose_id: id, notice_version: 3 } },
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload))));
      await expect(consentRequest(id, '/records', {}, 'attempt')).rejects.toThrow(
        'could not be confirmed',
      );
    }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: {
              consent_id: id,
              status: 'granted',
              notice_version: 3,
              notice_snapshot_sha256: sha,
            },
          }),
        ),
      ),
    );
    await expect(consentRequest(id, '/records', {}, 'attempt')).resolves.toMatchObject({
      data: { notice_snapshot_sha256: sha },
    });
  });
  it('reports uncertain writes without exposing transport details or replaying automatically', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('principal private details'));
    vi.stubGlobal('fetch', fetcher);
    await expect(consentRequest(id, '/records', {}, 'attempt')).rejects.toThrow('before retrying');
    await expect(consentRequest(id, '/records')).rejects.toThrow('Records could not be loaded');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
