/**
 * Board Reports API Routes.
 * Implements manager-initiated board report requests, deterministic founder
 * draft generation, and private PDF previews.
 */
import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { Capability } from '@axiom/types';
import { createStatutoryProofWriter, createSupabaseAdmin } from '@axiom/supabase';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';
import { EvidenceError, type EvidenceDatabase } from '../services/evidence-ingestion.js';
import { BoardReportService, requestBoardReportInputSchema } from '../services/board-reports.js';
import { BoardArtifactService } from '../services/board-artifacts.js';

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

const paginationSchema = z.object({
  limit: z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .default('25')
    .transform(Number)
    .pipe(z.number().int().min(1).max(50)),
  offset: z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/)
    .default('0')
    .transform(Number)
    .pipe(z.number().int().min(0).max(10_000)),
});

export function boardReportRoutes(
  dependencies: {
    db?: EvidenceDatabase;
    service?: BoardReportService;
    artifacts?: BoardArtifactService;
  } = {},
) {
  const app = new Hono<{ Variables: Variables }>();
  const service = () =>
    dependencies.service ?? new BoardReportService(dependencies.db ?? createSupabaseAdmin(), dependencies.db ?? createStatutoryProofWriter());
  const artifacts = () =>
    dependencies.artifacts ?? new BoardArtifactService(dependencies.db ?? createSupabaseAdmin(), undefined, undefined, dependencies.db ?? createStatutoryProofWriter());

  const operationSchema = z.object({ operationKey: z.uuid() }).strict();

  app.get('/reports/board/assessment-options', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.REPORT_GENERATE);
    if (denied) return denied;
    const page = paginationSchema.safeParse({
      limit: c.req.query('limit'),
      offset: c.req.query('offset'),
    });
    if (!page.success) return invalid(c);
    try {
      return c.json(
        await service().listAssessmentOptions(
          c.get('tenantId'),
          c.get('user').id,
          page.data,
          AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]),
        ),
      );
    } catch (cause) {
      return failure(c, cause);
    }
  });

  app.get('/reports/board/:id/artifacts/status', async (c) => {
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

  app.post('/reports/board/:id/artifacts', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.REPORT_GENERATE);
    if (denied) return denied;
    const id = c.req.param('id');
    const body = operationSchema.safeParse(await c.req.json().catch(() => null));
    if (!z.uuid().safeParse(id).success || !body.success) return invalid(c);
    try {
      const result = await artifacts().build(
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

  app.post('/reports/board/:id/artifacts/reconcile', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.REPORT_GENERATE);
    if (denied) return denied;
    const id = c.req.param('id');
    const body = operationSchema.safeParse(await c.req.json().catch(() => null));
    if (!z.uuid().safeParse(id).success || !body.success) return invalid(c);
    try {
      const result = await artifacts().reconcile(
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

  app.post('/reports/board/:id/artifacts/retry-missing', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.REPORT_GENERATE);
    if (denied) return denied;
    const id = c.req.param('id');
    const body = operationSchema.safeParse(await c.req.json().catch(() => null));
    if (!z.uuid().safeParse(id).success || !body.success) return invalid(c);
    try {
      const result = await artifacts().retryMissing(
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

  // 1. Request Board Report (Manager initiated)
  app.post('/reports/board/request', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.REPORT_GENERATE);
    if (denied) return denied;

    const body = await c.req.json().catch(() => null);
    const parsed = requestBoardReportInputSchema.safeParse(body);
    if (!parsed.success) return invalid(c);

    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]);
    const correlationId = randomUUID();
    try {
      const result = await service().requestBoardReport(
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

  // 2. Generate Draft (Founder only / deterministic renderer)
  app.post('/reports/board/:id/generate', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.REPORT_GENERATE);
    if (denied) return denied;

    const id = c.req.param('id');
    if (!z.uuid().safeParse(id).success) return invalid(c);

    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30_000)]);
    const correlationId = randomUUID();
    try {
      const result = await service().generateDraft(
        c.get('tenantId'),
        c.get('user').id,
        id,
        correlationId,
        signal,
      );
      return c.json(result, 200);
    } catch (cause) {
      return failure(c, cause);
    }
  });

  // 3. Get / Stream PDF (Viewer / Auditor / Member)
  app.get('/reports/board/:id/pdf', async (c) => {
    const denied = requireCapability(c, Capability.REPORT_READ);
    if (denied) return denied;

    const id = c.req.param('id');
    if (!z.uuid().safeParse(id).success) return invalid(c);

    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30_000)]);
    try {
      const result = await artifacts().pdf(c.get('tenantId'), c.get('user').id, id, signal);

      return new Response(new Uint8Array(result.pdfBuffer), {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="board-report-${id}.pdf"`,
          'Content-Length': String(result.byteLength),
          'X-Report-SHA256': result.sha256,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch (cause) {
      return failure(c, cause);
    }
  });

  // 4. List Board Report Requests
  app.get('/reports/board/requests', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.REPORT_READ);
    if (denied) return denied;

    const page = paginationSchema.safeParse({
      limit: c.req.query('limit'),
      offset: c.req.query('offset'),
    });
    if (!page.success) return invalid(c);

    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]);
    try {
      const result = await service().listRequests(
        c.get('tenantId'),
        c.get('user').id,
        page.data,
        signal,
      );
      return c.json(result, 200);
    } catch (cause) {
      return failure(c, cause);
    }
  });

  return app;
}
