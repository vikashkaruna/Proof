import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import { z } from 'zod';
import { GapScanStoredReportSchema } from '@axiom/types';
import type { SendGapScanEmailParams } from '../services/gap-scan-email.js';
import { publicRoutes } from './public.js';
import { createHash } from 'node:crypto';
vi.mock('@axiom/supabase', () => ({ createSupabaseAdmin: vi.fn() }));
let db: FakeDb;
const send = vi.fn(async (_params: SendGapScanEmailParams) => ({ success: true, id: 'receipt' }));
const app = () => publicRoutes({ client: () => db.client as never, sendEmail: send });
const reply = z.object({
  id: z.string(),
  accessToken: z.string(),
  postureScore: z.number(),
  emailSent: z.boolean(),
});
const createdBody = async (res: Response) => reply.parse(await res.json());
afterEach(() => vi.unstubAllEnvs());
const input = {
  sessionId: 'browser-session',
  answers: { q1: true, q2: false },
  contactEmail: 'owner@example.invalid',
};
const post = (path: string, body: unknown, proof?: string) =>
  app().request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(proof ? { 'X-Gap-Scan-Access': proof } : {}),
    },
    body: JSON.stringify(body),
  });
const read = (id: string, proof?: string) =>
  app().request(`/gap-scan/${id}`, { headers: proof ? { 'X-Gap-Scan-Access': proof } : {} });
beforeEach(() => {
  db = createFakeDb();
  send.mockClear();
  vi.stubEnv('AXIOM_REPORT_EMAIL_MODE', 'disabled');
  vi.stubEnv('RESEND_API_KEY', 'test-provider-key');
});

describe('durable public report authority', () => {
  it('stores computed results and a hash, and reads them from a fresh route instance', async () => {
    const res = await post('/gap-scan', { ...input, report_snapshot: { postureScore: 100 } });
    expect(res.status).toBe(201);
    const body = await createdBody(res);
    expect(body.accessToken).toMatch(/^[a-f0-9]{64}$/);
    const row = db.rows('gap_scan_responses')[0]!;
    expect(row.access_token_hash).toBe(createHash('sha256').update(body.accessToken).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(body.accessToken);
    expect(body.postureScore).toBeLessThan(100);
    expect(body.emailSent).toBe(false);
    expect(send).not.toHaveBeenCalled();
    const owned = await read(body.id, body.accessToken);
    expect(owned.status).toBe(200);
    const report = GapScanStoredReportSchema.parse(await owned.json());
    expect(report.report_snapshot.postureScore).toBe(body.postureScore);
    expect(report).not.toHaveProperty('access_token_hash');
    expect(report).not.toHaveProperty('session_id');
    expect(report).not.toHaveProperty('answers');
    for (const proof of [undefined, 'a'.repeat(64), row.access_token_hash as string]) {
      expect((await read(body.id, proof)).status).toBe(404);
      expect(
        (
          await post(
            '/gap-scan/send-email',
            { id: body.id, email: 'attacker@example.invalid' },
            proof,
          )
        ).status,
      ).toBe(404);
    }
    expect(send).not.toHaveBeenCalled();
  });
  it('does not let a supplied session id recover another browser report', async () => {
    const first = await createdBody(await post('/gap-scan', input));
    const second = await createdBody(await post('/gap-scan', input));
    expect(second.accessToken).not.toBe(first.accessToken);
    expect((await read(first.id, second.accessToken)).status).toBe(404);
    const next = await createdBody(await post('/gap-scan', input, first.accessToken));
    expect(next.accessToken).toBe(first.accessToken);
    expect((await read(first.id, next.accessToken)).status).toBe(200);
  });
  it('fails closed on storage/budget failure instead of returning an ephemeral report', async () => {
    db.failNext('gap_scan_responses');
    expect((await post('/gap-scan', input)).status).toBe(503);
    expect(db.rows('gap_scan_responses')).toHaveLength(0);
    db.failNextRpc('take_rate_limit');
    expect((await post('/gap-scan', input)).status).toBe(503);
    expect(db.rows('gap_scan_responses')).toHaveLength(0);
  });
  it('requires ownership for delivery and reports unconfigured delivery truthfully', async () => {
    const created = await createdBody(await post('/gap-scan', input));
    expect(
      (
        await post(
          '/gap-scan/send-email',
          { id: created.id, email: input.contactEmail },
          created.accessToken,
        )
      ).status,
    ).toBe(503);
    vi.stubEnv('AXIOM_REPORT_EMAIL_MODE', 'delivery');
    const result = await post(
      '/gap-scan/send-email',
      { id: created.id, email: input.contactEmail },
      created.accessToken,
    );
    expect(result.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      reportId: created.id,
      contactEmail: input.contactEmail,
    });
  });
  it('keeps persisted reports readable if optional email or its budget is unavailable', async () => {
    vi.stubEnv('AXIOM_REPORT_EMAIL_MODE', 'delivery');
    send.mockRejectedValueOnce(new Error('provider failure'));
    const response = await post('/gap-scan', input);
    expect(response.status).toBe(201);
    const result = await createdBody(response);
    expect(result.emailSent).toBe(false);
    expect((await read(result.id, result.accessToken)).status).toBe(200);
  });
  it('bounds repeated delivery per report/recipient durably', async () => {
    const created = await createdBody(await post('/gap-scan', input));
    vi.stubEnv('AXIOM_REPORT_EMAIL_MODE', 'delivery');
    for (let i = 0; i < 5; i++)
      expect(
        (
          await post(
            '/gap-scan/send-email',
            { id: created.id, email: input.contactEmail },
            created.accessToken,
          )
        ).status,
      ).toBe(200);
    const refused = await post(
      '/gap-scan/send-email',
      { id: created.id, email: input.contactEmail },
      created.accessToken,
    );
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBeTruthy();
    expect(send).toHaveBeenCalledTimes(5);
  });
});
