/** Narrow source-bound DPB notification review pack workflow. */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { Capability } from '@axiom/types';
import { createSupabaseAdmin } from '@axiom/supabase';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';
import { EvidenceError, type EvidenceDatabase } from '../services/evidence-ingestion.js';
import { DpbReportService, requestDpbInputSchema } from '../services/dpb-reports.js';
import { DpbArtifactService } from '../services/dpb-artifacts.js';

type Ctx = Context<{ Variables: Variables }>;
const operation = z.object({ operationKey: z.uuid() }).strict();
const release = z
  .object({
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    pdfHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
function failure(c: Ctx, cause: unknown) {
  if (cause instanceof EvidenceError) return c.json({ error: { code: cause.code } }, cause.status);
  return c.json({ error: { code: 'report_storage_unavailable' } }, 503);
}
function invalid(c: Ctx) {
  return c.json({ error: { code: 'validation_failed' } }, 400);
}

export function dpbReportRoutes(
  dependencies: {
    db?: EvidenceDatabase;
    service?: DpbReportService;
    artifacts?: DpbArtifactService;
  } = {},
) {
  const app = new Hono<{ Variables: Variables }>();
  const db = () => dependencies.db ?? createSupabaseAdmin();
  const service = () => dependencies.service ?? new DpbReportService(db());
  const artifacts = () => dependencies.artifacts ?? new DpbArtifactService(db());
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    await next();
  });

  app.get('/reports/dpb/requests', async (c) => {
    const denied = requireCapability(c, Capability.REPORT_READ);
    if (denied) return denied;
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(50)
      .safeParse(c.req.query('limit') ?? '25');
    const offset = z.coerce
      .number()
      .int()
      .min(0)
      .max(10_000)
      .safeParse(c.req.query('offset') ?? '0');
    if (!limit.success || !offset.success) return invalid(c);
    try {
      return c.json(
        await service().listRequests(
          c.get('tenantId'),
          c.get('user').id,
          limit.data,
          offset.data,
          AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]),
        ),
      );
    } catch (cause) {
      return failure(c, cause);
    }
  });

  app.post('/reports/dpb/request', async (c) => {
    const denied = requireCapability(c, Capability.REPORT_GENERATE);
    if (denied) return denied;
    const body = requestDpbInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c);
    try {
      return c.json(
        await service().request(
          c.get('tenantId'),
          c.get('user').id,
          body.data,
          AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]),
        ),
        201,
      );
    } catch (cause) {
      return failure(c, cause);
    }
  });
  app.post('/reports/dpb/requests/:id/generate', async (c) => {
    const denied = requireCapability(c, Capability.REPORT_GENERATE);
    if (denied) return denied;
    const id = c.req.param('id');
    if (!z.uuid().safeParse(id).success) return invalid(c);
    try {
      return c.json(
        await service().draft(
          c.get('tenantId'),
          c.get('user').id,
          id,
          AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30_000)]),
        ),
      );
    } catch (cause) {
      return failure(c, cause);
    }
  });
  app.get('/reports/dpb/requests/:id/source', async (c) => {
    const denied = requireCapability(c, Capability.REPORT_REVIEW);
    if (denied) return denied;
    const id = c.req.param('id');
    if (!z.uuid().safeParse(id).success) return invalid(c);
    try {
      return c.json(
        await service().source(
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
  app.get('/reports/dpb/:id/artifacts/status', async (c) => {
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
  for (const [suffix, method] of [
    ['', 'build'],
    ['/reconcile', 'reconcile'],
    ['/retry-missing', 'retryMissing'],
  ] as const) {
    app.post(`/reports/dpb/:id/artifacts${suffix}`, async (c) => {
      const denied = requireCapability(c, Capability.REPORT_GENERATE);
      if (denied) return denied;
      const id = c.req.param('id');
      const body = operation.safeParse(await c.req.json().catch(() => null));
      if (!z.uuid().safeParse(id).success || !body.success) return invalid(c);
      try {
        const result = await artifacts()[method](
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
  app.post('/reports/dpb/:id/release', async (c) => {
    const denied = requireCapability(c, Capability.REPORT_RELEASE);
    if (denied) return denied;
    const id = c.req.param('id');
    const body = release.safeParse(await c.req.json().catch(() => null));
    if (!z.uuid().safeParse(id).success || !body.success) return invalid(c);
    try {
      return c.json(
        await service().release(
          c.get('tenantId'),
          c.get('user').id,
          id,
          body.data.contentHash,
          body.data.pdfHash,
          artifacts(),
          AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30_000)]),
        ),
      );
    } catch (cause) {
      return failure(c, cause);
    }
  });
  app.get('/reports/dpb/:id/pdf', async (c) => {
    const denied = requireCapability(c, Capability.REPORT_READ);
    if (denied) return denied;
    const id = c.req.param('id');
    if (!z.uuid().safeParse(id).success) return invalid(c);
    try {
      const pdf = await artifacts().pdf(
        c.get('tenantId'),
        c.get('user').id,
        id,
        AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30_000)]),
      );
      return new Response(new Uint8Array(pdf.pdfBuffer), {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="dpb-review-${id}.pdf"`,
          'Content-Length': String(pdf.byteLength),
          'X-Report-SHA256': pdf.sha256,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch (cause) {
      return failure(c, cause);
    }
  });
  return app;
}
