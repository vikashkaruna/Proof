/**
 * Board Reports API Routes.
 * Implements manager-initiated board report generation, founder draft synthesis,
 * and immutable PDF streaming.
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
  BoardReportService,
  requestBoardReportInputSchema,
} from '../services/board-reports.js';

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

export function boardReportRoutes(dependencies: { db?: EvidenceDatabase; service?: BoardReportService } = {}) {
  const app = new Hono<{ Variables: Variables }>();
  const service = () => dependencies.service ?? new BoardReportService(dependencies.db ?? createSupabaseAdmin());

  // 1. Request Board Report (Manager initiated)
  app.post('/reports/board/request', async (c) => {
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
        signal
      );
      return c.json(result, 201);
    } catch (cause) {
      return failure(c, cause);
    }
  });

  // 2. Generate Draft (Founder only / Prativedan synthesis)
  app.post('/reports/board/:id/generate', async (c) => {
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
        signal
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
      const result = await service().getReportPdf(
        c.get('tenantId'),
        c.get('user').id,
        id,
        signal
      );

      return new Response(new Uint8Array(result.pdfBuffer), {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="board-report-${id}.pdf"`,
          'Content-Length': String(result.byteLength),
          'X-Report-SHA256': result.sha256,
        },
      });
    } catch (cause) {
      return failure(c, cause);
    }
  });

  // 4. List Board Report Requests
  app.get('/reports/board/requests', async (c) => {
    const denied = requireCapability(c, Capability.REPORT_READ);
    if (denied) return denied;

    const limit = Number(c.req.query('limit')) || 25;
    const offset = Number(c.req.query('offset')) || 0;

    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]);
    try {
      const result = await service().listRequests(
        c.get('tenantId'),
        c.get('user').id,
        { limit, offset },
        signal
      );
      return c.json(result, 200);
    } catch (cause) {
      return failure(c, cause);
    }
  });

  return app;
}
