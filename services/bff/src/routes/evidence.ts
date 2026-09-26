import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { Capability, EvidenceType } from '@axiom/types';
import { createSupabaseAdmin } from '@axiom/supabase';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';
import {
  EvidenceError,
  EvidenceIngestionService,
  evidenceStorage,
  evidenceUploadSchema,
  operationSchema,
  publicOperation,
  publicReceipt,
  receiptSchema,
  type EvidenceDatabase,
  type EvidenceReceipt,
} from '../services/evidence-ingestion.js';

const columns =
  'id,engagement_id,content_hash,filename,mime_type,byte_size,evidence_type,description,collected_by_agent,collected_at,demonstrates_control_ids';
const rowSchema = z.object({
  id: z.uuid(),
  engagement_id: z.uuid().nullable(),
  // Legacy DDL required length only; an invalid historical digest is unverified data, not a tenant-wide outage.
  content_hash: z.string(),
  filename: z.string().nullable(),
  mime_type: z.string().nullable(),
  byte_size: z.number().int().nonnegative().nullable(),
  evidence_type: z.enum(EvidenceType),
  description: z.string().nullable(),
  collected_by_agent: z.string(),
  collected_at: z.string(),
  demonstrates_control_ids: z.array(z.string()),
});
const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(25),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const dateFilter = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
const querySchema = pageSchema
  .extend({
    q: z.string().trim().max(120).optional(),
    controlId: z.string().min(1).max(80).optional(),
    source: z.string().min(1).max(100).optional(),
    from: dateFilter.optional(),
    to: dateFilter.optional(),
  })
  .strict();
type EvidenceContext = Context<{ Variables: Variables }>;
function failure(c: EvidenceContext, cause: unknown) {
  if (cause instanceof EvidenceError) return c.json({ error: { code: cause.code } }, cause.status);
  return c.json({ error: { code: 'evidence_storage_unavailable' } }, 503);
}
function invalid(c: EvidenceContext) {
  return c.json({ error: { code: 'validation_failed' } }, 400);
}
function metadata(total: number, limit: number, offset: number) {
  return { total, limit, offset, hasMore: offset + limit < total };
}

export function evidenceRoutes(
  dependencies: { db?: EvidenceDatabase; service?: EvidenceIngestionService } = {},
) {
  const app = new Hono<{ Variables: Variables }>();
  const db = () => dependencies.db ?? createSupabaseAdmin();
  const service = () => {
    if (dependencies.service) return dependencies.service;
    const { vault, config } = evidenceStorage();
    return new EvidenceIngestionService(db(), vault, config);
  };
  async function receipts(database: EvidenceDatabase, tenantId: string, ids: string[]) {
    if (!ids.length) return new Map<string, EvidenceReceipt>();
    const result = await database
      .from('evidence_object_versions')
      .select('*')
      .eq('tenant_id', tenantId)
      .in('evidence_id', ids);
    const parsed = z.array(receiptSchema).safeParse(result.data);
    if (result.error || !parsed.success)
      throw new EvidenceError('evidence_storage_unavailable', 503);
    const map = new Map<string, EvidenceReceipt>();
    for (const receipt of parsed.data) {
      if (
        receipt.tenant_id !== tenantId ||
        !ids.includes(receipt.evidence_id) ||
        map.has(receipt.evidence_id)
      )
        throw new EvidenceError('invalid_evidence_receipt', 503);
      map.set(receipt.evidence_id, receipt);
    }
    return map;
  }
  function decorate(row: z.infer<typeof rowSchema>, receipt?: EvidenceReceipt) {
    if (
      receipt &&
      (receipt.content_hash !== row.content_hash || receipt.byte_size !== row.byte_size)
    )
      throw new EvidenceError('invalid_evidence_receipt', 503);
    return {
      ...row,
      object_version: receipt ? publicReceipt(receipt) : null,
      assurance: receipt ? ('verified_at_ingest' as const) : ('legacy_unverified' as const),
    };
  }
  async function detail(tenantId: string, id: string) {
    const database = db();
    const result = await database
      .from('evidence')
      .select(columns)
      .eq('tenant_id', tenantId)
      .eq('id', id)
      .maybeSingle();
    if (result.error) throw new EvidenceError('evidence_storage_unavailable', 503);
    if (!result.data) throw new EvidenceError('evidence_not_found', 404);
    const parsed = rowSchema.safeParse(result.data);
    if (!parsed.success) throw new EvidenceError('invalid_evidence_receipt', 503);
    const receipt = (await receipts(database, tenantId, [id])).get(id);
    return { row: decorate(parsed.data, receipt), receipt };
  }

  app.get('/evidence', async (c) => {
    const refused = requireCapability(c, Capability.EVIDENCE_READ);
    if (refused) return refused;
    const parsed = querySchema.safeParse(c.req.query());
    if (!parsed.success) return invalid(c);
    const input = parsed.data;
    if (input.from && input.to && Date.parse(input.from) > Date.parse(input.to)) return invalid(c);
    try {
      const database = db();
      let query = database
        .from('evidence')
        .select(columns, { count: 'exact' })
        .eq('tenant_id', c.get('tenantId'));
      // Literal description search: escapes LIKE wildcards; no PostgREST OR grammar is assembled from input.
      if (input.q) query = query.ilike('description', `%${input.q.replace(/[\\%_]/g, '\\$&')}%`);
      if (input.controlId) query = query.contains('demonstrates_control_ids', [input.controlId]);
      if (input.source) query = query.eq('collected_by_agent', input.source);
      if (input.from)
        query = query.gte(
          'collected_at',
          input.from.length === 10 ? `${input.from}T00:00:00.000Z` : input.from,
        );
      if (input.to)
        query = query.lte(
          'collected_at',
          input.to.length === 10 ? `${input.to}T23:59:59.999Z` : input.to,
        );
      const result = await query
        .order('collected_at', { ascending: false })
        .order('id', { ascending: false })
        .range(input.offset, input.offset + input.limit - 1);
      const rows = z.array(rowSchema).safeParse(result.data);
      if (result.error || !rows.success || typeof result.count !== 'number')
        throw new EvidenceError('evidence_storage_unavailable', 503);
      const objects = await receipts(
        database,
        c.get('tenantId'),
        rows.data.map((row) => row.id),
      );
      return c.json({
        data: rows.data.map((row) => decorate(row, objects.get(row.id))),
        meta: metadata(result.count, input.limit, input.offset),
      });
    } catch (cause) {
      return failure(c, cause);
    }
  });

  app.get('/evidence/ingestions', async (c) => {
    const refused = requireCapability(c, Capability.EVIDENCE_READ);
    if (refused) return refused;
    const parsed = pageSchema.strict().safeParse(c.req.query());
    if (!parsed.success) return invalid(c);
    try {
      const { limit, offset } = parsed.data;
      const result = await db()
        .from('evidence_ingestions')
        .select('*', { count: 'exact' })
        .eq('tenant_id', c.get('tenantId'))
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(offset, offset + limit - 1);
      const rows = z.array(operationSchema).safeParse(result.data);
      if (result.error || !rows.success || typeof result.count !== 'number')
        throw new EvidenceError('evidence_storage_unavailable', 503);
      if (rows.data.some((row) => row.tenant_id !== c.get('tenantId')))
        throw new EvidenceError('invalid_ingestion_receipt', 503);
      return c.json({
        data: rows.data.map(publicOperation),
        meta: metadata(result.count, limit, offset),
      });
    } catch (cause) {
      return failure(c, cause);
    }
  });
  app.get('/evidence/ingestions/:key', async (c) => {
    const refused = requireCapability(c, Capability.EVIDENCE_READ);
    if (refused) return refused;
    if (!z.uuid().safeParse(c.req.param('key')).success) return invalid(c);
    try {
      return c.json({
        data: publicOperation(await service().operation(c.get('tenantId'), c.req.param('key'))),
      });
    } catch (cause) {
      return failure(c, cause);
    }
  });
  app.post('/evidence/ingestions', async (c) => {
    const refused = requireCapability(c, Capability.EVIDENCE_RECORD);
    if (refused) return refused;
    const parsed = evidenceUploadSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalid(c);
    try {
      const result = await service().ingest(c.get('tenantId'), c.get('user').id, parsed.data);
      return c.json({ data: result }, result.status === 'settled' ? 201 : 202);
    } catch (cause) {
      return failure(c, cause);
    }
  });
  app.post('/evidence/ingestions/:key/reconcile', async (c) => {
    const refused = requireCapability(c, Capability.EVIDENCE_RECORD);
    if (refused) return refused;
    if (
      !z.uuid().safeParse(c.req.param('key')).success ||
      !z
        .object({})
        .strict()
        .safeParse(await c.req.json().catch(() => null)).success
    )
      return invalid(c);
    try {
      const result = await service().reconcile(
        c.get('tenantId'),
        c.get('user').id,
        c.req.param('key'),
      );
      return c.json({ data: result }, result.status === 'settled' ? 200 : 202);
    } catch (cause) {
      return failure(c, cause);
    }
  });
  app.get('/evidence/:id', async (c) => {
    const refused = requireCapability(c, Capability.EVIDENCE_READ);
    if (refused) return refused;
    if (!z.uuid().safeParse(c.req.param('id')).success) return invalid(c);
    try {
      return c.json({ data: (await detail(c.get('tenantId'), c.req.param('id'))).row });
    } catch (cause) {
      return failure(c, cause);
    }
  });
  app.post('/evidence/:id/verify', async (c) => {
    const refused = requireCapability(c, Capability.EVIDENCE_READ);
    if (refused) return refused;
    if (
      !z.uuid().safeParse(c.req.param('id')).success ||
      !z
        .object({})
        .strict()
        .safeParse(await c.req.json().catch(() => null)).success
    )
      return invalid(c);
    try {
      const { row, receipt } = await detail(c.get('tenantId'), c.req.param('id'));
      if (!receipt) throw new EvidenceError('evidence_version_unavailable', 409);
      const verified = await service().verify(c.get('tenantId'), receipt, row);
      return c.json({
        data: {
          evidenceId: row.id,
          integrity: 'verified',
          retention: 'verified',
          verifiedAt: verified.readbackAt,
          versionId: receipt.version_id,
          retainUntil: verified.retainUntil,
          legalHold: verified.legalHold,
          encryption: verified.encryption,
        },
      });
    } catch (cause) {
      return failure(c, cause);
    }
  });
  app.get('/evidence/:id/content', async (c) => {
    const refused = requireCapability(c, Capability.EVIDENCE_EXPORT);
    if (refused) return refused;
    if (!z.uuid().safeParse(c.req.param('id')).success) return invalid(c);
    try {
      const { row, receipt } = await detail(c.get('tenantId'), c.req.param('id'));
      if (!receipt) throw new EvidenceError('evidence_version_unavailable', 409);
      const bytes = await service().content(c.get('tenantId'), receipt, row);
      // Browser content is always an attachment. MIME and filename never enable active rendering.
      return new Response(new Uint8Array(bytes), {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(bytes.length),
          'Content-Disposition': `attachment; filename="evidence-${row.id}.bin"`,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
          'X-Evidence-Sha256': row.content_hash,
        },
      });
    } catch (cause) {
      return failure(c, cause);
    }
  });
  return app;
}
