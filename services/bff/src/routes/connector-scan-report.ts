import { Hono } from 'hono';
import { z } from 'zod';
import { createSupabaseAdmin } from '@axiom/supabase';
import { Capability } from '@axiom/types';
import {
  buildDataDiscoveryReport,
  renderDataDiscoveryReportHtml,
} from '@axiom/report-kit/data-discovery-report';
import {
  buildAuthenticatedWebsiteReport,
  renderAuthenticatedWebsiteReportHtml,
} from '@axiom/report-kit/authenticated-website-report';
import { requireCapability } from '../middleware/authorize.js';
import { connectorRegistry } from '../connectors/registry.js';
import { pluginFor } from '../connectors/framework/plugins.js';
import type { Variables } from '../types.js';

const hints = z.array(z.string().max(40)).max(20);
const enumerated = z.array(
  z
    .object({
      resource: z.string().max(200),
      kind: z.string().max(4),
      estimatedRows: z.number().int().nonnegative().max(1e12),
      columns: z
        .array(
          z
            .object({
              name: z.string().max(200),
              type: z.string().max(200),
              nullable: z.boolean(),
              categoryHints: hints,
            })
            .strict(),
        )
        .max(2000),
      categoryHints: hints,
    })
    .strict(),
);
const sampled = z.array(
  z
    .object({
      column: z.string().max(200),
      sampled: z.number().int().nonnegative(),
      nonNull: z.number().int().nonnegative(),
      detected: z.record(z.string().max(40), z.number().int().nonnegative()),
      categoryHints: hints,
    })
    .strict(),
);

const path = z.string().max(300);
const websiteScan = z
  .object({
    version: z.literal('authenticated-website-scan/1'),
    baseUrl: z.string().max(2048),
    authMode: z.enum(['form_login', 'bearer', 'basic']),
    checkedAt: z.string(),
    pages: z
      .array(
        z
          .object({
            path,
            depth: z.number().int().nonnegative(),
            contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
            forms: z.array(
              z
                .object({
                  method: z.string().max(10),
                  fields: z.array(
                    z.object({ name: z.string().max(80), categories: hints }).strict(),
                  ),
                  consentControl: z.boolean(),
                  purposeText: z.boolean(),
                })
                .strict(),
            ),
          })
          .strict(),
      )
      .max(25),
    skipped: z.array(z.object({ path, reason: z.string().max(80) }).strict()).max(200),
    evidence: z
      .object({
        privacyNotice: z.array(path),
        consentControls: z.array(path),
        accessRequest: z.array(path),
        erasure: z.array(path),
        correction: z.array(path),
        grievance: z.array(path),
        cookiesBeforeLogin: z.array(z.string().max(128)),
        cookiesAfterLogin: z.array(z.string().max(128)),
        transportSecure: z.boolean(),
        sessionLost: z.boolean(),
      })
      .strict(),
  })
  .strict();

/**
 * Data discovery scan report for one connector, assembled from supervised
 * discovery requests that completed with confirmed cleanup: the latest
 * catalogue read plus the latest sample of each relation. Only persisted
 * metadata is used; no target is contacted and no value exists to disclose.
 */
export function connectorScanReportRoutes() {
  const app = new Hono<{ Variables: Variables }>();
  app.get('/connectors/:id/scan-report', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;
    const id = z.uuid().safeParse(c.req.param('id'));
    const format = z.enum(['json', 'html']).safeParse(c.req.query('format') ?? 'json');
    if (!id.success || !format.success) return c.json({ error: { code: 'invalid_request' } }, 400);
    const tenantId = c.get('tenantId');
    const db = createSupabaseAdmin();
    const [connector, tenant, requests] = await Promise.all([
      db
        .from('connectors')
        .select('id,name,descriptor_id,system_id')
        .eq('tenant_id', tenantId)
        .eq('id', id.data)
        .maybeSingle(),
      db.from('tenants').select('name').eq('id', tenantId).maybeSingle(),
      db
        .from('postgresql_discovery_requests')
        .select('operation,resource,discovery_run_id,completed_at')
        .eq('tenant_id', tenantId)
        .eq('connector_id', id.data)
        .eq('status', 'completed')
        .eq('cleanup_confirmed', true)
        .order('completed_at', { ascending: false })
        .limit(500),
    ]);
    if (connector.error || tenant.error || requests.error)
      return c.json({ error: { code: 'scan_report_unavailable' } }, 503);
    if (!connector.data || !tenant.data) return c.json({ error: { code: 'not_found' } }, 404);
    const manifest = connectorRegistry.get(String(connector.data.descriptor_id));
    const plugin = manifest && pluginFor(manifest);
    if (!manifest || (plugin?.family !== 'sql' && plugin?.family !== 'website'))
      return c.json({ error: { code: 'scan_report_unsupported' } }, 409);
    const system = await db
      .from('estate_systems')
      .select('name')
      .eq('tenant_id', tenantId)
      .eq('id', String(connector.data.system_id))
      .maybeSingle();
    if (system.error || !system.data)
      return c.json({ error: { code: 'scan_report_unavailable' } }, 503);
    if (plugin.family === 'website') {
      // The latest successful signed-in check; failures are listed on the connector.
      const latest = await db
        .from('authenticated_website_checks')
        .select('result,checked_at')
        .eq('tenant_id', tenantId)
        .eq('connector_id', id.data)
        .eq('status', 'checked')
        .order('checked_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (latest.error) return c.json({ error: { code: 'scan_report_unavailable' } }, 503);
      if (!latest.data) return c.json({ error: { code: 'scan_not_run' } }, 404);
      const scan = websiteScan.safeParse(latest.data.result);
      if (!scan.success) return c.json({ error: { code: 'scan_report_unavailable' } }, 503);
      const report = buildAuthenticatedWebsiteReport({
        organisation: String(tenant.data.name),
        system: String(system.data.name),
        connectorName: String(connector.data.name),
        targetBinding: manifest.targetBinding,
        scan: scan.data,
      });
      if (format.data === 'html') {
        c.header('Content-Type', 'text/html; charset=utf-8');
        c.header('Content-Disposition', 'attachment; filename="signed-in-website-scan.html"');
        c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
        return c.body(renderAuthenticatedWebsiteReportHtml(report));
      }
      return c.json({ data: report });
    }
    // Newest first: keep the latest catalogue read and the latest sample per relation.
    const rows = requests.data ?? [];
    const latestEnumerate = rows.find((row) => row.operation === 'enumerate');
    if (!latestEnumerate) return c.json({ error: { code: 'scan_not_run' } }, 404);
    const latestSamples = new Map<string, (typeof rows)[number]>();
    for (const row of rows)
      if (row.operation === 'sample' && row.resource && !latestSamples.has(String(row.resource)))
        latestSamples.set(String(row.resource), row);
    const runIds = [latestEnumerate, ...latestSamples.values()].map((row) =>
      String(row.discovery_run_id),
    );
    const runs = await db
      .from('connector_discovery_runs')
      .select('id,result,created_at')
      .eq('tenant_id', tenantId)
      .eq('connector_id', id.data)
      .in('id', runIds);
    if (runs.error || !runs.data)
      return c.json({ error: { code: 'scan_report_unavailable' } }, 503);
    const byId = new Map(runs.data.map((run) => [String(run.id), run]));
    const catalogue = byId.get(String(latestEnumerate.discovery_run_id));
    const tables = enumerated.safeParse(catalogue?.result);
    if (!catalogue || !tables.success)
      return c.json({ error: { code: 'scan_report_unavailable' } }, 503);
    const samples: Record<string, { sampledAt: string; columns: z.infer<typeof sampled> }> = {};
    for (const [resource, row] of latestSamples) {
      const run = byId.get(String(row.discovery_run_id));
      const columns = sampled.safeParse(run?.result);
      if (run && columns.success)
        samples[resource] = { sampledAt: String(run.created_at), columns: columns.data };
    }
    const report = buildDataDiscoveryReport({
      organisation: String(tenant.data.name),
      system: String(system.data.name),
      connectorName: String(connector.data.name),
      engine: plugin.displayName,
      targetBinding: manifest.targetBinding,
      enumeratedAt: String(catalogue.created_at),
      tables: tables.data,
      samples,
    });
    if (format.data === 'html') {
      c.header('Content-Type', 'text/html; charset=utf-8');
      c.header('Content-Disposition', 'attachment; filename="data-discovery-scan.html"');
      c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
      return c.body(renderDataDiscoveryReportHtml(report));
    }
    return c.json({ data: report });
  });
  return app;
}
