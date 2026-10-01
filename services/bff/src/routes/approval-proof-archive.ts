import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { Capability } from '@axiom/types';
import type { ApprovalEngine } from '@axiom/approval-engine';
import { createSupabaseAdmin } from '@axiom/supabase';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';
import { EvidenceError, type EvidenceDatabase } from '../services/evidence-ingestion.js';
import { ApprovalProofArchiveService } from '../services/approval-proof-archive.js';

type Ctx = Context<{ Variables: Variables }>;
const input = z.object({ operationKey: z.uuid() }).strict();
const reviewInput = z
  .object({
    sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
    versionId: z.string().min(1).max(1024),
  })
  .strict();
function failure(c: Ctx, cause: unknown) {
  if (cause instanceof EvidenceError) return c.json({ error: { code: cause.code } }, cause.status);
  return c.json({ error: { code: 'approval_archive_unavailable' } }, 503);
}
function invalid(c: Ctx) {
  return c.json({ error: { code: 'validation_failed' } }, 400);
}

export function approvalProofArchiveRoutes(dependencies: {
  approvalEngine: ApprovalEngine;
  db?: EvidenceDatabase;
  writer?: () => EvidenceDatabase;
  service?: ApprovalProofArchiveService;
}) {
  const app = new Hono<{ Variables: Variables }>();
  const service = () =>
    dependencies.service ??
    new ApprovalProofArchiveService(
      dependencies.db ?? createSupabaseAdmin(),
      dependencies.approvalEngine,
      undefined,
      dependencies.writer,
    );
  app.post('/approvals/:tokenId/archive', async (c) => {
    const denied = requireCapability(c, Capability.EVIDENCE_EXPORT);
    if (denied) return denied;
    const tokenId = c.req.param('tokenId');
    const parsed = input.safeParse(await c.req.json().catch(() => null));
    if (!z.uuid().safeParse(tokenId).success || !parsed.success) return invalid(c);
    try {
      const result = await service().start(
        c.get('tenantId'),
        c.get('user').id,
        tokenId,
        parsed.data.operationKey,
        AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(60_000)]),
      );
      c.header('Cache-Control', 'private, no-store');
      return c.json(result, result.status === 'pending' ? 202 : 200);
    } catch (cause) {
      return failure(c, cause);
    }
  });
  app.get('/approvals/:tokenId/archive', async (c) => {
    const denied = requireCapability(c, Capability.EVIDENCE_EXPORT);
    if (denied) return denied;
    const tokenId = c.req.param('tokenId');
    if (!z.uuid().safeParse(tokenId).success) return invalid(c);
    try {
      const result = await service().statusForToken(
        c.get('tenantId'),
        c.get('user').id,
        tokenId,
        AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(20_000)]),
      );
      c.header('Cache-Control', 'private, no-store');
      return c.json(result);
    } catch (cause) {
      return failure(c, cause);
    }
  });
  app.get('/approval-archives/:id', async (c) => {
    const denied = requireCapability(c, Capability.EVIDENCE_EXPORT);
    if (denied) return denied;
    const id = c.req.param('id');
    if (!z.uuid().safeParse(id).success) return invalid(c);
    try {
      const result = await service().status(
        c.get('tenantId'),
        c.get('user').id,
        id,
        AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(20_000)]),
      );
      c.header('Cache-Control', 'private, no-store');
      return c.json(result);
    } catch (cause) {
      return failure(c, cause);
    }
  });
  app.post('/approval-archives/:id/reconcile', async (c) => {
    const denied = requireCapability(c, Capability.EVIDENCE_EXPORT);
    if (denied) return denied;
    const id = c.req.param('id');
    if (!z.uuid().safeParse(id).success) return invalid(c);
    try {
      const result = await service().reconcile(
        c.get('tenantId'),
        c.get('user').id,
        id,
        AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(60_000)]),
      );
      c.header('Cache-Control', 'private, no-store');
      return c.json(result, result.status === 'pending' ? 202 : 200);
    } catch (cause) {
      return failure(c, cause);
    }
  });
  app.post('/approval-archives/:id/retry-missing', async (c) => {
    const denied = requireCapability(c, Capability.EVIDENCE_EXPORT);
    if (denied) return denied;
    const id = c.req.param('id');
    if (!z.uuid().safeParse(id).success) return invalid(c);
    try {
      const result = await service().retryMissing(
        c.get('tenantId'),
        c.get('user').id,
        id,
        AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(60_000)]),
      );
      c.header('Cache-Control', 'private, no-store');
      return c.json(result, result.status === 'pending' ? 202 : 200);
    } catch (cause) {
      return failure(c, cause);
    }
  });
  app.post('/approval-archives/:id/release', async (c) => {
    const denied = requireCapability(c, Capability.EVIDENCE_EXPORT);
    if (denied) return denied;
    const id = c.req.param('id');
    if (!z.uuid().safeParse(id).success) return invalid(c);
    try {
      const result = await service().release(
        c.get('tenantId'),
        c.get('user').id,
        id,
        AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(60_000)]),
      );
      c.header('Cache-Control', 'private, no-store');
      return c.json(result);
    } catch (cause) {
      return failure(c, cause);
    }
  });
  app.get('/approval-archives/:id/preview', async (c) => {
    const denied = requireCapability(c, Capability.EVIDENCE_EXPORT);
    if (denied) return denied;
    const id = c.req.param('id');
    if (!z.uuid().safeParse(id).success) return invalid(c);
    try {
      const result = await service().preview(
        c.get('tenantId'),
        c.get('user').id,
        id,
        AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(45_000)]),
      );
      c.header('Cache-Control', 'private, no-store');
      return c.json(result);
    } catch (cause) {
      return failure(c, cause);
    }
  });
  app.post('/approval-archives/:id/review', async (c) => {
    const denied = requireCapability(c, Capability.EVIDENCE_EXPORT);
    if (denied) return denied;
    const id = c.req.param('id');
    const parsed = reviewInput.safeParse(await c.req.json().catch(() => null));
    if (!z.uuid().safeParse(id).success || !parsed.success) return invalid(c);
    try {
      const result = await service().review(
        c.get('tenantId'),
        c.get('user').id,
        id,
        parsed.data.sourceSha256,
        parsed.data.versionId,
        AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(60_000)]),
      );
      c.header('Cache-Control', 'private, no-store');
      return c.json(result);
    } catch (cause) {
      return failure(c, cause);
    }
  });
  app.get('/approval-archives/:id/download', async (c) => {
    const denied = requireCapability(c, Capability.EVIDENCE_EXPORT);
    if (denied) return denied;
    const id = c.req.param('id');
    if (!z.uuid().safeParse(id).success) return invalid(c);
    try {
      const result = await service().download(
        c.get('tenantId'),
        c.get('user').id,
        id,
        AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(45_000)]),
      );
      return new Response(new Uint8Array(result.bytes), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="approval-proof-${id}.json"`,
          'Content-Length': String(result.bytes.byteLength),
          'X-Archive-SHA256': result.sha256,
          'X-Archive-Version-ID': result.versionId,
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
