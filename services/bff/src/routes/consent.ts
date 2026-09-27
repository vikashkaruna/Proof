import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { createSupabaseAdmin } from '@axiom/supabase';
import { Capability } from '@axiom/types';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';

type ConsentContext = Context<{ Variables: Variables }>;
const language = z.enum(['en', 'hi']);
const grantSchema = z
  .object({
    purposeId: z.uuid(),
    expectedNoticeVersion: z.number().int().positive(),
    principalType: z.enum(['email', 'phone', 'cookie_id', 'user_id']),
    principalRef: z.string().min(3).max(320),
    language,
    channel: z.enum(['cookie', 'form', 'api', 'offline']),
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .strict();
const withdrawSchema = z
  .object({ language, reason: z.string().max(500).nullable().optional() })
  .strict();
const holdSchema = z.object({ hold: z.boolean() }).strict();
const completeSchema = z.object({}).strict();
const noticeText = z.string().trim().min(1).max(20000);
const purposeSchema = z
  .object({
    purposeKey: z.string().regex(/^[a-z0-9_.-]{1,64}$/),
    nameEn: z.string().trim().min(1).max(160),
    nameHi: z.string().trim().min(1).max(160),
    descriptionEn: z.string().max(2000).nullable().optional(),
    descriptionHi: z.string().max(2000).nullable().optional(),
    lawfulBasis: z.enum(['consent', 'legitimate_uses']),
    noticeEn: noticeText,
    noticeHi: noticeText,
    reviewed: z.literal(true),
  })
  .strict();
const noticeSchema = z
  .object({
    expectedNoticeVersion: z.number().int().positive(),
    noticeEn: noticeText,
    noticeHi: noticeText,
    reviewed: z.literal(true),
  })
  .strict();
const purposeStatusSchema = z.object({ active: z.boolean() }).strict();
const noticeResult = z.object({
  purpose_id: z.uuid(),
  notice_version: z.number().int().positive(),
});

/**
 * Consent is recorded by a tenant human through the RPC-only lifecycle in
 * 0069/0072. Reviewed notices have immutable version history. These routes
 * do not perform downstream writes or grant an agent execution authority.
 */
async function persist(
  c: ConsentContext,
  fn: string,
  parameters: Record<string, unknown>,
  resultSchema: z.ZodType,
  status: 200 | 201 = 200,
) {
  const { data, error } = await createSupabaseAdmin().rpc(fn, {
    ...parameters,
    p_tenant_id: c.get('tenantId'),
    p_correlation_id: randomUUID(),
  });
  // Never forward or log database diagnostics: they may contain principal data.
  if (error) return c.json({ error: { code: 'persistence_failed' } }, 500);
  const refusal = z.object({ error: z.string().min(1) }).safeParse(data);
  if (refusal.success) return c.json({ error: { code: refusal.data.error } }, 409);
  const result = resultSchema.safeParse(data);
  if (!result.success) return c.json({ error: { code: 'persistence_failed' } }, 500);
  return c.json({ data: result.data }, status);
}

function invalid(c: ConsentContext) {
  return c.json({ error: { code: 'validation_failed', message: 'Invalid consent request' } }, 400);
}

export function consentRoutes() {
  const app = new Hono<{ Variables: Variables }>();

  const lists = [
    {
      path: '/consent/purposes',
      table: 'consent_purposes',
      columns:
        'id, purpose_key, name_en, name_hi, description_en, description_hi, lawful_basis, notice_version, notice_en, notice_hi, is_active, created_by, created_at, updated_at',
      order: 'purpose_key',
    },
    {
      path: '/consent/records',
      table: 'consent_records',
      columns:
        'id, purpose_id, principal_type, principal_ref, notice_version, notice_snapshot_sha256, language, channel, status, granted_at, granted_by, withdrawn_at, withdrawn_via_consent_id, legal_hold, expires_at, created_at',
      order: 'created_at',
    },
    {
      path: '/consent/withdrawals',
      table: 'consent_withdrawals',
      columns:
        'id, consent_record_id, purpose_id, principal_type, principal_ref, reason, language, downstream_completed_at, requested_by, created_at',
      order: 'created_at',
    },
  ];
  for (const list of lists) {
    app.get(list.path, async (c) => {
      const refused = requireCapability(c, Capability.POSTURE_READ);
      if (refused) return refused;
      const { data, error } = await createSupabaseAdmin()
        .from(list.table)
        .select(list.columns)
        .eq('tenant_id', c.get('tenantId'))
        .order(list.order, { ascending: list.table === 'consent_purposes' })
        .order('id', { ascending: true })
        .limit(201);
      if (error || !Array.isArray(data)) return c.json({ error: { code: 'query_failed' } }, 500);
      return c.json({ data: data.slice(0, 200), meta: { hasMore: data.length > 200 } });
    });
  }

  app.get('/consent/purposes/:id/versions', async (c) => {
    const refused = requireCapability(c, Capability.POSTURE_READ);
    if (refused) return refused;
    if (!z.uuid().safeParse(c.req.param('id')).success) return invalid(c);
    const { data, error } = await createSupabaseAdmin()
      .from('consent_notice_versions')
      .select(
        'purpose_id, notice_version, notice_en, notice_hi, created_by, created_at, snapshot_sha256, provenance',
      )
      .eq('tenant_id', c.get('tenantId'))
      .eq('purpose_id', c.req.param('id'))
      .order('notice_version', { ascending: false })
      .limit(201);
    if (error || !Array.isArray(data)) return c.json({ error: { code: 'query_failed' } }, 500);
    return c.json({ data: data.slice(0, 200), meta: { hasMore: data.length > 200 } });
  });

  app.post('/consent/purposes', async (c) => {
    const refused = requireCapability(c, Capability.ESTATE_MANAGE);
    if (refused) return refused;
    const parsed = purposeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalid(c);
    const input = parsed.data;
    return persist(
      c,
      'register_consent_purpose',
      {
        p_purpose_key: input.purposeKey,
        p_name_en: input.nameEn,
        p_name_hi: input.nameHi,
        p_description_en: input.descriptionEn ?? null,
        p_description_hi: input.descriptionHi ?? null,
        p_lawful_basis: input.lawfulBasis,
        p_notice_en: input.noticeEn,
        p_notice_hi: input.noticeHi,
        p_reviewed: input.reviewed,
        p_created_by: c.get('user').id,
      },
      noticeResult,
      201,
    );
  });

  app.post('/consent/purposes/:id/versions', async (c) => {
    const refused = requireCapability(c, Capability.ESTATE_MANAGE);
    if (refused) return refused;
    const parsed = noticeSchema.safeParse(await c.req.json().catch(() => null));
    if (!z.uuid().safeParse(c.req.param('id')).success || !parsed.success) return invalid(c);
    const input = parsed.data;
    return persist(
      c,
      'publish_consent_notice',
      {
        p_purpose_id: c.req.param('id'),
        p_expected_notice_version: input.expectedNoticeVersion,
        p_notice_en: input.noticeEn,
        p_notice_hi: input.noticeHi,
        p_reviewed: input.reviewed,
        p_published_by: c.get('user').id,
      },
      noticeResult,
      201,
    );
  });

  app.post('/consent/purposes/:id/status', async (c) => {
    const refused = requireCapability(c, Capability.ESTATE_MANAGE);
    if (refused) return refused;
    const parsed = purposeStatusSchema.safeParse(await c.req.json().catch(() => null));
    if (!z.uuid().safeParse(c.req.param('id')).success || !parsed.success) return invalid(c);
    return persist(
      c,
      'set_consent_purpose_active',
      {
        p_purpose_id: c.req.param('id'),
        p_is_active: parsed.data.active,
        p_changed_by: c.get('user').id,
      },
      z.object({ purpose_id: z.uuid(), is_active: z.boolean() }),
    );
  });

  app.post('/consent/records', async (c) => {
    const refused = requireCapability(c, Capability.ESTATE_MANAGE);
    if (refused) return refused;
    const parsed = grantSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalid(c);
    const input = parsed.data;
    return persist(
      c,
      'record_consent',
      {
        p_purpose_id: input.purposeId,
        p_expected_notice_version: input.expectedNoticeVersion,
        p_principal_type: input.principalType,
        p_principal_ref: input.principalRef,
        p_language: input.language,
        p_channel: input.channel,
        p_expires_at: input.expiresAt ?? null,
        p_granted_by: c.get('user').id,
      },
      z.object({
        consent_id: z.uuid(),
        status: z.literal('granted'),
        notice_version: z.number().int().positive(),
        notice_snapshot_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
      201,
    );
  });

  app.post('/consent/records/:id/withdraw', async (c) => {
    const refused = requireCapability(c, Capability.ESTATE_MANAGE);
    if (refused) return refused;
    const parsed = withdrawSchema.safeParse(await c.req.json().catch(() => null));
    if (!z.uuid().safeParse(c.req.param('id')).success || !parsed.success) return invalid(c);
    return persist(
      c,
      'withdraw_consent',
      {
        p_consent_record_id: c.req.param('id'),
        p_reason: parsed.data.reason ?? null,
        p_language: parsed.data.language,
        p_requested_by: c.get('user').id,
      },
      z.object({ consent_id: z.uuid(), withdrawal_id: z.uuid(), withdrawn_at: z.string() }),
    );
  });

  app.post('/consent/records/:id/legal-hold', async (c) => {
    const refused = requireCapability(c, Capability.ESTATE_MANAGE);
    if (refused) return refused;
    const parsed = holdSchema.safeParse(await c.req.json().catch(() => null));
    if (!z.uuid().safeParse(c.req.param('id')).success || !parsed.success) return invalid(c);
    return persist(
      c,
      'set_consent_legal_hold',
      {
        p_consent_record_id: c.req.param('id'),
        p_hold: parsed.data.hold,
        p_held_by: c.get('user').id,
      },
      z.object({ consent_id: z.uuid(), legal_hold: z.boolean() }),
    );
  });

  app.post('/consent/withdrawals/:id/complete', async (c) => {
    const refused = requireCapability(c, Capability.ESTATE_MANAGE);
    if (refused) return refused;
    const parsed = completeSchema.safeParse(await c.req.json().catch(() => null));
    if (!z.uuid().safeParse(c.req.param('id')).success || !parsed.success) return invalid(c);
    return persist(
      c,
      'complete_withdrawal_downstream',
      {
        p_withdrawal_id: c.req.param('id'),
        p_completed_by: c.get('user').id,
      },
      z.object({ withdrawal_id: z.uuid(), completed_at: z.string() }),
    );
  });
  return app;
}
