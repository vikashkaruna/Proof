import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { canonicalJson } from '@axiom/ledger';
import {
  CatalogueCurrentVersionRequestSchema,
  ApprovedLibraryVersionSchema,
  CatalogueVersionApprovalRequestSchema,
  CatalogueVersionSummarySchema,
} from '@axiom/types';
import { createHumanActionWriter, createSupabaseAdmin } from '@axiom/supabase';
import type { Variables } from '../types.js';
import { boundedJsonBody } from '../middleware/evidence-body-limit.js';
import { bindingSha256, type MfaService } from '../services/mfa.js';
import type { LocalCustodyReadRpc } from '../workloads/local-key-admission.js';

const envelope = z
  .object({
    request: z.union([CatalogueVersionApprovalRequestSchema, CatalogueCurrentVersionRequestSchema]),
    challengeId: z.uuid().optional(),
    code: z.string().min(1).max(256).optional(),
  })
  .strict();
const list = z.object({ versions: z.array(CatalogueVersionSummarySchema).max(100) }).strict();
const receipt = z
  .object({
    approved: z.literal(true),
    libraryVersion: ApprovedLibraryVersionSchema,
    receiptId: z.string().regex(/^[1-9][0-9]*$/),
    replayed: z.boolean(),
  })
  .strict();
/** SQL repeats live founder/session, source digest and consumed MFA verification.
 * No publisher credentials or implicit publication/activation are composed here. */
export function catalogueVersionRoutes(deps: {
  mfa: MfaService;
  read?: LocalCustodyReadRpc;
  write?: LocalCustodyReadRpc;
}) {
  const read =
    deps.read ??
    (async (name, args, signal) => createSupabaseAdmin().rpc(name, args).abortSignal(signal));
  const write =
    deps.write ??
    (async (name, args, signal) => createHumanActionWriter().rpc(name, args).abortSignal(signal));
  const app = new Hono<{ Variables: Variables }>();
  app.use('/catalogue-versions/*', boundedJsonBody(8192));
  app.use('/catalogue-versions', async (c, next) => {
    if (c.get('role') !== 'founder') return c.json({ error: { code: 'founder_required' } }, 403);
    return next();
  });
  app.use('/catalogue-versions/*', async (c, next) => {
    if (c.get('role') !== 'founder') return c.json({ error: { code: 'founder_required' } }, 403);
    return next();
  });
  app.get('/catalogue-versions', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const args = {
      p_tenant_id: c.get('tenantId'),
      p_actor_id: c.get('user').id,
      p_session_id: c.get('sessionId'),
    };
    if (!z.uuid().safeParse(args.p_session_id).success)
      return c.json({ error: { code: 'current_session_required' } }, 401);
    try {
      const result = await read('read_catalogue_versions', args, c.req.raw.signal);
      if (result.error) throw Error();
      return c.json({ data: list.parse(result.data) });
    } catch {
      return c.json({ error: { code: 'catalogue_context_unavailable' } }, 503);
    }
  });
  const mutate = async (c: Context<{ Variables: Variables }>) => {
    const selectingCurrent = c.req.path.includes('/catalogue-versions/current/');
    c.header('Cache-Control', 'private, no-store');
    const step = c.req.param('step') ?? '';
    if (!['challenge', 'verify', 'approve'].includes(step) || new URL(c.req.url).search)
      return c.json({ error: { code: 'invalid_request' } }, 400);
    const t = c.get('tenantId'),
      a = c.get('user').id,
      s = c.get('sessionId');
    if (!z.uuid().safeParse(s).success)
      return c.json({ error: { code: 'current_session_required' } }, 401);
    if (c.req.header('X-Expected-Actor-Id') !== a)
      return c.json({ error: { code: 'catalogue_actor_changed' } }, 409);
    const parsed = envelope.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'invalid_catalogue_request' } }, 400);
    const { request, challengeId, code } = parsed.data;
    if (selectingCurrent !== 'transition' in request)
      return c.json({ error: { code: 'invalid_catalogue_request' } }, 400);
    if (c.req.header('Idempotency-Key') !== request.operationKey)
      return c.json({ error: { code: 'catalogue_operation_key_mismatch' } }, 400);
    const text = canonicalJson(request),
      sha = createHash('sha256').update(text).digest('hex');
    const args = { p_tenant_id: t, p_actor_id: a, p_session_id: s, p_request_text: text };
    try {
      const checked = await read(
        selectingCurrent
          ? 'preflight_current_catalogue_version'
          : 'preflight_catalogue_version_approval',
        args,
        c.req.raw.signal,
      );
      if (checked.error) throw Error();
      z.object({ authorized: z.literal(true), requestSha256: z.literal(sha) })
        .passthrough()
        .parse(checked.data);
      const binding = bindingSha256([
        selectingCurrent
          ? 'axiom.catalogue-version.make-current'
          : 'axiom.catalogue-version.approve',
        1,
        t,
        a,
        s,
        sha,
      ]);
      if (step === 'challenge') {
        if (challengeId || code) return c.json({ error: { code: 'invalid_request' } }, 400);
        const issued = await deps.mfa.issueChallenge({
          userId: a,
          tenantId: t,
          sessionId: s,
          purpose: 'catalogue_adoption',
          boundResourceRef: request.operationKey,
          boundPayloadSha256: binding,
          ttlMs: 300000,
        });
        return issued.ok
          ? c.json({ data: { challengeId: issued.challengeId, expiresAt: issued.expiresAt } })
          : c.json({ error: { code: 'catalogue_mfa_unavailable' } }, 403);
      }
      if (!challengeId) return c.json({ error: { code: 'catalogue_mfa_required' } }, 403);
      if (step === 'verify') {
        if (!code) return c.json({ error: { code: 'catalogue_mfa_required' } }, 403);
        const verified = await deps.mfa.verifyChallenge({
          userId: a,
          tenantId: t,
          sessionId: s,
          challengeId,
          code,
          boundResourceRef: request.operationKey,
          boundPayloadSha256: binding,
        });
        if (
          !verified.ok ||
          verified.purpose !== 'catalogue_adoption' ||
          verified.boundResourceRef !== request.operationKey
        )
          return c.json({ error: { code: 'catalogue_mfa_refused' } }, 403);
        return c.json({ data: { verified: true } });
      }
      if (code) return c.json({ error: { code: 'invalid_request' } }, 400);
      const consumed = await deps.mfa.consumeChallenge({
        userId: a,
        tenantId: t,
        sessionId: s,
        challengeId,
        purpose: 'catalogue_adoption',
        boundResourceRef: request.operationKey,
        boundPayloadSha256: binding,
        consumedFor: request.operationKey,
      });
      if (!consumed.ok) return c.json({ error: { code: 'catalogue_mfa_refused' } }, 403);
      const result = await write(
        selectingCurrent ? 'set_current_catalogue_version' : 'approve_catalogue_version',
        { ...args, p_challenge_id: challengeId },
        c.req.raw.signal,
      );
      if (result.error) throw Error();
      return c.json({ data: receipt.parse(result.data) });
    } catch {
      return c.json(
        {
          error: {
            code: 'catalogue_approval_unconfirmed',
            message: 'Refresh catalogue versions to check the recorded state before retrying.',
          },
        },
        503,
      );
    }
  };
  app.post('/catalogue-versions/:step', mutate);
  app.post('/catalogue-versions/current/:step', mutate);
  return app;
}
