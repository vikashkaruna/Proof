import { z } from 'zod';

// Browser consistency only. Current Auth/MFA/role, source authority and exact
// lifecycle are always rechecked by the protected BFF/SQL paths. No raw HTML,
// private PG witness, writer credentials, message delivery or DB access exists.
const id = z.uuid().refine((v) => v.length === 36 && v === v.toLowerCase());
const digest = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/);
const receipt = z
  .string()
  .refine(
    (v) =>
      /^[1-9][0-9]{0,18}$/.test(v) &&
      BigInt(v).toString() === v &&
      BigInt(v) <= 9223372036854775807n,
  );
const url = z
  .string()
  .max(2048)
  .regex(/^https:\/\/([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(\/[^?#\s]*)?$/)
  .refine((v) => !/\s/.test(v));
export const retainedSanketPublicSourceSchema = z.strictObject({
  check_id: id,
  capture_actor_id: id,
  capture_correlation_id: id,
  capture_receipt: receipt,
  result_sha256: digest,
  requested_url: url,
  final_url: url,
  checked_at: z.iso.datetime({ offset: true }).max(64),
  content_sha256: digest,
  byte_size: z.number().int().min(1).max(524288),
  title: z.string().max(300),
  headings: z.array(z.string().max(300)).max(12),
});
const requestSchema = z.strictObject({
  engagementId: id,
  checkId: id,
  sourceDigest: digest,
  operationKey: id,
  confirmSourceReview: z.literal(true),
});
export const retainedSanketReferenceSchema = z
  .strictObject({
    version: z.literal(1),
    tenantId: id,
    actorId: id,
    source: retainedSanketPublicSourceSchema,
    sourceDigest: digest,
    request: requestSchema,
  })
  .superRefine((value, ctx) => {
    if (
      value.source.check_id !== value.request.checkId ||
      value.sourceDigest !== value.request.sourceDigest
    )
      ctx.addIssue({ code: 'custom', message: 'Retained source binding changed' });
  });
export type RetainedSanketReference = z.infer<typeof retainedSanketReferenceSchema>;
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export interface RetainedSanketBrowserPorts {
  storage: StoragePort;
  currentIdentity: () => { tenantId: string; actorId: string };
  fetch?: typeof fetch;
  exclusive?: <T>(key: string, action: () => Promise<T>) => Promise<T>;
}
export class RetainedSanketReferenceError extends Error {
  constructor(
    readonly code:
      'reference_changed' | 'reference_unavailable' | 'proof_refused' | 'outcome_unconfirmed',
  ) {
    super(code);
  }
}
export const SANKET_REFERENCE_CHANGED = 'axiom-retained-sanket-reference-changed';
const prefix = '/api/bff/v1/retained-public-observations';
const maxReferenceBytes = 32768,
  maxResponseBytes = 65536;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const fields = value as Record<string, unknown>;
    return `{${Object.keys(fields)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(fields[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
async function hash(value: unknown) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, '0')).join('');
}
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new RetainedSanketReferenceError('proof_refused');
  return result.data;
}
export function retainedSanketReferenceKey(tenantId: string, actorId: string) {
  parse(id, tenantId);
  parse(id, actorId);
  return `axiom:retained-sanket:v1:${tenantId}:${actorId}`;
}
function notify() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SANKET_REFERENCE_CHANGED));
}
export function readRetainedSanketReference(
  storage: Pick<StoragePort, 'getItem'>,
  tenantId: string,
  actorId: string,
) {
  try {
    const raw = storage.getItem(retainedSanketReferenceKey(tenantId, actorId));
    if (raw === null) return null;
    if (new TextEncoder().encode(raw).byteLength > maxReferenceBytes) throw new Error();
    const decoded: unknown = JSON.parse(raw),
      value = parse(retainedSanketReferenceSchema, decoded);
    if (
      value.tenantId !== tenantId ||
      value.actorId !== actorId ||
      canonical(decoded) !== canonical(value)
    )
      throw new Error();
    return value;
  } catch {
    throw new RetainedSanketReferenceError('reference_unavailable');
  }
}
function identity(value: RetainedSanketReference, ports: RetainedSanketBrowserPorts) {
  const current = ports.currentIdentity();
  if (current.tenantId !== value.tenantId || current.actorId !== value.actorId)
    throw new RetainedSanketReferenceError('reference_changed');
}
async function checkedReference(raw: RetainedSanketReference) {
  const value = parse(retainedSanketReferenceSchema, raw);
  if ((await hash(value.source)) !== value.sourceDigest)
    throw new RetainedSanketReferenceError('proof_refused');
  return value;
}
async function exclusive<T>(
  value: RetainedSanketReference,
  ports: RetainedSanketBrowserPorts,
  action: () => Promise<T>,
) {
  const key = retainedSanketReferenceKey(value.tenantId, value.actorId);
  if (ports.exclusive) return ports.exclusive(key, action);
  if (typeof navigator === 'undefined' || !navigator.locks)
    throw new RetainedSanketReferenceError('reference_unavailable');
  return navigator.locks.request(key, { mode: 'exclusive' }, action);
}
function retain(value: RetainedSanketReference, ports: RetainedSanketBrowserPorts) {
  identity(value, ports);
  const old = readRetainedSanketReference(ports.storage, value.tenantId, value.actorId);
  if (old && canonical(old) !== canonical(value))
    throw new RetainedSanketReferenceError('reference_changed');
  const raw = JSON.stringify(value),
    key = retainedSanketReferenceKey(value.tenantId, value.actorId);
  if (new TextEncoder().encode(raw).byteLength > maxReferenceBytes)
    throw new RetainedSanketReferenceError('reference_unavailable');
  try {
    ports.storage.setItem(key, raw);
    if (ports.storage.getItem(key) !== raw) throw new Error();
  } catch {
    throw new RetainedSanketReferenceError('reference_unavailable');
  }
  notify();
}
function headers(value: RetainedSanketReference, post = false) {
  return {
    'X-Tenant-Id': value.tenantId,
    'X-Expected-Actor-Id': value.actorId,
    ...(post
      ? { 'Content-Type': 'application/json', 'Idempotency-Key': value.request.operationKey }
      : {}),
  };
}
/** Explicit source preview. The digest is consistency, never source authority. */
export async function readRetainedSanketPublicSource(
  tenantId: string,
  actorId: string,
  engagementId: string,
  checkId: string,
  ports: RetainedSanketBrowserPorts,
) {
  [tenantId, actorId, engagementId, checkId].forEach((value) => parse(id, value));
  const current = ports.currentIdentity();
  if (current.tenantId !== tenantId || current.actorId !== actorId)
    throw new RetainedSanketReferenceError('reference_changed');
  try {
    const response = await (ports.fetch ?? fetch)(
      `${prefix}/source?${new URLSearchParams({ engagementId, checkId })}`,
      {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: AbortSignal.timeout(20000),
        headers: { 'X-Tenant-Id': tenantId, 'X-Expected-Actor-Id': actorId },
      },
    );
    const result = parse(
      z.strictObject({ source: retainedSanketPublicSourceSchema, sourceDigest: digest }),
      await responseBody(response),
    );
    const after = ports.currentIdentity();
    if (after.tenantId !== tenantId || after.actorId !== actorId)
      throw new RetainedSanketReferenceError('reference_changed');
    if (result.source.check_id !== checkId || result.sourceDigest !== (await hash(result.source)))
      throw new RetainedSanketReferenceError('proof_refused');
    return result;
  } catch (error) {
    if (error instanceof RetainedSanketReferenceError) throw error;
    throw new RetainedSanketReferenceError('outcome_unconfirmed');
  }
}
async function responseBody(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new RetainedSanketReferenceError('outcome_unconfirmed');
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) {
        void reader.cancel().catch(() => {});
        throw new Error();
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new RetainedSanketReferenceError('outcome_unconfirmed');
  } finally {
    reader.releaseLock();
  }
}
const kinds = ['public_rfp_heading', 'public_dpo_heading', 'public_hiring_heading'] as const;
const signal = z.strictObject({
  source: id,
  company: z.string().max(253),
  signal: z.enum(kinds),
  detected_at: z.string().max(64),
  score: z.literal(0),
  context: z.string().max(2000),
  url,
});
const resultSchema = z.strictObject({
  data: z.strictObject({
    signals: z.array(signal).max(3),
    high_intent: z.array(signal).max(0),
    source_observations: z.tuple([
      z.strictObject({
        requested_url: url,
        final_url: url,
        checked_at: z.string().max(64),
        content_sha256: digest,
        projection_sha256: digest,
        capture_reference: id,
        observed_notice_kinds: z.array(z.enum(kinds)).max(3),
        requires_human_review: z.literal(true),
      }),
    ]),
    processing_mode: z.literal('verified_public_capture_review'),
    notes: z.string().max(2000),
  }),
  invocation: z.strictObject({
    runId: id,
    correlationId: id,
    requestHash: digest,
    responseHash: digest,
  }),
  outputProof: z.strictObject({
    kind: z.literal('settled_output_recorded'),
    tenantId: id,
    actorId: id,
    operationKey: id,
    runId: id,
    requestHash: digest,
    responseHash: digest,
    requestedReceipt: receipt,
    startedReceipt: receipt,
    completedReceipt: receipt,
    settledReceipt: receipt,
  }),
});
export type ConfirmedRetainedSanket = z.infer<typeof resultSchema>;
const validated = new WeakMap<object, string>();
function input(value: RetainedSanketReference) {
  return {
    schema_version: 1,
    tenant_id: value.tenantId,
    engagement_id: value.request.engagementId,
    correlation_id: value.request.operationKey,
    sectors: ['BFSI', 'Healthcare', 'SaaS / Tech'],
    geo: 'India',
    since: null,
    source: value.source,
  };
}
async function confirmed(raw: unknown, value: RetainedSanketReference) {
  const result = parse(resultSchema, raw),
    p = result.outputProof,
    invocation = result.invocation,
    observation = result.data.source_observations[0],
    source = value.source;
  const expectedProjection = {
    requested_url: source.requested_url,
    final_url: source.final_url,
    checked_at: source.checked_at,
    content_sha256: source.content_sha256,
    byte_size: source.byte_size,
    title: source.title,
    headings: source.headings,
    capture_reference: source.check_id,
  };
  if (
    p.tenantId !== value.tenantId ||
    p.actorId !== value.actorId ||
    p.operationKey !== value.request.operationKey ||
    invocation.correlationId !== value.request.operationKey ||
    p.runId !== invocation.runId ||
    p.requestHash !== invocation.requestHash ||
    p.responseHash !== invocation.responseHash ||
    p.requestHash !== (await hash(input(value))) ||
    p.responseHash !== (await hash(result.data)) ||
    observation.requested_url !== source.requested_url ||
    observation.final_url !== source.final_url ||
    observation.checked_at !== source.checked_at ||
    observation.content_sha256 !== source.content_sha256 ||
    observation.capture_reference !== source.check_id ||
    observation.projection_sha256 !== (await hash(expectedProjection)) ||
    new Set(observation.observed_notice_kinds).size !== observation.observed_notice_kinds.length ||
    observation.observed_notice_kinds.some(
      (kind, index) => kind !== result.data.signals[index]?.signal,
    ) ||
    result.data.signals.length !== observation.observed_notice_kinds.length ||
    result.data.signals.some(
      (item) =>
        item.source !== source.check_id ||
        item.url !== source.final_url ||
        item.detected_at !== source.checked_at ||
        item.company !== new URL(source.final_url).hostname,
    ) ||
    !(
      BigInt(source.capture_receipt) < BigInt(p.requestedReceipt) &&
      BigInt(p.requestedReceipt) < BigInt(p.startedReceipt) &&
      BigInt(p.startedReceipt) < BigInt(p.completedReceipt) &&
      BigInt(p.completedReceipt) < BigInt(p.settledReceipt)
    )
  )
    throw new RetainedSanketReferenceError('proof_refused');
  validated.set(result, canonical({ reference: value, result }));
  return result;
}
async function getSaved(value: RetainedSanketReference, ports: RetainedSanketBrowserPorts) {
  identity(value, ports);
  const query = new URLSearchParams({
    engagementId: value.request.engagementId,
    checkId: value.request.checkId,
    sourceDigest: value.sourceDigest,
  });
  try {
    const response = await (ports.fetch ?? fetch)(
      `${prefix}/runs/${value.request.operationKey}?${query}`,
      {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: AbortSignal.timeout(20000),
        headers: headers(value),
      },
    );
    const result = await confirmed(await responseBody(response), value);
    identity(value, ports);
    return result;
  } catch (error) {
    if (error instanceof RetainedSanketReferenceError) throw error;
    throw new RetainedSanketReferenceError('outcome_unconfirmed');
  }
}
/** Explicit human submit only. Exact persisted journal readback precedes POST. */
export async function submitRetainedSanketReference(
  raw: RetainedSanketReference,
  ports: RetainedSanketBrowserPorts,
) {
  const value = await checkedReference(raw);
  return exclusive(value, ports, async () => {
    retain(value, ports);
    identity(value, ports);
    try {
      const response = await (ports.fetch ?? fetch)(`${prefix}/runs`, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        signal: AbortSignal.timeout(130000),
        headers: headers(value, true),
        body: JSON.stringify(value.request),
      });
      const result = await confirmed(await responseBody(response), value);
      identity(value, ports);
      return result;
    } catch (error) {
      if (error instanceof RetainedSanketReferenceError) throw error;
      throw new RetainedSanketReferenceError('outcome_unconfirmed');
    }
  });
}
/** Explicit recovery GET; never auto-dispatch or create a replacement key. */
export async function recoverRetainedSanketReference(
  raw: RetainedSanketReference,
  ports: RetainedSanketBrowserPorts,
) {
  return getSaved(await checkedReference(raw), ports);
}
/** Explicit archive only; fresh server proof under the lock, then exact removal. */
export async function archiveRetainedSanketReference(
  raw: RetainedSanketReference,
  displayed: ConfirmedRetainedSanket,
  ports: RetainedSanketBrowserPorts,
) {
  const value = await checkedReference(raw);
  return exclusive(value, ports, async () => {
    identity(value, ports);
    if (
      validated.get(displayed) !== canonical({ reference: value, result: displayed }) ||
      canonical(readRetainedSanketReference(ports.storage, value.tenantId, value.actorId)) !==
        canonical(value)
    )
      throw new RetainedSanketReferenceError('reference_changed');
    const fresh = await getSaved(value, ports);
    identity(value, ports);
    if (
      canonical(fresh) !== canonical(displayed) ||
      canonical(readRetainedSanketReference(ports.storage, value.tenantId, value.actorId)) !==
        canonical(value)
    )
      throw new RetainedSanketReferenceError('reference_changed');
    const key = retainedSanketReferenceKey(value.tenantId, value.actorId);
    try {
      ports.storage.removeItem(key);
      if (ports.storage.getItem(key) !== null) throw new Error();
    } catch {
      throw new RetainedSanketReferenceError('reference_unavailable');
    }
    notify();
  });
}
