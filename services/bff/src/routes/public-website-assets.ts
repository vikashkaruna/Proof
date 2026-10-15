import { parseCatalogueJson } from '@axiom/control-library';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  Capability,
  PUBLIC_WEBSITE_ASSET_MAX_BYTES,
  encodePublicWebsiteAssetRequest,
  parsePublicWebsiteAssetRequestText,
} from '@axiom/types';
import { createHumanActionWriter, createSupabaseAdmin } from '@axiom/supabase';
import { requireCapability } from '../middleware/authorize.js';
import { boundedJsonBody } from '../middleware/evidence-body-limit.js';
import type { Variables } from '../types.js';
import {
  checkPublicWebsiteEvidenceV2,
  PublicWebsiteRefused,
} from '../connectors/public-website.js';
import { validateFreshPublicCapture } from '../connectors/public-capture-validation-v2.js';
import {
  verifyWebsiteAssetOperation,
  verifyWebsiteCaptureTarget,
} from '../services/public-website-assets.js';

type Rpc = (
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<{ data: unknown; error: unknown }>;
/** UNMOUNTED core: UI and downstream provenance must be integrated/reviewed before mounting. */
export function publicWebsiteAssetRoutes(
  deps: { read?: Rpc; write?: Rpc; capture?: typeof checkPublicWebsiteEvidenceV2 } = {},
) {
  const read: Rpc =
    deps.read ??
    (async (name, args, signal) => createSupabaseAdmin().rpc(name, args).abortSignal(signal));
  const write: Rpc =
    deps.write ??
    (async (name, args, signal) => createHumanActionWriter().rpc(name, args).abortSignal(signal));
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', boundedJsonBody(PUBLIC_WEBSITE_ASSET_MAX_BYTES));
  app.get('/public-website-assets/operations/:key', async (c) => {
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;
    c.header('Cache-Control', 'private, no-store');
    const key = z.uuid().safeParse(c.req.param('key'));
    if (!key.success) return c.json({ error: { code: 'invalid_request' } }, 400);
    const scope = { tenantId: c.get('tenantId'), actorId: c.get('user').id };
    try {
      const result = await read(
        'read_public_website_asset_operation',
        { p_tenant_id: scope.tenantId, p_actor_id: scope.actorId, p_operation_key: key.data },
        c.req.raw.signal,
      );
      if (result.error) throw Error();
      if (
        z
          .object({ state: z.literal('not_found') })
          .strict()
          .safeParse(result.data).success
      )
        return c.json({ data: { state: 'not_found' } }, 200);
      return c.json({
        data: verifyWebsiteAssetOperation(result.data, { ...scope, operationKey: key.data }),
      });
    } catch {
      return c.json({ error: { code: 'website_asset_unavailable' } }, 503);
    }
  });
  app.post('/public-website-assets/operations', async (c) => {
    for (const capability of [Capability.CONNECTOR_MANAGE, Capability.ESTATE_MANAGE]) {
      const denied = requireCapability(c, capability);
      if (denied) return denied;
    }
    c.header('Cache-Control', 'private, no-store');
    const scope = { tenantId: c.get('tenantId'), actorId: c.get('user').id };
    const expected = z.uuid().safeParse(c.req.header('X-Expected-Actor-Id'));
    if (!expected.success || expected.data.toLowerCase() !== scope.actorId.toLowerCase())
      return c.json({ error: { code: 'actor_context_changed' } }, 409);
    let requestText: string;
    try {
      requestText = encodePublicWebsiteAssetRequest(
        parseCatalogueJson(
          new TextDecoder('utf-8', { fatal: true }).decode(await c.req.arrayBuffer()),
          PUBLIC_WEBSITE_ASSET_MAX_BYTES,
        ),
      );
    } catch {
      return c.json({ error: { code: 'invalid_request' } }, 400);
    }
    const request = parsePublicWebsiteAssetRequestText(requestText);
    const args = {
      p_tenant_id: scope.tenantId,
      p_actor_id: scope.actorId,
      p_request_text: requestText,
    };
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30_000)]);
    try {
      let result: Awaited<ReturnType<Rpc>>;
      if (request.kind === 'capture') {
        const prior = await read(
          'read_public_website_asset_operation',
          {
            p_tenant_id: scope.tenantId,
            p_actor_id: scope.actorId,
            p_operation_key: request.operationKey,
          },
          signal,
        );
        if (prior.error) throw Error();
        if (
          !z
            .object({ state: z.literal('not_found') })
            .strict()
            .safeParse(prior.data).success
        )
          return c.json(
            {
              data: verifyWebsiteAssetOperation(prior.data, {
                ...scope,
                operationKey: request.operationKey,
                requestText,
              }),
            },
            200,
          );
        const current = await read(
          'read_public_website_target_for_capture',
          {
            p_tenant_id: scope.tenantId,
            p_actor_id: scope.actorId,
            p_target_id: request.targetId,
            p_target_sha256: request.expectedTargetSha256,
          },
          signal,
        );
        if (current.error) throw Error();
        const target = verifyWebsiteCaptureTarget(current.data, scope, request);
        const limited = await read(
          'take_rate_limit',
          {
            p_bucket: 'public-website-check',
            p_subject: `${scope.tenantId}:${scope.actorId}`,
            p_limit: 30,
            p_window_seconds: 3600,
          },
          signal,
        );
        const budget = z
          .object({ allowed: z.boolean(), retry_after: z.number().int().positive() })
          .safeParse(limited.data);
        if (limited.error || !budget.success) throw Error();
        if (!budget.data.allowed) {
          c.header('Retry-After', String(budget.data.retry_after));
          return c.json({ error: { code: 'rate_limited' } }, 429);
        }
        signal.throwIfAborted();
        const captured = await (deps.capture ?? checkPublicWebsiteEvidenceV2)(target.url, signal);
        signal.throwIfAborted();
        if (captured.check.requestedUrl !== target.url || !validateFreshPublicCapture(captured))
          throw Error();
        result = await write(
          'record_targeted_public_website_capture',
          {
            ...args,
            p_final_url: captured.check.finalUrl,
            p_result: captured.check,
            p_codec: captured.evidence.codec,
            p_payload_text: captured.evidence.payloadText,
            p_payload_sha256: captured.evidence.payloadSha256,
            p_page_sources: captured.evidence.pageSources,
          },
          signal,
        );
      } else result = await write('record_public_website_asset_operation', args, signal);
      if (result.error) throw Error();
      const saved = verifyWebsiteAssetOperation(result.data, {
        ...scope,
        operationKey: request.operationKey,
        requestText,
      });
      return c.json({ data: saved }, saved.replayed ? 200 : 201);
    } catch (cause) {
      if (cause instanceof PublicWebsiteRefused)
        return c.json({ error: { code: cause.code } }, 422);
      return c.json({ error: { code: 'website_asset_unavailable' } }, 503);
    }
  });
  return app;
}
