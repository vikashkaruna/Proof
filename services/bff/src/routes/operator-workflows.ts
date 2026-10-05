import { createHash, randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { createHumanActionWriter } from '@axiom/supabase';
import {
  Capability,
  workflowKindSchema,
  workflowRequestSchema,
  workflowRecordSchema,
  workflowRecordedResponseSchema,
  workflowPageResponseSchema,
  type WorkflowRecord,
} from '@axiom/types';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';
import type { EvidenceDatabase } from '../services/evidence-ingestion.js';

type Ctx = Context<{ Variables: Variables }>;
const uuid = z.uuid().transform((v) => v.toLowerCase());
const querySchema = z
  .object({
    kind: workflowKindSchema,
    limit: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .transform(Number)
      .pipe(z.number().int().max(50))
      .optional()
      .default(20),
    offset: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .transform(Number)
      .pipe(z.number().int().max(100_000))
      .optional()
      .default(0),
  })
  .strict();
const statuses = {
  invalid_record: 400,
  forbidden: 403,
  founder_authority_required: 403,
  context_refused: 404,
  source_refused: 404,
  draft_not_found: 404,
  record_not_found: 404,
  digest_mismatch: 409,
  idempotency_conflict: 409,
  invalid_draft_state: 409,
  legacy_review_history_unavailable: 409,
  operation_cancelled: 409,
  actor_scope_changed: 409,
} as const;
const errorSchema = z
  .object({
    error: z.enum(
      Object.keys(statuses) as [keyof typeof statuses, ...Array<keyof typeof statuses>],
    ),
  })
  .strict();
function refuse(c: Ctx, value: unknown) {
  const parsed = errorSchema.safeParse(value);
  return parsed.success
    ? c.json({ error: { code: parsed.data.error } }, statuses[parsed.data.error])
    : c.json({ error: { code: 'operator_workflow_unavailable' } }, 503);
}
function validRecord(row: WorkflowRecord, tenantId: string) {
  if (row.tenant_id !== tenantId.toLowerCase()) return false;
  if (row.kind === 'policy_draft') {
    return (
      row.content_sha256 === createHash('sha256').update(row.payload.content, 'utf8').digest('hex')
    );
  }
  if (row.kind === 'policy_review') return row.content_sha256 === row.payload.expectedHash;
  return row.content_sha256 === null;
}
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => sameValue(v, b[i]))
    );
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.entries(left).every(([k, v]) => Object.hasOwn(right, k) && sameValue(v, right[k]))
  );
}
function expectedActor(c: Ctx) {
  const actor = uuid.safeParse(c.req.header('X-Expected-Actor-Id'));
  if (!actor.success) return refuse(c, { error: 'invalid_record' });
  return actor.data === c.get('user').id.toLowerCase()
    ? null
    : refuse(c, { error: 'actor_scope_changed' });
}

/** Human-only durable records; SQL rechecks current authority before every replay. */
export function operatorWorkflowRoutes(
  dependencies: { writer?: Pick<EvidenceDatabase, 'rpc'> } = {},
) {
  const app = new Hono<{ Variables: Variables }>();
  async function rpc(c: Ctx, name: string, args: Record<string, unknown>) {
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]);
    return await (dependencies.writer ?? createHumanActionWriter())
      .rpc(name, args)
      .abortSignal(signal);
  }
  app.post('/operator-workflows/records', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const actorDenied = expectedActor(c);
    if (actorDenied) return actorDenied;
    const request = workflowRequestSchema.safeParse(await c.req.json().catch(() => null));
    const key = uuid.safeParse(c.req.header('Idempotency-Key'));
    if (!request.success || !key.success || key.data !== request.data.operationKey)
      return refuse(c, { error: 'invalid_record' });
    const denied = requireCapability(
      c,
      request.data.kind === 'policy_review' ? Capability.REPORT_REVIEW : Capability.ESTATE_MANAGE,
    );
    if (denied) return denied;
    try {
      const { data, error } = await rpc(c, 'record_operator_workflow', {
        p_tenant_id: c.get('tenantId'),
        p_actor_id: c.get('user').id,
        p_operation_key: request.data.operationKey,
        p_kind: request.data.kind,
        p_payload: request.data.payload,
        p_correlation_id: randomUUID(),
      });
      if (error) return refuse(c, null);
      const result = workflowRecordedResponseSchema.safeParse(data);
      if (!result.success) return refuse(c, data);
      const row = result.data.data;
      if (
        !validRecord(row, c.get('tenantId')) ||
        row.created_by !== c.get('user').id.toLowerCase() ||
        row.operation_key !== key.data ||
        row.kind !== request.data.kind ||
        !sameValue(row.payload, request.data.payload)
      )
        return refuse(c, null);
      return c.json(result.data, result.data.replayed ? 200 : 201);
    } catch {
      return refuse(c, null);
    }
  });
  app.get('/operator-workflows/records', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;
    const query = querySchema.safeParse(c.req.query());
    if (!query.success || !Object.values(c.req.queries()).every((v) => v.length === 1))
      return refuse(c, { error: 'invalid_record' });
    try {
      const { data, error } = await rpc(c, 'list_operator_workflows', {
        p_tenant_id: c.get('tenantId'),
        p_actor_id: c.get('user').id,
        p_kind: query.data.kind,
        p_limit: query.data.limit,
        p_offset: query.data.offset,
      });
      if (error) return refuse(c, null);
      const result = workflowPageResponseSchema.safeParse(data);
      if (!result.success) return refuse(c, data);
      if (
        result.data.meta.limit !== query.data.limit ||
        result.data.meta.offset !== query.data.offset ||
        result.data.data.length > query.data.limit ||
        new Set(result.data.data.map((r) => r.id)).size !== result.data.data.length ||
        (result.data.meta.hasMore && result.data.data.length !== query.data.limit) ||
        !result.data.data.every(
          (r) => r.kind === query.data.kind && validRecord(r, c.get('tenantId')),
        )
      )
        return refuse(c, null);
      return c.json(result.data);
    } catch {
      return refuse(c, null);
    }
  });
  app.get('/operator-workflows/requests/:operationKey', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;
    const key = uuid.safeParse(c.req.param('operationKey'));
    if (!key.success || Object.keys(c.req.query()).length)
      return refuse(c, { error: 'invalid_record' });
    try {
      const { data, error } = await rpc(c, 'reconcile_operator_workflow', {
        p_tenant_id: c.get('tenantId'),
        p_actor_id: c.get('user').id,
        p_operation_key: key.data,
      });
      if (error) return refuse(c, null);
      const result = z.object({ data: workflowRecordSchema.nullable() }).strict().safeParse(data);
      if (!result.success) return refuse(c, data);
      const row = result.data.data;
      if (
        row &&
        (!validRecord(row, c.get('tenantId')) ||
          row.operation_key !== key.data ||
          row.created_by !== c.get('user').id.toLowerCase())
      )
        return refuse(c, null);
      return c.json(result.data);
    } catch {
      return refuse(c, null);
    }
  });
  app.get('/operator-workflows/records/:recordId', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;
    const id = uuid.safeParse(c.req.param('recordId'));
    if (!id.success || Object.keys(c.req.query()).length)
      return refuse(c, { error: 'invalid_record' });
    try {
      const { data, error } = await rpc(c, 'read_operator_workflow', {
        p_tenant_id: c.get('tenantId'),
        p_actor_id: c.get('user').id,
        p_record_id: id.data,
      });
      if (error) return refuse(c, null);
      const result = z.object({ data: workflowRecordSchema }).strict().safeParse(data);
      if (!result.success) return refuse(c, data);
      if (!validRecord(result.data.data, c.get('tenantId')) || result.data.data.id !== id.data)
        return refuse(c, null);
      return c.json(result.data);
    } catch {
      return refuse(c, null);
    }
  });
  app.get('/operator-workflows/policy-drafts/:draftId/reviews', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;
    const draft = uuid.safeParse(c.req.param('draftId'));
    if (!draft.success || Object.keys(c.req.query()).length)
      return refuse(c, { error: 'invalid_record' });
    try {
      const { data, error } = await rpc(c, 'read_operator_policy_review', {
        p_tenant_id: c.get('tenantId'),
        p_actor_id: c.get('user').id,
        p_draft_id: draft.data,
      });
      if (error) return refuse(c, null);
      const result = workflowPageResponseSchema.safeParse(data);
      if (!result.success) return refuse(c, data);
      if (
        result.data.meta.limit !== 1 ||
        result.data.meta.offset !== 0 ||
        result.data.meta.hasMore ||
        result.data.data.length > 1 ||
        !result.data.data.every(
          (row) =>
            row.kind === 'policy_review' &&
            row.payload.draftId === draft.data &&
            validRecord(row, c.get('tenantId')),
        )
      )
        return refuse(c, null);
      return c.json(result.data);
    } catch {
      return refuse(c, null);
    }
  });
  app.post('/operator-workflows/requests/:operationKey/cancel', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const actorDenied = expectedActor(c);
    if (actorDenied) return actorDenied;
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;
    const key = uuid.safeParse(c.req.param('operationKey'));
    const header = uuid.safeParse(c.req.header('Idempotency-Key'));
    const request = workflowRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (
      !key.success ||
      !header.success ||
      !request.success ||
      key.data !== header.data ||
      key.data !== request.data.operationKey ||
      Object.keys(c.req.query()).length
    )
      return refuse(c, { error: 'invalid_record' });
    try {
      const { data, error } = await rpc(c, 'cancel_operator_workflow', {
        p_tenant_id: c.get('tenantId'),
        p_actor_id: c.get('user').id,
        p_operation_key: key.data,
        p_kind: request.data.kind,
        p_payload: request.data.payload,
        p_correlation_id: randomUUID(),
      });
      if (error) return refuse(c, null);
      const result = z
        .discriminatedUnion('cancelled', [
          z.object({ cancelled: z.literal(true), data: z.null() }).strict(),
          z.object({ cancelled: z.literal(false), data: workflowRecordSchema }).strict(),
        ])
        .safeParse(data);
      if (!result.success) return refuse(c, data);
      if (!result.data.cancelled) {
        const row = result.data.data;
        if (
          !validRecord(row, c.get('tenantId')) ||
          row.created_by !== c.get('user').id.toLowerCase() ||
          row.operation_key !== key.data ||
          row.kind !== request.data.kind ||
          !sameValue(row.payload, request.data.payload)
        )
          return refuse(c, null);
      }
      return c.json(result.data);
    } catch {
      return refuse(c, null);
    }
  });
  return app;
}
