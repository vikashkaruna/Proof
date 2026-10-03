import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { createHumanActionWriter, createSupabaseAdmin } from '@axiom/supabase';
import { Capability } from '@axiom/types';
import { checkPublicWebsite, PublicWebsiteRefused } from '../connectors/public-website.js';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';

const bodySchema = z.object({ url: z.string().trim().min(1).max(2048) }).strict();
const statusByCode: Record<string, 400 | 422 | 502 | 504> = {
  invalid_url: 400,
  non_public_target: 400,
  dns_unavailable: 502,
  unreachable: 502,
  timeout: 504,
  response_too_large: 422,
  redirect_refused: 422,
  unsupported_content_type: 422,
  unsupported_content_encoding: 422,
  http_status: 502,
};

type Check = typeof checkPublicWebsite;
export function publicWebsiteCheckRoutes(deps: { check?: Check } = {}) {
  const app = new Hono<{ Variables: Variables }>();
  app.get('/public-website-checks', async (c) => {
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;
    c.header('Cache-Control', 'private, no-store');
    const { data, error } = await createSupabaseAdmin()
      .from('public_website_checks')
      .select('id,result')
      .eq('tenant_id', c.get('tenantId'))
      .eq('status', 'checked')
      .order('checked_at', { ascending: false })
      .limit(20);
    if (error) return c.json({ error: { code: 'website_checks_unavailable' } }, 503);
    return c.json({ data: (data ?? []).map((row) => ({ id: row.id, ...row.result })) });
  });

  app.post('/public-website-checks', async (c) => {
    const denied = requireCapability(c, Capability.CONNECTOR_MANAGE);
    if (denied) return denied;
    c.header('Cache-Control', 'private, no-store');
    const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'invalid_request' } }, 400);
    const correlationId = randomUUID();
    let result: Awaited<ReturnType<Check>>;
    try {
      result = await (deps.check ?? checkPublicWebsite)(
        parsed.data.url,
        AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(10_000)]),
      );
    } catch (cause) {
      const code = cause instanceof PublicWebsiteRefused ? cause.code : 'unreachable';
      const status = statusByCode[code] ?? 502;
      return c.json({ error: { code } }, status);
    }
    const { data, error } = await createHumanActionWriter().rpc('record_public_website_check', {
      p_tenant_id: c.get('tenantId'),
      p_actor_id: c.get('user').id,
      p_correlation_id: correlationId,
      p_requested_url: result.requestedUrl,
      p_final_url: result.finalUrl,
      p_status: 'checked',
      p_result: result,
      p_error_code: null,
    });
    if (error || !data?.id)
      return c.json({ error: { code: 'website_check_record_unavailable' } }, 503);
    return c.json({ data: { id: data.id, ...result } }, 201);
  });
  return app;
}
