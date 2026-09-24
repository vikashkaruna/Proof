import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { ContactDeliveryResult, ContactInquiryMail } from '../services/contact-email.js';
import { sendContactInquiryEmail } from '../services/contact-email.js';
import { publicRoutes } from './public.js';
vi.mock('@axiom/supabase', () => ({ createSupabaseAdmin: vi.fn() }));

let db: FakeDb;
const send = vi.fn(async (_m: ContactInquiryMail): Promise<ContactDeliveryResult> => ({
  status: 'sent',
  providerMessageId: 're_receipt',
}));
const app = () => publicRoutes({ client: () => db.client as never, sendContactEmail: send });
const reply = z.object({
  id: z.uuid(),
  delivery: z.enum(['not_configured', 'pending', 'sent', 'failed']),
});
const input = {
  name: 'Ravi Sharma',
  email: 'Ravi@Example.invalid',
  company: 'Acme',
  message: 'We would like a walkthrough next week.',
};
const post = (body: unknown) =>
  app().request('/contact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  db = createFakeDb();
  send.mockClear();
  vi.stubEnv('AXIOM_CONTACT_EMAIL_MODE', 'disabled');
  vi.stubEnv('RESEND_API_KEY', 'test-provider-key');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('public contact inquiries (C-W0-6)', () => {
  it('persists durably and reports not_configured without attempting mail', async () => {
    const res = await post(input);
    expect(res.status).toBe(201);
    const body = reply.parse(await res.json());
    expect(body.delivery).toBe('not_configured');
    expect(send).not.toHaveBeenCalled();
    const [row] = db.rows('contact_inquiries');
    expect(row).toMatchObject({
      id: body.id,
      name: input.name,
      email: input.email,
      company: 'Acme',
      message: input.message,
      delivery_status: 'not_configured',
      delivery_attempted_at: null,
    });
    // A fresh route instance reads the same storage: nothing lives in process memory.
    expect(db.rows('contact_inquiries')).toHaveLength(1);
  });

  it('never enables delivery from the report mail mode or a missing key', async () => {
    vi.stubEnv('AXIOM_REPORT_EMAIL_MODE', 'delivery');
    expect(reply.parse(await (await post(input)).json()).delivery).toBe('not_configured');
    vi.stubEnv('AXIOM_CONTACT_EMAIL_MODE', 'delivery');
    vi.stubEnv('RESEND_API_KEY', ' ');
    expect(reply.parse(await (await post(input)).json()).delivery).toBe('not_configured');
    expect(send).not.toHaveBeenCalled();
  });

  it('records a provider receipt only after a sent outcome', async () => {
    vi.stubEnv('AXIOM_CONTACT_EMAIL_MODE', 'delivery');
    const body = reply.parse(await (await post(input)).json());
    expect(body.delivery).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ id: body.id, email: input.email });
    expect(db.rows('contact_inquiries')[0]).toMatchObject({
      delivery_status: 'sent',
      provider_message_id: 're_receipt',
    });
    expect(db.rows('contact_inquiries')[0]!.delivery_completed_at).toEqual(expect.any(String));
  });

  it('reports failed delivery honestly while keeping the stored inquiry', async () => {
    vi.stubEnv('AXIOM_CONTACT_EMAIL_MODE', 'delivery');
    send.mockResolvedValueOnce({ status: 'failed', errorCode: 'provider_refused' });
    const body = reply.parse(await (await post(input)).json());
    expect(body.delivery).toBe('failed');
    expect(db.rows('contact_inquiries')[0]).toMatchObject({
      delivery_status: 'failed',
      delivery_error_code: 'provider_refused',
    });
    send.mockRejectedValueOnce(new Error('boom'));
    expect(reply.parse(await (await post(input)).json()).delivery).toBe('failed');
  });

  it('leaves the outcome pending when the settlement cannot be recorded', async () => {
    vi.stubEnv('AXIOM_CONTACT_EMAIL_MODE', 'delivery');
    send.mockImplementationOnce(async () => {
      db.failNext('contact_inquiries');
      return { status: 'sent', providerMessageId: 're_lost' };
    });
    const body = reply.parse(await (await post(input)).json());
    expect(body.delivery).toBe('pending');
    expect(db.rows('contact_inquiries')[0]).toMatchObject({ delivery_status: 'pending' });
  });

  it('refuses success when persistence fails and sends nothing', async () => {
    vi.stubEnv('AXIOM_CONTACT_EMAIL_MODE', 'delivery');
    db.failNext('contact_inquiries');
    const res = await post(input);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'persistence_failed' } });
    expect(send).not.toHaveBeenCalled();
  });

  it('validates input with field errors and stores nothing', async () => {
    const res = await post({ ...input, email: 'not-an-email', message: 'short' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: { fieldErrors: object } } };
    expect(Object.keys(body.error.details.fieldErrors)).toEqual(
      expect.arrayContaining(['email', 'message']),
    );
    expect(db.rows('contact_inquiries')).toHaveLength(0);
  });

  it('bounds submissions per sender, case-insensitively', async () => {
    for (let i = 0; i < 5; i++) expect((await post(input)).status).toBe(201);
    const limited = await post({ ...input, email: 'ravi@example.INVALID' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('3600');
    expect(db.rows('contact_inquiries')).toHaveLength(5);
    expect((await post({ ...input, email: 'other@example.invalid' })).status).toBe(201);
  });

  it('fails closed when the rate budget is unavailable', async () => {
    db.failNextRpc('take_rate_limit');
    expect((await post(input)).status).toBe(503);
    expect(db.rows('contact_inquiries')).toHaveLength(0);
  });
});

describe('contact provider adapter', () => {
  const mail: ContactInquiryMail = {
    id: '00000000-0000-4000-8000-0000000000c1',
    name: '<b>Ravi</b>',
    email: 'ravi@example.invalid',
    message: 'Hello <script>alert(1)</script> there',
    receivedAt: '2026-09-24T00:00:00.000Z',
  };
  beforeEach(() => vi.stubEnv('RESEND_API_KEY', 'test-provider-key'));

  it('requires a provider receipt and escapes submitted content', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 're_1' })));
    vi.stubGlobal('fetch', fetchMock);
    expect(await sendContactInquiryEmail(mail)).toEqual({
      status: 'sent',
      providerMessageId: 're_1',
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(init.body)) as { html: string; reply_to: string };
    expect(sent.html).not.toContain('<script>');
    expect(sent.html).toContain('&lt;script&gt;');
    expect(sent.reply_to).toBe(mail.email);
    expect(init.redirect).toBe('error');
  });

  it('maps refusal, missing receipt and network failure to failed outcomes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 422 })),
    );
    expect(await sendContactInquiryEmail(mail)).toEqual({
      status: 'failed',
      errorCode: 'provider_refused',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}')),
    );
    expect(await sendContactInquiryEmail(mail)).toEqual({
      status: 'failed',
      errorCode: 'provider_no_receipt',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('down');
      }),
    );
    expect(await sendContactInquiryEmail(mail)).toEqual({
      status: 'failed',
      errorCode: 'provider_unavailable',
    });
  });
});

describe('contact delivery configuration', () => {
  it('reports only whether delivery is enabled, never inquiry data', async () => {
    const read = async () =>
      (await app().request('/contact/config')).json() as Promise<Record<string, unknown>>;
    await post(input);
    expect(await read()).toEqual({ emailDeliveryEnabled: false });
    vi.stubEnv('AXIOM_CONTACT_EMAIL_MODE', 'delivery');
    expect(await read()).toEqual({ emailDeliveryEnabled: true });
  });
});
