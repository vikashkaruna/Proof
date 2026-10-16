import { parseCatalogueJson } from '@axiom/control-library';
import { canonicalJson } from '@axiom/ledger';
import { generateUUID } from '@axiom/ui';
import { z } from 'zod';
import {
  parsePublicWebsiteAssetRequestText,
  parsePublicWebsiteAssetSnapshotText,
  publicWebsiteAssetCancellationSnapshotSchema,
  publicWebsiteAssetResolutionSchema,
  publicWebsiteAssetSelectionSchema,
  publicWebsiteAssetSelectionPageSchema,
  type PublicWebsiteAssetResolution,
} from '@axiom/types';
import {
  assertWebsiteAssetIntent,
  websiteAssetIntentSchema,
  type WebsiteAssetIntent,
  type WebsiteAssetCancellationIntent,
  readWebsiteAssetIntents,
} from './public-website-asset-journal';
const envelope = z.object({ data: publicWebsiteAssetResolutionSchema }).strict();
async function responseValue(response: Response, maxBytes = 131072): Promise<unknown> {
  if (!response.ok)
    throw Error(
      'Website operation could not be confirmed. Preserve the retained request and reconcile it.',
    );
  if (!response.body) throw Error('Website operation response is missing.');
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw Error('Website response exceeds supported bounds.');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return parseCatalogueJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), maxBytes);
}
/** BFF/SQL verify actual SHA and ledger custody; browser checks exact saved scope,
 * canonical text and linked fields. This is not independent ledger verification. */
export function validateWebsiteAssetResolution(
  raw: unknown,
  intent: WebsiteAssetIntent,
  expectedCancellationReason?: string,
): PublicWebsiteAssetResolution {
  const own = websiteAssetIntentSchema.parse(intent),
    request = parsePublicWebsiteAssetRequestText(own.requestText),
    result = envelope.parse(raw).data;
  if (result.state === 'not_found') return result;
  if (
    result.tenantId !== own.tenantId ||
    result.actorId !== own.actorId ||
    result.operationKey !== request.operationKey ||
    result.requestText !== own.requestText
  )
    throw Error('Website receipt does not match its retained actor, tenant and exact request.');
  if (result.state === 'cancelled') {
    const snapshot = publicWebsiteAssetCancellationSnapshotSchema.parse(
      JSON.parse(result.cancellationText),
    );
    if (
      canonicalJson(snapshot) !== result.cancellationText ||
      snapshot.tenantId !== own.tenantId ||
      snapshot.actorId !== own.actorId ||
      snapshot.operationKey !== request.operationKey ||
      snapshot.requestSha256 !== result.requestSha256 ||
      (expectedCancellationReason !== undefined && snapshot.reason !== expectedCancellationReason)
    )
      throw Error('Cancellation receipt does not match the exact retained request and reason.');
    return result;
  }
  const snapshot = parsePublicWebsiteAssetSnapshotText(result.snapshotText);
  if (
    snapshot.tenantId !== own.tenantId ||
    snapshot.actorId !== own.actorId ||
    result.kind !== request.kind
  )
    throw Error('Website snapshot scope differs.');
  if (request.kind === 'register_target') {
    if (
      snapshot.kind !== 'target' ||
      snapshot.estateId !== request.estateId ||
      snapshot.systemId !== request.systemId ||
      snapshot.estateVersion !== request.expectedEstateVersion ||
      snapshot.systemVersion !== request.expectedSystemVersion ||
      snapshot.url !== request.url
    )
      throw Error('Registered target differs from the retained request.');
  } else if (request.kind === 'withdraw') {
    if (
      snapshot.kind !== 'withdrawal' ||
      snapshot.subjectType !== request.subjectType ||
      snapshot.subjectId !== request.subjectId ||
      snapshot.subjectSha256 !== request.expectedSubjectSha256 ||
      snapshot.reason !== request.reason
    )
      throw Error('Withdrawal differs from the retained request.');
  } else if (
    snapshot.kind !== 'association' ||
    snapshot.targetId !== request.targetId ||
    snapshot.targetSha256 !== request.expectedTargetSha256 ||
    (request.kind === 'associate_capture' &&
      (snapshot.checkId !== request.checkId ||
        snapshot.payloadSha256 !== request.expectedPayloadSha256 ||
        snapshot.captureReceipt.id !== request.expectedCaptureReceipt))
  )
    throw Error('Associated evidence differs from the retained request.');
  return result;
}
async function transport(
  intent: WebsiteAssetIntent,
  method: 'GET' | 'POST',
  suffix: string,
  body?: string,
  signal?: AbortSignal,
  reason?: string,
) {
  signal?.throwIfAborted();
  const own = websiteAssetIntentSchema.parse(intent);
  const operation = parsePublicWebsiteAssetRequestText(own.requestText);
  const headers: Record<string, string> = { 'X-Tenant-Id': own.tenantId };
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json';
    headers['X-Expected-Actor-Id'] = own.actorId;
    headers['Idempotency-Key'] = operation.operationKey;
    headers['X-Request-Id'] = generateUUID();
  }
  const response = await fetch('/api/bff/v1/public-website-assets/operations' + suffix, {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
    cache: 'no-store',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000),
  });
  return validateWebsiteAssetResolution(await responseValue(response), own, reason);
}
export async function sendWebsiteAssetIntent(
  storage: Storage,
  intent: WebsiteAssetIntent,
  signal?: AbortSignal,
) {
  assertWebsiteAssetIntent(storage, intent);
  if (
    readWebsiteAssetIntents(storage, intent.tenantId, intent.actorId).find(
      (v) => v.intent.requestText === intent.requestText && v.intent.tenantId === intent.tenantId,
    )?.cancellation
  )
    throw Error('Reconcile the retained cancellation before retrying the original operation.');
  const result = await transport(intent, 'POST', '', intent.requestText, signal);
  if (result.state === 'not_found')
    throw Error('Write outcome is still unknown. Preserve and reconcile the retained request.');
  return result;
}
export function readWebsiteAssetIntent(intent: WebsiteAssetIntent, signal?: AbortSignal) {
  const request = parsePublicWebsiteAssetRequestText(intent.requestText);
  return transport(intent, 'GET', '/' + request.operationKey, undefined, signal);
}
export async function cancelWebsiteAssetIntent(
  storage: Storage,
  intent: WebsiteAssetIntent,
  cancellation: WebsiteAssetCancellationIntent,
  signal?: AbortSignal,
) {
  assertWebsiteAssetIntent(storage, intent);
  const retained = readWebsiteAssetIntents(storage, intent.tenantId, intent.actorId).find(
    (v) => v.intent.requestText === intent.requestText && v.intent.tenantId === intent.tenantId,
  )?.cancellation;
  if (!retained || canonicalJson(retained) !== canonicalJson(cancellation))
    throw Error('Retained cancellation differs. Nothing was sent.');
  const request = parsePublicWebsiteAssetRequestText(intent.requestText);
  const body = canonicalJson({
    requestText: intent.requestText,
    reason: cancellation.reason,
    confirmed: true,
  });
  const result = await transport(
    intent,
    'POST',
    '/' + request.operationKey + '/cancel',
    body,
    signal,
    cancellation.reason,
  );
  if (result.state === 'not_found')
    throw Error('Cancellation outcome is still unknown. Preserve and reconcile it.');
  return result;
}

/** Explicit, bounded GET. Scope comes from the rendered tenant, never the mutable cookie. */
export async function readWebsiteAssetSelection(
  tenantId: string,
  actorId: string,
  input: import('@axiom/types').PublicWebsiteAssetSelection,
  signal?: AbortSignal,
) {
  const selection = publicWebsiteAssetSelectionSchema.parse(input);
  const scope = z.object({ tenantId: z.uuid(), actorId: z.uuid() }).parse({ tenantId, actorId });
  signal?.throwIfAborted();
  const query = new URLSearchParams(
    Object.entries(selection).filter((e): e is [string, string] => typeof e[1] === 'string'),
  );
  const response = await fetch('/api/bff/v1/public-website-assets/selection?' + query, {
    method: 'GET',
    headers: { 'X-Tenant-Id': scope.tenantId },
    cache: 'no-store',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000),
  });
  const envelope = z
    .object({ data: publicWebsiteAssetSelectionPageSchema })
    .strict()
    .parse(await responseValue(response, 4 * 1024 * 1024));
  const page = envelope.data;
  if (
    page.tenantId !== tenantId.toLowerCase() ||
    page.actorId !== actorId.toLowerCase() ||
    page.kind !== selection.kind
  )
    throw Error('Website selection context changed.');
  if (page.kind === 'targets' && selection.kind === 'targets') {
    if (page.estateId !== selection.estateId || page.systemId !== selection.systemId)
      throw Error('Website selection context changed.');
    for (const row of page.rows) {
      const s = parsePublicWebsiteAssetSnapshotText(row.snapshotText);
      if (
        s.kind !== 'target' ||
        s.id !== row.id ||
        s.tenantId !== page.tenantId ||
        s.estateId !== page.estateId ||
        s.systemId !== page.systemId
      )
        throw Error('Website selection context changed.');
    }
  } else if (page.kind === 'associations' && selection.kind === 'associations') {
    if (page.targetId !== selection.targetId) throw Error('Website selection context changed.');
    for (const row of page.rows) {
      const op = validateWebsiteAssetResolution(
        { data: row.operation },
        {
          version: 1,
          tenantId: page.tenantId,
          actorId: row.operation.actorId,
          requestText: row.operation.requestText,
        },
      );
      const s = parsePublicWebsiteAssetSnapshotText(row.snapshotText);
      if (
        op.state !== 'recorded' ||
        s.kind !== 'association' ||
        s.id !== row.id ||
        s.targetId !== page.targetId ||
        op.snapshotText !== row.snapshotText ||
        op.snapshotSha256 !== row.snapshotSha256
      )
        throw Error('Website selection context changed.');
    }
  } else if (page.kind === 'captures' && selection.kind === 'captures') {
    if (page.targetId !== selection.targetId || page.rows.some((r) => r.tenantId !== page.tenantId))
      throw Error('Website selection context changed.');
  } else throw Error('Website selection context changed.');
  const ids = page.rows.map((r) => ('id' in r ? r.id : r.checkId));
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id, i) => id <= (selection.after ?? '') || (i > 0 && id <= ids[i - 1]!)) ||
    (page.nextCursor !== null && (ids.length !== 50 || page.nextCursor !== ids.at(-1)))
  )
    throw Error('Website selection page could not be verified.');
  return page;
}
