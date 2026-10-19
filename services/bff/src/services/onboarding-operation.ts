import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createHumanActionWriter, createSupabaseAdmin } from '@axiom/supabase';
import {
  onboardingCreate,
  onboardingLookup,
  encodeOnboardingRequest,
  verifyOnboardingOperation,
} from '@axiom/types';
import type { Context } from 'hono';
import type { Variables } from '../types.js';
type Ctx = Context<{ Variables: Variables }>;
const digest = (v: string) => createHash('sha256').update(v).digest('hex');
const unavailable = (c: Ctx) =>
  c.json(
    {
      error: {
        code: 'onboarding_operation_unconfirmed',
        message:
          'Keep the original request. Check its saved outcome before creating another organization.',
      },
    },
    503,
  );
function authority(c: Ctx) {
  const actorId = z.uuid().safeParse(c.get('user')?.id),
    sessionId = z.uuid().safeParse(c.get('sessionId'));
  if (
    !actorId.success ||
    !sessionId.success ||
    c.req.header('X-Expected-Actor-Id') !== actorId.data
  )
    return null;
  return { actorId: actorId.data, sessionId: sessionId.data };
}
export async function createExactOnboarding(c: Ctx, body: unknown, rawBody: string) {
  c.header('Cache-Control', 'private, no-store');
  const auth = authority(c),
    parsed = onboardingCreate.safeParse(body),
    claim = c.get('requestClaim');
  if (!auth) return c.json({ error: { code: 'current_actor_session_required' } }, 409);
  if (!parsed.success) return c.json({ error: { code: 'validation_failed' } }, 400);
  const { operationKey, request } = parsed.data;
  if (new URL(c.req.url).search !== '')
    return c.json({ error: { code: 'validation_failed' } }, 400);
  if (c.req.header('Idempotency-Key') !== operationKey)
    return c.json({ error: { code: 'original_onboarding_claim_required' } }, 409);
  if (c.get('onboardingReadbackOnly')) {
    const requestSha256 = digest(encodeOnboardingRequest(request));
    const recovered = await createHumanActionWriter().rpc('read_onboarding_operation', {
      p_actor_id: auth.actorId,
      p_session_id: auth.sessionId,
      p_operation_key: operationKey,
      p_request_sha256: requestSha256,
    });
    if (recovered.error)
      return recovered.error.code === '42501'
        ? c.json({ error: { code: 'original_onboarding_operation_refused' } }, 403)
        : unavailable(c);
    try {
      const proof = verifyOnboardingOperation(recovered.data, {
        actorId: auth.actorId,
        operationKey,
        requestSha256,
      });
      return proof.state === 'unconfirmed' ? unavailable(c) : c.json({ data: proof });
    } catch {
      return unavailable(c);
    }
  }
  if (!claim || claim.key !== operationKey)
    return c.json({ error: { code: 'original_onboarding_claim_required' } }, 409);
  const rate = await createSupabaseAdmin().rpc('take_rate_limit', {
    p_bucket: 'organization-onboarding',
    p_subject: auth.actorId,
    p_limit: 5,
    p_window_seconds: 3600,
  });
  const admitted = z
    .object({ allowed: z.boolean(), retry_after: z.number().positive() })
    .safeParse(rate.data);
  if (rate.error || !admitted.success) return unavailable(c);
  if (!admitted.data.allowed) return c.json({ error: { code: 'rate_limited' } }, 429);
  const catalogue = await createSupabaseAdmin().rpc('read_current_catalogue_version');
  const version = z
    .object({ version: z.string().min(1).max(200) })
    .strict()
    .safeParse(catalogue.data);
  if (catalogue.error || !version.success) return unavailable(c);
  const requestText = encodeOnboardingRequest(request),
    requestSha256 = digest(requestText);
  const result = await createHumanActionWriter().rpc('onboard_organization_exact', {
    p_actor_id: auth.actorId,
    p_session_id: auth.sessionId,
    p_operation_key: operationKey,
    p_claim_id: claim.id,
    p_claim_request_sha256: claim.requestSha256,
    p_claim_authority_sha256: claim.authoritySha256,
    p_request_text: requestText,
    p_raw_body: rawBody,
    p_library_version: version.data.version,
  });
  if (result.error) return unavailable(c);
  const refusal = z
    .object({
      error: z.enum([
        'onboarding_not_entitled',
        'tier_not_entitled',
        'tenant_quota_exceeded',
        'library_not_published',
      ]),
    })
    .strict()
    .safeParse(result.data);
  if (refusal.success)
    return c.json(
      refusal.data,
      refusal.data.error === 'tenant_quota_exceeded'
        ? 409
        : refusal.data.error === 'library_not_published'
          ? 503
          : 403,
    );
  try {
    return c.json(
      {
        data: verifyOnboardingOperation(result.data, {
          actorId: auth.actorId,
          operationKey,
          requestSha256,
        }),
      },
      201,
    );
  } catch {
    return unavailable(c);
  }
}
export async function readExactOnboarding(c: Ctx, fence = false) {
  c.header('Cache-Control', 'private, no-store');
  const auth = authority(c);
  if (!auth) return c.json({ error: { code: 'current_actor_session_required' } }, 409);
  const body: unknown = fence
    ? await c.req.json().catch(() => null)
    : { operationKey: c.req.param('operationKey'), requestSha256: c.req.query('requestSha256') };
  const parsed = (
    fence
      ? onboardingLookup.extend({ originalCreateBody: z.string().max(524288).optional() }).strict()
      : onboardingLookup
  ).safeParse(body);
  if (!parsed.success || parsed.data.operationKey !== c.req.param('operationKey'))
    return c.json({ error: { code: 'validation_failed' } }, 400);
  const { operationKey, requestSha256 } = parsed.data;
  const result = await createHumanActionWriter().rpc(
    fence ? 'fence_onboarding_operation' : 'read_onboarding_operation',
    {
      p_actor_id: auth.actorId,
      p_session_id: auth.sessionId,
      p_operation_key: operationKey,
      p_request_sha256: requestSha256,
      ...(fence
        ? {
            p_original_body:
              'originalCreateBody' in parsed.data ? parsed.data.originalCreateBody : null,
          }
        : {}),
    },
  );
  if (result.error)
    return result.error.code === '42501'
      ? c.json({ error: { code: 'original_onboarding_operation_refused' } }, 403)
      : unavailable(c);
  try {
    return c.json({
      data: verifyOnboardingOperation(result.data, {
        actorId: auth.actorId,
        operationKey,
        requestSha256,
      }),
    });
  } catch {
    return unavailable(c);
  }
}
