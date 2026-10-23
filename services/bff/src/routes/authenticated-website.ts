import { Hono } from 'hono';
import { z } from 'zod';
import { createHumanActionWriter, createSupabaseAdmin } from '@axiom/supabase';
import { Capability } from '@axiom/types';
import { requireCapability } from '../middleware/authorize.js';
import { connectorRegistry } from '../connectors/registry.js';
import { pluginFor } from '../connectors/framework/plugins.js';
import {
  AuthenticatedWebsiteRefused,
  crawlAuthenticatedWebsite,
  readSiteCredential,
  type AuthenticatedWebsiteConfiguration,
} from '../connectors/website-authenticated.js';
import type { Variables } from '../types.js';

export interface AuthenticatedWebsiteRouteDeps {
  configuration?: z.infer<typeof AuthenticatedWebsiteConfiguration>;
  crawl?: typeof crawlAuthenticatedWebsite;
  readCredential?: typeof readSiteCredential;
  timeoutMs?: number;
}

/**
 * Human-triggered signed-in website checks. The site, start pages, login mode
 * and credential come only from protected deployment configuration keyed by
 * tenant and connector; a request carries nothing but an operation key. Every
 * outcome, success or failure, is recorded append-only with a ledger receipt.
 */
export function authenticatedWebsiteRoutes(deps: AuthenticatedWebsiteRouteDeps = {}) {
  const app = new Hono<{ Variables: Variables }>();
  const siteFor = (tenantId: string, connectorId: string) =>
    deps.configuration?.sites.find(
      (site) =>
        site.tenantId === tenantId.toLowerCase() && site.connectorId === connectorId.toLowerCase(),
    );

  app.get('/connectors/:id/website-scan', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;
    const id = z.uuid().safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: { code: 'invalid_id' } }, 400);
    const rows = await createSupabaseAdmin()
      .from('authenticated_website_checks')
      .select('id,status,error_code,checked_at,result')
      .eq('tenant_id', c.get('tenantId'))
      .eq('connector_id', id.data)
      .order('checked_at', { ascending: false })
      .limit(10);
    if (rows.error || !rows.data)
      return c.json({ error: { code: 'website_scan_unavailable' } }, 503);
    return c.json({
      data: rows.data.map((row) => {
        const result = row.result as { pages?: unknown[]; skipped?: unknown[] } | null;
        return {
          id: row.id,
          status: row.status,
          errorCode: row.error_code,
          checkedAt: row.checked_at,
          pagesRead: Array.isArray(result?.pages) ? result.pages.length : 0,
          pagesSkipped: Array.isArray(result?.skipped) ? result.skipped.length : 0,
        };
      }),
      available: !!siteFor(c.get('tenantId'), id.data),
    });
  });

  app.post('/connectors/:id/website-scan', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.CONNECTOR_MANAGE);
    if (denied) return denied;
    const id = z.uuid().safeParse(c.req.param('id'));
    const body = z
      .object({ operationKey: z.uuid() })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!id.success || !body.success) return c.json({ error: { code: 'invalid_request' } }, 400);
    const tenantId = c.get('tenantId');
    const site = siteFor(tenantId, id.data);
    if (!site || !deps.configuration)
      return c.json({ error: { code: 'website_scan_unavailable' } }, 503);
    const connector = await createSupabaseAdmin()
      .from('connectors')
      .select('id,descriptor_id,target_binding,status')
      .eq('tenant_id', tenantId)
      .eq('id', id.data)
      .maybeSingle();
    if (connector.error) return c.json({ error: { code: 'website_scan_unavailable' } }, 503);
    const manifest = connector.data && connectorRegistry.get(String(connector.data.descriptor_id));
    if (
      !connector.data ||
      connector.data.status !== 'active' ||
      !manifest ||
      pluginFor(manifest)?.family !== 'website' ||
      manifest.id.toLowerCase() !== site.descriptorId ||
      (manifest.targetBinding !== 'production' && manifest.targetBinding !== 'sandbox') ||
      connector.data.target_binding !== manifest.targetBinding
    )
      return c.json({ error: { code: 'website_connector_refused' } }, 409);
    const correlation = body.data.operationKey.toLowerCase();
    // A replayed operation key returns its first receipt; it never crawls again.
    const replay = await createSupabaseAdmin()
      .from('authenticated_website_checks')
      .select('id,status,error_code')
      .eq('tenant_id', tenantId)
      .eq('correlation_id', correlation)
      .maybeSingle();
    if (replay.error) return c.json({ error: { code: 'website_scan_unavailable' } }, 503);
    if (replay.data)
      return c.json({
        data: {
          status: replay.data.status,
          errorCode: replay.data.error_code,
          checkId: replay.data.id,
          replayed: true,
        },
      });
    let status: 'checked' | 'failed' = 'failed';
    let result: unknown = null;
    let errorCode: string | null = null;
    try {
      const credential = await (deps.readCredential ?? readSiteCredential)(site);
      result = await (deps.crawl ?? crawlAuthenticatedWebsite)(
        site,
        credential,
        manifest.targetBinding,
        deps.configuration.environment,
        AbortSignal.timeout(
          Math.min(deps.timeoutMs ?? 60_000, site.credential.expiresAt - Date.now()),
        ),
      );
      status = 'checked';
    } catch (cause) {
      errorCode = cause instanceof AuthenticatedWebsiteRefused ? cause.code : 'website_scan_failed';
    }
    const recorded = await createHumanActionWriter()
      .rpc('record_authenticated_website_check', {
        p_tenant_id: tenantId,
        p_actor_id: c.get('user').id,
        p_connector_id: id.data.toLowerCase(),
        p_correlation_id: correlation,
        p_base_url: site.baseUrl,
        p_status: status,
        p_result: result,
        p_error_code: errorCode,
      })
      .abortSignal(AbortSignal.timeout(10_000));
    if (recorded.error) {
      return c.json(
        {
          error: { code: 'website_scan_unrecorded', message: 'The outcome could not be recorded.' },
        },
        recorded.error.code === '23505' ? 409 : 503,
      );
    }
    return c.json(
      {
        data: { status, errorCode, checkId: (recorded.data as { id?: string } | null)?.id ?? null },
      },
      status === 'checked' ? 200 : 422,
    );
  });
  return app;
}
