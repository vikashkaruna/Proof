/**
 * Approval Exports API Routes.
 * Implements listing of approval history, audit trail exports in JSON/HTML/PDF/CSV,
 * and plan-specific approval exports (W8 / BR-1 / BR-2 / Revision 106).
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
  ApprovalExportService,
  listApprovalHistoryInputSchema,
  exportApprovalHistoryInputSchema,
} from '../services/approval-exports.js';

type Ctx = Context<{ Variables: Variables }>;

function failure(c: Ctx, cause: unknown) {
  if (cause instanceof EvidenceError) {
    return c.json({ error: { code: cause.code } }, cause.status);
  }
  return c.json({ error: { code: 'export_storage_unavailable' } }, 503);
}

function invalid(c: Ctx, message?: string) {
  return c.json({ error: { code: 'validation_failed', message } }, 400);
}

export function approvalExportRoutes(
  dependencies: {
    db?: EvidenceDatabase;
    writer?: () => EvidenceDatabase;
    service?: ApprovalExportService;
  } = {},
) {
  const app = new Hono<{ Variables: Variables }>();
  const service = () =>
    dependencies.service ??
    new ApprovalExportService(dependencies.db ?? createSupabaseAdmin(), dependencies.writer);

  // 1. List Approval History
  app.get('/approvals/history', async (c) => {
    const denied = requireCapability(c, Capability.PLAN_READ);
    if (denied) return denied;

    const query = c.req.query();
    const parsed = listApprovalHistoryInputSchema.safeParse(query);
    if (!parsed.success) return invalid(c, 'Invalid query parameters');

    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(20_000)]);
    try {
      const result = await service().listApprovalHistory(
        c.get('tenantId'),
        c.get('user').id,
        parsed.data,
        signal,
      );
      c.header('Cache-Control', 'private, no-store');
      c.header('X-Content-Type-Options', 'nosniff');
      return c.json(result, 200);
    } catch (cause) {
      return failure(c, cause);
    }
  });

  // 2. Export Approval History (tenant-wide or filtered)
  app.get('/approvals/export', async (c) => {
    const denied = requireCapability(c, Capability.EVIDENCE_EXPORT);
    if (denied) return denied;

    const query = c.req.query();
    const parsed = exportApprovalHistoryInputSchema.safeParse(query);
    if (!parsed.success) return invalid(c, 'Invalid export parameters');

    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30_000)]);
    const correlationId = randomUUID();
    try {
      const result = await service().exportApprovalHistory(
        c.get('tenantId'),
        c.get('user').id,
        parsed.data,
        correlationId,
        signal,
      );

      const headers: Record<string, string> = {
        'Content-Type': result.mimeType,
        'Content-Disposition': `attachment; filename="${result.filename}"`,
        'Content-Length': String(result.bytes),
        'X-Export-SHA256': result.sha256,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      };
      if (result.exportId) {
        headers['X-Export-ID'] = result.exportId;
      }

      return new Response(new Uint8Array(result.buffer), {
        status: 200,
        headers,
      });
    } catch (cause) {
      return failure(c, cause);
    }
  });

  // 3. Plan-specific Approval Export
  app.get('/plans/:id/approval-export', async (c) => {
    const denied = requireCapability(c, Capability.EVIDENCE_EXPORT);
    if (denied) return denied;

    const id = c.req.param('id');
    if (!z.uuid().safeParse(id).success) return invalid(c, 'Invalid plan ID');

    const query = c.req.query();
    const parsed = exportApprovalHistoryInputSchema.safeParse({
      ...query,
      planId: id,
    });
    if (!parsed.success) return invalid(c, 'Invalid export parameters');

    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30_000)]);
    const correlationId = randomUUID();
    try {
      const result = await service().exportApprovalHistory(
        c.get('tenantId'),
        c.get('user').id,
        parsed.data,
        correlationId,
        signal,
      );

      const headers: Record<string, string> = {
        'Content-Type': result.mimeType,
        'Content-Disposition': `attachment; filename="${result.filename}"`,
        'Content-Length': String(result.bytes),
        'X-Export-SHA256': result.sha256,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      };
      if (result.exportId) {
        headers['X-Export-ID'] = result.exportId;
      }

      return new Response(new Uint8Array(result.buffer), {
        status: 200,
        headers,
      });
    } catch (cause) {
      return failure(c, cause);
    }
  });

  return app;
}
