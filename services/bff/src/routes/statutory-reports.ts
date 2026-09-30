/**
 * Statutory Reports API Routes.
 * Exposes guarded draft generation, HTML streaming, PDF downloading,
 * and listing across Board, Auditor, DPB, and Technical reports (W8 / FR-8 / Revision 106).
 */
import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { Capability } from '@axiom/types';
import { createSupabaseAdmin } from '@axiom/supabase';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';
import { EvidenceError, type EvidenceDatabase } from '../services/evidence-ingestion.js';
import {
  StatutoryReportService,
  generateStatutoryReportInputSchema,
  requestAuditorPackInputSchema,
  listStatutoryReportsInputSchema,
} from '../services/statutory-reports.js';
import { StatutoryArtifactService } from '../services/statutory-artifacts.js';

type Ctx = Context<{ Variables: Variables }>;

function failure(c: Ctx, cause: unknown) {
  if (cause instanceof EvidenceError) {
    return c.json({ error: { code: cause.code } }, cause.status);
  }
  return c.json({ error: { code: 'report_storage_unavailable' } }, 503);
}

function invalid(c: Ctx, message?: string) {
  return c.json({ error: { code: 'validation_failed', message } }, 400);
}

export function statutoryReportRoutes(
  dependencies: {
    db?: EvidenceDatabase;
    service?: StatutoryReportService;
    artifacts?: StatutoryArtifactService;
  } = {},
) {
  const app = new Hono<{ Variables: Variables }>();
  const service = () =>
    dependencies.service ?? new StatutoryReportService(dependencies.db ?? createSupabaseAdmin());
  const artifacts = () =>
    dependencies.artifacts ??
    new StatutoryArtifactService(dependencies.db ?? createSupabaseAdmin());
  const operationSchema = z.object({ operationKey: z.uuid() }).strict();

  app.get('/reports/statutory/:id/artifacts/status', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.REPORT_READ);
    if (denied) return denied;
    const id = c.req.param('id');
    if (!z.uuid().safeParse(id).success) return invalid(c);
    try {
      return c.json(
        await artifacts().status(
          c.get('tenantId'),
          c.get('user').id,
          id,
          AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]),
        ),
      );
    } catch (cause) {
      return failure(c, cause);
    }
  });

  for (const [suffix, action] of [
    ['', 'build'],
    ['/reconcile', 'reconcile'],
    ['/retry-missing', 'retryMissing'],
  ] as const) {
    app.post(`/reports/statutory/:id/artifacts${suffix}`, async (c) => {
      c.header('Cache-Control', 'private, no-store');
      const denied = requireCapability(c, Capability.REPORT_GENERATE);
      if (denied) return denied;
      const id = c.req.param('id');
      const body = operationSchema.safeParse(await c.req.json().catch(() => null));
      if (!z.uuid().safeParse(id).success || !body.success) return invalid(c);
      try {
        const result = await artifacts()[action](
          c.get('tenantId'),
          c.get('user').id,
          id,
          body.data.operationKey,
          AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(90_000)]),
        );
        return c.json(result, result.status === 'settled' ? 200 : 202);
      } catch (cause) {
        return failure(c, cause);
      }
    });
  }

  // The caller selects a finalized assessment; all report claims are built from its frozen source.
  app.post('/reports/statutory/auditor/requests', async (c) => {
    const denied = requireCapability(c, Capability.REPORT_GENERATE);
    if (denied) return denied;
    const body = await c.req.json().catch(() => null);
    const parsed = requestAuditorPackInputSchema.safeParse(body);
    if (!parsed.success) return invalid(c, 'Invalid auditor pack request');
    try {
      return c.json(
        await service().requestAuditorPack(
          c.get('tenantId'),
          c.get('user').id,
          parsed.data,
          randomUUID(),
          AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30_000)]),
        ),
        201,
      );
    } catch (cause) {
      return failure(c, cause);
    }
  });

  app.post('/reports/statutory/auditor/requests/:id/draft', async (c) => {
    const denied = requireCapability(c, Capability.REPORT_GENERATE);
    if (denied) return denied;
    const requestId = c.req.param('id');
    if (!z.uuid().safeParse(requestId).success) return invalid(c, 'Invalid request ID');
    try {
      return c.json(
        await service().generateAuditorDraft(
          c.get('tenantId'),
          c.get('user').id,
          requestId,
          randomUUID(),
          AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30_000)]),
        ),
        201,
      );
    } catch (cause) {
      return failure(c, cause);
    }
  });

  app.get('/reports/statutory/auditor/requests', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.REPORT_READ);
    if (denied) return denied;
    const parsed = z
      .object({
        limit: z.coerce.number().int().min(1).max(50).default(20),
        offset: z.coerce.number().int().min(0).max(10_000).default(0),
      })
      .strict()
      .safeParse(c.req.query());
    if (!parsed.success) return invalid(c, 'Invalid request page');
    try {
      return c.json(
        await service().listAuditorRequests(
          c.get('tenantId'),
          c.get('user').id,
          parsed.data.limit,
          parsed.data.offset,
          AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]),
        ),
      );
    } catch (cause) {
      return failure(c, cause);
    }
  });

  // 1. Generate Statutory Report (Founder / Prativedan / Authorized Manager)
  app.post('/reports/statutory/generate', async (c) => {
    const denied = requireCapability(c, Capability.REPORT_GENERATE);
    if (denied) return denied;

    const body = await c.req.json().catch(() => null);
    const parsed = generateStatutoryReportInputSchema.safeParse(body);
    if (!parsed.success) return invalid(c, 'Invalid statutory report generation payload');

    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30_000)]);
    const correlationId = randomUUID();
    try {
      const result = await service().generateStatutoryReport(
        c.get('tenantId'),
        c.get('user').id,
        parsed.data,
        correlationId,
        signal,
      );
      return c.json(result, 201);
    } catch (cause) {
      return failure(c, cause);
    }
  });

  // 2. Stream Statutory Report PDF
  app.get('/reports/statutory/:id/pdf', async (c) => {
    const denied = requireCapability(c, Capability.REPORT_READ);
    if (denied) return denied;

    const id = c.req.param('id');
    if (!z.uuid().safeParse(id).success) return invalid(c, 'Invalid report ID');

    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30_000)]);
    try {
      const result = await artifacts().pdf(c.get('tenantId'), c.get('user').id, id, signal);

      return new Response(new Uint8Array(result.pdfBuffer), {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="auditor-report-${id}.pdf"`,
          'Content-Length': String(result.byteLength),
          'X-Report-Kind': 'auditor',
          'X-Report-SHA256': result.sha256,
          'Cache-Control': 'private, no-store',
        },
      });
    } catch (cause) {
      return failure(c, cause);
    }
  });

  // 3. Render Statutory Report HTML
  app.get('/reports/statutory/:id/html', async (c) => {
    const denied = requireCapability(c, Capability.REPORT_READ);
    if (denied) return denied;

    const id = c.req.param('id');
    if (!z.uuid().safeParse(id).success) return invalid(c, 'Invalid report ID');

    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(20_000)]);
    try {
      const result = await service().getReportHtml(c.get('tenantId'), c.get('user').id, id, signal);

      return new Response(result.html, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Disposition': `inline; filename="${result.kind}-report-${id}.html"`,
          'X-Report-Kind': result.kind,
          'Cache-Control': 'private, no-store',
        },
      });
    } catch (cause) {
      return failure(c, cause);
    }
  });

  // 4. List Statutory Reports
  app.get('/reports/statutory', async (c) => {
    const denied = requireCapability(c, Capability.REPORT_READ);
    if (denied) return denied;

    const query = c.req.query();
    const parsed = listStatutoryReportsInputSchema.safeParse(query);
    if (!parsed.success) return invalid(c, 'Invalid list query parameters');

    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]);
    try {
      const result = await service().listStatutoryReports(
        c.get('tenantId'),
        c.get('user').id,
        parsed.data,
        signal,
      );
      return c.json(result, 200);
    } catch (cause) {
      return failure(c, cause);
    }
  });

  return app;
}
