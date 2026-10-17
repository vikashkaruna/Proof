import { z } from 'zod';
import {
  encodeLocalCustodyEvent,
  encodeLocalCustodyCancellation,
  localCustodyCancellationSchema,
  localCustodyCancellationReceiptSchema,
  type LocalCustodyCancellation,
  localCustodyContextSchema,
  localCustodyEventReceiptSchema,
  parseLocalCustodyPolicyText,
  type LocalCustodyEventRequest,
} from '@axiom/types';
const uuid = z.uuid();
export function custodyScope(tenantId: string, actorId: string) {
  return {
    tenantId: uuid.parse(tenantId).toLowerCase(),
    actorId: uuid.parse(actorId).toLowerCase(),
  };
}
async function request(
  scope: { tenantId: string; actorId: string },
  path: string,
  body?: unknown,
  key?: string,
) {
  custodyScope(scope.tenantId, scope.actorId);
  const response = await fetch('/api/bff/v1/local-custody-policy/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    cache: 'no-store',
    signal: AbortSignal.timeout(30000),
    headers: {
      'x-tenant-id': scope.tenantId,
      'x-expected-actor-id': scope.actorId,
      ...(body === undefined
        ? {}
        : { 'content-type': 'application/json', 'idempotency-key': uuid.parse(key) }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok)
    throw new Error(
      'Current custody outcome could not be confirmed. Keep the retained request and check it again.',
    );
  if (!response.body) throw new Error('Custody response unavailable.');
  const reader = response.body.getReader();
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.length;
      if (total > 2097152) throw new Error('Custody response exceeds its bound.');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return z
    .object({ data: z.unknown() })
    .strict()
    .parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))).data;
}
export async function loadCustodyContext(
  scope: { tenantId: string; actorId: string },
  query: { policyId?: string; after?: string; beforeReceiptId?: string } = {},
) {
  const search = new URLSearchParams(query);
  const result = localCustodyContextSchema.parse(
    await request(scope, 'context' + (search.size ? '?' + search.toString() : '')),
  );
  if (
    result.tenantId !== scope.tenantId ||
    result.actorId !== scope.actorId ||
    result.selectedPolicyId !== (query.policyId ?? null)
  )
    throw new Error('Custody context changed. Refresh before continuing.');
  for (const row of result.rows) {
    const p = parseLocalCustodyPolicyText(row.policyText);
    if (p.tenantId !== scope.tenantId || p.policyId !== row.policyId)
      throw new Error('Custody policy scope refused.');
  }
  return result;
}
export function checkCustodyReceipt(
  value: unknown,
  scope: { tenantId: string; actorId: string },
  request: LocalCustodyEventRequest,
) {
  const result = localCustodyEventReceiptSchema.parse(value),
    policy = parseLocalCustodyPolicyText(request.policyText);
  if (
    result.tenantId !== scope.tenantId ||
    result.actorId !== scope.actorId ||
    result.operationKey !== request.operationKey ||
    result.requestText !== encodeLocalCustodyEvent(request) ||
    result.policyId !== policy.policyId ||
    result.transition !== request.transition ||
    result.previousEventId !== request.previousEventId ||
    result.policySha256 !== request.policySha256 ||
    result.keyPolicySha256 !== policy.keyPolicySha256 ||
    (request.transition === 'review' && result.reviewDueAt !== request.nextReviewDueAt)
  )
    throw new Error('The receipt does not match the retained custody request.');
  return result;
}
export async function custodyStep(
  scope: { tenantId: string; actorId: string },
  step: 'recover' | 'challenge' | 'verify' | 'record',
  request: LocalCustodyEventRequest,
  challengeId?: string,
  code?: string,
) {
  encodeLocalCustodyEvent(request);
  if (parseLocalCustodyPolicyText(request.policyText).tenantId !== scope.tenantId)
    throw new Error('Custody request belongs to another organisation.');
  const result = await requestTransport(
    scope,
    step,
    {
      request,
      ...(challengeId ? { challengeId: uuid.parse(challengeId) } : {}),
      ...(code ? { code } : {}),
    },
    request.operationKey,
  );
  if (
    step === 'recover' &&
    z
      .object({ state: z.literal('not_found') })
      .strict()
      .safeParse(result).success
  )
    return { state: 'not_found' } as const;
  if (step === 'recover' || step === 'record') return checkCustodyOutcome(result, scope, request);
  if (step === 'challenge')
    return z
      .object({ challengeId: uuid, expiresAt: z.iso.datetime({ offset: true }) })
      .strict()
      .parse(result);
  const verified = z
    .object({ verified: z.literal(true), challengeId: uuid })
    .strict()
    .parse(result);
  if (verified.challengeId !== challengeId) throw new Error('MFA challenge changed.');
  return verified;
}
const requestTransport = request;

export function checkCustodyOutcome(
  value: unknown,
  scope: { tenantId: string; actorId: string },
  original: LocalCustodyEventRequest,
  cancellation?: LocalCustodyCancellation,
) {
  if (typeof value === 'object' && value !== null && 'state' in value && value.state === 'recorded')
    return checkCustodyReceipt(value, scope, original);
  const row = localCustodyCancellationReceiptSchema.parse(value),
    c = localCustodyCancellationSchema.parse(JSON.parse(row.cancellationText));
  const originalText = encodeLocalCustodyEvent(original);
  if (
    row.tenantId !== scope.tenantId ||
    row.actorId !== scope.actorId ||
    row.originalOperationKey !== original.operationKey ||
    row.originalRequestText !== originalText ||
    c.originalRequestText !== originalText ||
    row.operationKey !== c.operationKey ||
    encodeLocalCustodyCancellation(c) !== row.cancellationText ||
    (cancellation && encodeLocalCustodyCancellation(cancellation) !== row.cancellationText)
  )
    throw Error('Cancellation does not match the retained request.');
  return row;
}
export async function custodyResolutionStep(
  scope: { tenantId: string; actorId: string },
  step: 'recover' | 'challenge' | 'verify' | 'record',
  resolution: LocalCustodyCancellation,
  challengeId?: string,
  code?: string,
) {
  encodeLocalCustodyCancellation(resolution);
  const original = JSON.parse(resolution.originalRequestText);
  if (parseLocalCustodyPolicyText(original.policyText).tenantId !== scope.tenantId)
    throw Error('Custody request belongs to another organisation.');
  const body = {
    resolution,
    ...(challengeId ? { challengeId: uuid.parse(challengeId) } : {}),
    ...(code ? { code } : {}),
  };
  if (new TextEncoder().encode(JSON.stringify(body)).length > 65536)
    throw Error('Cancellation envelope exceeds its bound.');
  const value = await requestTransport(scope, step, body, resolution.operationKey);
  if (
    step === 'recover' &&
    z
      .object({ state: z.literal('not_found') })
      .strict()
      .safeParse(value).success
  )
    return { state: 'not_found' } as const;
  if (step === 'recover' || step === 'record')
    return checkCustodyOutcome(value, scope, original, resolution);
  if (step === 'challenge')
    return z
      .object({ challengeId: uuid, expiresAt: z.iso.datetime({ offset: true }) })
      .strict()
      .parse(value);
  const verified = z
    .object({ verified: z.literal(true), challengeId: uuid })
    .strict()
    .parse(value);
  if (verified.challengeId !== challengeId) throw Error('MFA challenge changed.');
  return verified;
}

/** The operator-prepared manifest for THIS tenant, or null when none is staged.
 * Guidance only: the owner still reviews it, and every recording re-verifies it. */
export async function loadStagedManifest(scope: { tenantId: string; actorId: string }) {
  custodyScope(scope.tenantId, scope.actorId);
  const response = await fetch('/api/bff/v1/local-custody-policy/staged-manifest', {
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
    headers: { 'x-tenant-id': scope.tenantId, 'x-expected-actor-id': scope.actorId },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('The operator-prepared manifest could not be loaded.');
  return z
    .object({
      data: z.object({ policyText: z.string(), policySha256: z.string() }).strict(),
    })
    .strict()
    .parse(await response.json()).data;
}
