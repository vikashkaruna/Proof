/**
 * Pramaan Statutory Closure & Dispatch API Routes.
 * Historical dossier inspection and fail-closed source/dispatch boundaries.
 */
import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { Capability } from '@axiom/types';
import { createStatutoryProofWriter, createSupabaseAdmin } from '@axiom/supabase';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';
import { EvidenceError, type EvidenceDatabase } from '../services/evidence-ingestion.js';
import {
  PramaanClosureService,
  synthesizeDossierInputSchema,
  sealDossierInputSchema,
  listDossiersInputSchema,
  dispatchReportEmailInputSchema,
} from '../services/pramaan-closure.js';

type Ctx = Context<{ Variables: Variables }>;

function failure(c: Ctx, cause: unknown) {
  if (cause instanceof EvidenceError) {
    return c.json({ error: { code: cause.code } }, cause.status);
  }
  return c.json({ error: { code: 'closure_storage_unavailable' } }, 503);
}

function invalid(c: Ctx, message?: string) {
  return c.json({ error: { code: 'validation_failed', message } }, 400);
}

export function pramaanClosureRoutes(
  dependencies: { db?: EvidenceDatabase; service?: PramaanClosureService } = {},
) {
  const app = new Hono<{ Variables: Variables }>();
  const service = () =>
    dependencies.service ??
    new PramaanClosureService(
      dependencies.db ?? createSupabaseAdmin(),
      dependencies.db ?? createStatutoryProofWriter(),
    );

  // 1. Synthesize Statutory Closure Dossier (Pramaan Agent L1 / Authorized Manager)
  app.post('/engagements/:engagementId/closure/pramaan', async (c) => {
    const denied = requireCapability(c, Capability.REPORT_GENERATE);
    if (denied) return denied;

    const engagementId = c.req.param('engagementId');
    if (!z.string().uuid().safeParse(engagementId).success) {
      return invalid(c, 'Invalid engagement ID');
    }

    const body = await c.req.json().catch(() => null);
    const parsed = synthesizeDossierInputSchema.safeParse({ ...body, engagementId });
    if (!parsed.success) return invalid(c, 'Invalid dossier synthesis payload');

    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30_000)]);
    const correlationId = randomUUID();
    try {
      const result = await service().synthesizeDossier(
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

  // 2. Seal Dossier under Founder Authority
  app.post('/dossiers/:id/seal', async (c) => {
    const denied = requireCapability(c, Capability.REPORT_RELEASE);
    if (denied) return denied;

    const id = c.req.param('id');
    if (!z.string().uuid().safeParse(id).success) return invalid(c, 'Invalid dossier ID');

    const body = await c.req.json().catch(() => null);
    const parsed = sealDossierInputSchema.safeParse(body);
    if (!parsed.success) return invalid(c, 'Invalid seal payload');

    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30_000)]);
    const correlationId = randomUUID();
    try {
      const result = await service().sealDossier(
        c.get('tenantId'),
        c.get('user').id,
        id,
        parsed.data,
        correlationId,
        signal,
      );
      return c.json(result, 200);
    } catch (cause) {
      return failure(c, cause);
    }
  });

  // An ambiguous provider response never creates a second object. This route
  // looks up only the fixed object key and settles an independently verified version.
  app.post('/dossiers/:id/archive/reconcile', async (c) => {
    const denied = requireCapability(c, Capability.REPORT_GENERATE);
    if (denied) return denied;
    const id = c.req.param('id');
    if (!z.string().uuid().safeParse(id).success) return invalid(c, 'Invalid dossier ID');
    const body = await c.req.json().catch(() => null);
    const parsed = z.object({ operationKey: z.string().uuid() }).strict().safeParse(body);
    if (!parsed.success) return invalid(c, 'Invalid reconciliation payload');
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30_000)]);
    try {
      const result = await service().reconcileDossier(
        c.get('tenantId'),
        c.get('user').id,
        id,
        parsed.data.operationKey,
        signal,
      );
      return c.json(result, 200);
    } catch (cause) {
      return failure(c, cause);
    }
  });

  app.post('/dossiers/:id/archive/retry-missing', async (c) => {
    const denied = requireCapability(c, Capability.REPORT_RELEASE);
    if (denied) return denied;
    const id = c.req.param('id');
    if (!z.string().uuid().safeParse(id).success) return invalid(c, 'Invalid dossier ID');
    const body = await c.req.json().catch(() => null);
    const parsed = z.object({ operationKey: z.string().uuid() }).strict().safeParse(body);
    if (!parsed.success) return invalid(c, 'Invalid retry payload');
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30_000)]);
    try {
      return c.json(
        await service().retryMissingDossier(
          c.get('tenantId'),
          c.get('user').id,
          id,
          parsed.data.operationKey,
          signal,
        ),
      );
    } catch (cause) {
      return failure(c, cause);
    }
  });

  app.get('/dossiers/:id/archive', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.REPORT_RELEASE);
    if (denied) return denied;
    const id = c.req.param('id');
    if (!z.string().uuid().safeParse(id).success) return invalid(c, 'Invalid dossier ID');
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30_000)]);
    try {
      const result = await service().getDossierArchive(
        c.get('tenantId'),
        c.get('user').id,
        id,
        signal,
      );
      c.header('Content-Type', 'application/zip');
      c.header('X-Content-SHA256', result.sha256);
      c.header('Content-Disposition', `attachment; filename="pramaan-${id}.zip"`);
      return c.body(new Uint8Array(result.body));
    } catch (cause) {
      return failure(c, cause);
    }
  });

  // 3. List Dossiers
  app.get('/dossiers', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.REPORT_RELEASE);
    if (denied) return denied;

    const query = c.req.query();
    const parsed = listDossiersInputSchema.safeParse(query);
    if (!parsed.success) return invalid(c, 'Invalid list query parameters');

    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]);
    try {
      const result = await service().listDossiers(
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

  app.get('/dossiers/mine', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.REPORT_GENERATE);
    if (denied) return denied;
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]);
    try {
      return c.json(await service().listMyBuilds(c.get('tenantId'), c.get('user').id, signal));
    } catch (cause) {
      return failure(c, cause);
    }
  });

  // 4. Get Dossier by ID
  app.get('/dossiers/:id', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.REPORT_GENERATE);
    if (denied) return denied;

    const id = c.req.param('id');
    if (!z.string().uuid().safeParse(id).success) return invalid(c, 'Invalid dossier ID');

    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]);
    try {
      const result = await service().getDossier(c.get('tenantId'), c.get('user').id, id, signal);
      return c.json(result, 200);
    } catch (cause) {
      return failure(c, cause);
    }
  });

  // 5. Dispatch Report or Dossier via Email
  app.post('/reports/email/dispatch', async (c) => {
    const denied = requireCapability(c, Capability.REPORT_GENERATE);
    if (denied) return denied;

    const body = await c.req.json().catch(() => null);
    const parsed = dispatchReportEmailInputSchema.safeParse(body);
    if (!parsed.success) return invalid(c, 'Invalid email dispatch payload');

    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30_000)]);
    const correlationId = randomUUID();
    try {
      const result = await service().dispatchReportEmail(
        c.get('tenantId'),
        c.get('user').id,
        parsed.data,
        correlationId,
        signal,
      );
      return c.json(result, 200);
    } catch (cause) {
      return failure(c, cause);
    }
  });

  return app;
}
