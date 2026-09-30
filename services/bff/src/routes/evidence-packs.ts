import { randomUUID, createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { Capability } from '@axiom/types';
import { createStatutoryProofWriter, createSupabaseAdmin } from '@axiom/supabase';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';
import { EvidenceError, type EvidenceDatabase } from '../services/evidence-ingestion.js';
import { EvidencePackService, preparePackSchema } from '../services/evidence-packs.js';
import {
  digest,
  publicPack,
  publicReport,
  reportStatus,
  uuid,
} from '../services/evidence-pack-records.js';

type Ctx = Context<{ Variables: Variables }>;
const pageQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(25),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
    status: reportStatus.optional(),
  })
  .strict();
function failure(c: Ctx, cause: unknown) {
  if (cause instanceof EvidenceError) return c.json({ error: { code: cause.code } }, cause.status);
  return c.json({ error: { code: 'report_storage_unavailable' } }, 503);
}
function invalid(c: Ctx) {
  return c.json({ error: { code: 'validation_failed' } }, 400);
}
function validId(c: Ctx) {
  return uuid.safeParse(c.req.param('id')).success;
}
export function evidencePackRoutes(
  dependencies: { db?: EvidenceDatabase; service?: EvidencePackService } = {},
) {
  const app = new Hono<{ Variables: Variables }>();
  const service = () =>
    dependencies.service ??
    new EvidencePackService(
      dependencies.db ?? createSupabaseAdmin(),
      undefined,
      dependencies.db ?? createStatutoryProofWriter(),
    );
  app.get('/evidence-packs/options/engagements', async (c) => {
    const denied = requireCapability(c, Capability.EVIDENCE_RECORD);
    if (denied) return denied;
    const input = pageQuery
      .omit({ status: true })
      .extend({ limit: z.coerce.number().int().min(1).max(50).default(20) })
      .safeParse(c.req.query());
    if (!input.success) return invalid(c);
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]);
    try {
      return c.json(
        await service().engagementOptions(c.get('tenantId'), c.get('user').id, input.data, signal),
      );
    } catch (cause) {
      return failure(c, cause);
    }
  });
  for (const kind of ['reports', 'evidence-packs'] as const) {
    app.get(`/${kind}`, async (c) => {
      const denied = requireCapability(c, Capability.REPORT_READ);
      if (denied) return denied;
      const input = pageQuery.safeParse(c.req.query());
      if (!input.success) return invalid(c);
      try {
        const api = service();
        return c.json(
          await api.list(
            await api.access(c.get('tenantId'), c.get('user').id),
            input.data,
            kind === 'evidence-packs',
          ),
        );
      } catch (cause) {
        return failure(c, cause);
      }
    });
  }
  app.get('/reports/:id', async (c) => {
    const denied = requireCapability(c, Capability.REPORT_READ);
    if (denied) return denied;
    if (!validId(c)) return invalid(c);
    try {
      const api = service();
      const access = await api.access(c.get('tenantId'), c.get('user').id);
      const report = await api.report(access, c.req.param('id'));
      const related = await api.relations(access, [report]);
      return c.json({
        data: publicReport(
          report,
          related.reviews.get(report.id) ?? null,
          related.packs.get(report.id) ?? null,
          true,
        ),
      });
    } catch (cause) {
      return failure(c, cause);
    }
  });
  app.get('/evidence-packs/:id', async (c) => {
    const denied = requireCapability(c, Capability.REPORT_READ);
    if (denied) return denied;
    if (!validId(c)) return invalid(c);
    try {
      const api = service();
      return c.json({
        data: publicPack(
          await api.detail(
            await api.access(c.get('tenantId'), c.get('user').id),
            c.req.param('id'),
          ),
        ),
      });
    } catch (cause) {
      return failure(c, cause);
    }
  });
  app.post('/evidence-packs', async (c) => {
    const denied = requireCapability(c, Capability.EVIDENCE_RECORD);
    if (denied) return denied;
    const input = preparePackSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return invalid(c);
    try {
      const api = service();
      const bundle = await api.prepare(
        await api.access(c.get('tenantId'), c.get('user').id),
        input.data,
        c.req.raw.signal,
      );
      return c.json({ data: publicPack(bundle) }, 201);
    } catch (cause) {
      return failure(c, cause);
    }
  });
  app.post('/evidence-packs/:id/build', async (c) => {
    const denied = requireCapability(c, Capability.EVIDENCE_RECORD);
    if (denied) return denied;
    if (!validId(c)) return invalid(c);
    const input = z
      .object({ operationKey: uuid })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) return invalid(c);
    try {
      const api = service();
      const bundle = await api.build(
        await api.access(c.get('tenantId'), c.get('user').id),
        c.req.param('id'),
        input.data.operationKey,
        c.req.raw.signal,
      );
      return c.json({ data: publicPack(bundle) }, bundle.build?.status === 'settled' ? 200 : 202);
    } catch (cause) {
      return failure(c, cause);
    }
  });
  app.post('/evidence-packs/:id/builds/:operationKey/reconcile', async (c) => {
    const denied = requireCapability(c, Capability.EVIDENCE_RECORD);
    if (denied) return denied;
    if (!validId(c) || !uuid.safeParse(c.req.param('operationKey')).success) return invalid(c);
    if (
      !z
        .object({})
        .strict()
        .safeParse(await c.req.json().catch(() => null)).success
    )
      return invalid(c);
    try {
      const api = service();
      const bundle = await api.reconcile(
        await api.access(c.get('tenantId'), c.get('user').id),
        c.req.param('id'),
        c.req.param('operationKey'),
        c.req.raw.signal,
      );
      return c.json({ data: publicPack(bundle) }, bundle.build?.status === 'settled' ? 200 : 202);
    } catch (cause) {
      return failure(c, cause);
    }
  });
  app.post('/reports/:id/review', async (c) => {
    const denied = requireCapability(c, Capability.REPORT_REVIEW);
    if (denied) return denied;
    if (!validId(c)) return invalid(c);
    const input = z
      .object({
        decision: z.enum(['approved', 'rejected']),
        note: z.string().max(2000).optional(),
        expectedContentHash: digest,
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) return invalid(c);
    try {
      const api = service();
      const access = await api.access(c.get('tenantId'), c.get('user').id);
      if (!access.founder) throw new EvidenceError('founder_authority_required', 403);
      return c.json({
        data: await api.rpc('review_report', {
          p_tenant_id: access.tenantId,
          p_report_id: c.req.param('id'),
          p_decision: input.data.decision,
          p_note: input.data.note ?? null,
          p_reviewed_by: access.actorId,
          p_expected_content_hash: input.data.expectedContentHash,
          p_correlation_id: randomUUID(),
        }),
      });
    } catch (cause) {
      return failure(c, cause);
    }
  });
  app.post('/reports/:id/release', async (c) => {
    const denied = requireCapability(c, Capability.REPORT_RELEASE);
    if (denied) return denied;
    if (!validId(c)) return invalid(c);
    const input = z
      .object({ expectedContentHash: digest, expectedArchiveHash: digest.nullable() })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) return invalid(c);
    try {
      const api = service();
      const access = await api.access(c.get('tenantId'), c.get('user').id);
      if (!access.founder) throw new EvidenceError('founder_authority_required', 403);
      return c.json({
        data: await api.rpc('release_report', {
          p_tenant_id: access.tenantId,
          p_report_id: c.req.param('id'),
          p_released_by: access.actorId,
          p_expected_content_hash: input.data.expectedContentHash,
          p_expected_archive_hash: input.data.expectedArchiveHash,
          p_correlation_id: randomUUID(),
        }),
      });
    } catch (cause) {
      return failure(c, cause);
    }
  });
  app.get('/evidence-packs/:id/content', async (c) => {
    const denied = requireCapability(c, Capability.EVIDENCE_EXPORT);
    if (denied) return denied;
    if (!validId(c)) return invalid(c);
    try {
      const api = service();
      const result = await api.content(
        await api.access(c.get('tenantId'), c.get('user').id),
        c.req.param('id'),
        c.req.raw.signal,
      );
      return new Response(new Uint8Array(result.body), {
        headers: {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="evidence-pack-${c.req.param('id')}.zip"`,
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
          'x-evidence-sha256': result.hash,
        },
      });
    } catch (cause) {
      return failure(c, cause);
    }
  });
  app.get('/evidence-packs/:id/release-receipt', async (c) => {
    const denied = requireCapability(c, Capability.REPORT_READ);
    if (denied) return denied;
    if (!validId(c)) return invalid(c);
    try {
      const api = service();
      const bundle = await api.detail(
        await api.access(c.get('tenantId'), c.get('user').id),
        c.req.param('id'),
      );
      if (
        bundle.report.status !== 'published' ||
        !bundle.archive ||
        bundle.report.released_archive_hash !== bundle.archive.content_hash
      )
        throw new EvidenceError('pack_not_released', 409);
      c.header('Cache-Control', 'private, no-store');
      return c.json({
        data: {
          schema_version: 1,
          pack_id: bundle.pack.id,
          report_id: bundle.report.id,
          manifest_sha256: bundle.pack.manifest_sha256,
          archive_sha256: bundle.archive.content_hash,
          archive_byte_size: bundle.archive.byte_size,
          archive_version_id: bundle.archive.version_id,
          released_at: bundle.report.published_at,
          released_by: bundle.report.released_by,
          reviewer: bundle.review
            ? { id: bundle.review.reviewed_by, display_name: bundle.review.reviewer_name }
            : null,
          assurance:
            'Authenticated recorded release digest; this checksum is not a platform signature or independent provider-retention proof.',
        },
      });
    } catch (cause) {
      return failure(c, cause);
    }
  });
  app.get('/reports/:id/content', async (c) => {
    const denied = requireCapability(c, Capability.EVIDENCE_EXPORT);
    if (denied) return denied;
    if (!validId(c)) return invalid(c);
    try {
      const api = service();
      const access = await api.access(c.get('tenantId'), c.get('user').id);
      if (!access.canExport) throw new EvidenceError('forbidden', 403);
      const report = await api.report(access, c.req.param('id'));
      if (report.kind === 'evidence_pack') throw new EvidenceError('use_pack_content_route', 409);
      if (
        report.status !== 'published' ||
        !report.content_text ||
        !report.content_sha256 ||
        report.reviewed_content_hash !== report.content_sha256
      )
        throw new EvidenceError('report_not_released', 409);
      if (createHash('sha256').update(report.content_text).digest('hex') !== report.content_sha256)
        throw new EvidenceError('invalid_report_record', 503);
      return new Response(report.content_text, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="report-${report.id}.json"`,
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
          'x-evidence-sha256': report.content_sha256,
        },
      });
    } catch (cause) {
      return failure(c, cause);
    }
  });
  return app;
}
