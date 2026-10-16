import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { canonicalJson } from '@axiom/ledger';
import {
  encodePublicWebsiteAssetRequest,
  PUBLIC_WEBSITE_ASSET_REQUEST_CODEC,
  PUBLIC_WEBSITE_ASSET_SNAPSHOT_CODEC,
  PUBLIC_WEBSITE_ASSET_CANCELLATION_CODEC,
} from '@axiom/types';
import {
  retainWebsiteAssetIntent,
  retainWebsiteAssetCancellation,
  readWebsiteAssetIntents,
  type WebsiteAssetIntent,
} from './public-website-asset-journal';
import {
  sendWebsiteAssetIntent,
  readWebsiteAssetIntent,
  cancelWebsiteAssetIntent,
  validateWebsiteAssetResolution,
  readWebsiteAssetSelection,
} from './public-website-asset-client';
const tenant = '11111111-1111-4111-8111-111111111111',
  actor = '22222222-2222-4222-8222-222222222222',
  key = '33333333-3333-4333-8333-333333333333',
  id = '44444444-4444-4444-8444-444444444444';
class Memory implements Storage {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const intent: WebsiteAssetIntent = {
  version: 1,
  tenantId: tenant,
  actorId: actor,
  requestText: encodePublicWebsiteAssetRequest({
    version: 1,
    kind: 'register_target',
    operationKey: key,
    confirmed: true,
    estateId: id,
    systemId: key,
    expectedEstateVersion: 1,
    expectedSystemVersion: 1,
    url: 'https://public.org/',
  }),
};
function positive() {
  const snapshotText = canonicalJson({
    version: 1,
    kind: 'target',
    id,
    tenantId: tenant,
    actorId: actor,
    ownershipVerified: false,
    connectorAccessGranted: false,
    estateId: id,
    systemId: key,
    estateVersion: 1,
    systemVersion: 1,
    targetVersion: 1,
    estateName: 'Estate',
    systemName: 'Site',
    url: 'https://public.org/',
  });
  return {
    state: 'recorded' as const,
    tenantId: tenant,
    actorId: actor,
    operationKey: key,
    kind: 'register_target' as const,
    requestCodec: PUBLIC_WEBSITE_ASSET_REQUEST_CODEC,
    requestText: intent.requestText,
    requestSha256: sha(intent.requestText),
    snapshotCodec: PUBLIC_WEBSITE_ASSET_SNAPSHOT_CODEC,
    snapshotText,
    snapshotSha256: sha(snapshotText),
    receipt: { id: '10', entryHash: 'a'.repeat(64) },
    replayed: false,
  };
}
function cancelled(reason = 'Abandon this exact request') {
  const cancellationText = canonicalJson({
    version: 1,
    id,
    tenantId: tenant,
    actorId: actor,
    operationKey: key,
    requestSha256: sha(intent.requestText),
    reason,
    confirmed: true,
  });
  return {
    state: 'cancelled' as const,
    tenantId: tenant,
    actorId: actor,
    operationKey: key,
    requestCodec: PUBLIC_WEBSITE_ASSET_REQUEST_CODEC,
    requestText: intent.requestText,
    requestSha256: sha(intent.requestText),
    cancellationCodec: PUBLIC_WEBSITE_ASSET_CANCELLATION_CODEC,
    cancellationText,
    cancellationSha256: sha(cancellationText),
    receipt: { id: '11', entryHash: 'b'.repeat(64) },
    replayed: false,
  };
}
const fetcher = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('crypto', webcrypto);
  fetcher.mockReset();
  fetcher.mockResolvedValue(new Response(JSON.stringify({ data: positive() })));
});
afterEach(() => vi.unstubAllGlobals());
it('keeps body/key/actor/tenant exact after lost response and subsequent retry', async () => {
  const storage = new Memory();
  retainWebsiteAssetIntent(storage, intent);
  fetcher.mockRejectedValueOnce(Error('connection lost'));
  await expect(sendWebsiteAssetIntent(storage, intent)).rejects.toThrow();
  expect(readWebsiteAssetIntents(storage, tenant, actor)[0]?.intent).toEqual(intent);
  fetcher.mockResolvedValueOnce(
    new Response(JSON.stringify({ data: { ...positive(), replayed: true } })),
  );
  await expect(sendWebsiteAssetIntent(storage, intent)).resolves.toMatchObject({
    state: 'recorded',
  });
  const a = fetcher.mock.calls[0]?.[1],
    b = fetcher.mock.calls[1]?.[1];
  expect(a.body).toBe(intent.requestText);
  expect(b.body).toBe(intent.requestText);
  expect(a.headers).toMatchObject({
    'X-Tenant-Id': tenant,
    'X-Expected-Actor-Id': actor,
    'Idempotency-Key': key,
  });
  expect(b.headers['Idempotency-Key']).toBe(key);
  expect(a.headers['X-Request-Id']).not.toBe(b.headers['X-Request-Id']);
  expect(storage.length).toBe(1);
});
it('readback not_found is explicit and never clears the journal', async () => {
  const storage = new Memory();
  retainWebsiteAssetIntent(storage, intent);
  fetcher.mockResolvedValueOnce(new Response('{"data":{"state":"not_found"}}'));
  expect(await readWebsiteAssetIntent(intent)).toEqual({ state: 'not_found' });
  expect(storage.length).toBe(1);
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    method: 'GET',
    headers: { 'X-Tenant-Id': tenant },
  });
});
it.each(['tenantId', 'actorId', 'operationKey'] as const)(
  'refuses a positive receipt for another %s',
  (field) => {
    expect(() =>
      validateWebsiteAssetResolution(
        { data: { ...positive(), [field]: field === 'operationKey' ? id : key } },
        intent,
      ),
    ).toThrow();
  },
);
it('refuses coherent snapshot scope/version changes and wrong exact body', () => {
  const row = positive();
  const snapshotText = row.snapshotText.replace('"systemVersion":1', '"systemVersion":2');
  expect(() =>
    validateWebsiteAssetResolution(
      { data: { ...row, snapshotText, snapshotSha256: sha(snapshotText) } },
      intent,
    ),
  ).toThrow();
  expect(() =>
    validateWebsiteAssetResolution(
      { data: { ...row, requestText: row.requestText.replace('public.org', 'other.org') } },
      intent,
    ),
  ).toThrow();
});
it.each(['malformed', 'duplicate', 'invalid_utf8', 'oversize', 'failure'])(
  'preserves unknown on %s HTTP response',
  async (mode) => {
    const storage = new Memory();
    retainWebsiteAssetIntent(storage, intent);
    const body =
      mode === 'duplicate'
        ? JSON.stringify({ data: positive() }).replace('"data":', '"data":null,"d\\u0061ta":')
        : mode === 'oversize'
          ? 'x'.repeat(131073)
          : 'not-json';
    fetcher.mockResolvedValueOnce(
      mode === 'invalid_utf8'
        ? new Response(new Uint8Array([0xc3, 0x28]))
        : new Response(body, { status: mode === 'failure' ? 503 : 200 }),
    );
    await expect(sendWebsiteAssetIntent(storage, intent)).rejects.toThrow();
    expect(readWebsiteAssetIntents(storage, tenant, actor)[0]?.intent).toEqual(intent);
  },
);
it('freezes cancellation reason, blocks original retry and accepts recorded-positive-wins', async () => {
  const storage = new Memory();
  retainWebsiteAssetIntent(storage, intent);
  const cancellation = retainWebsiteAssetCancellation(
    storage,
    intent,
    'Abandon this exact request',
  );
  await expect(sendWebsiteAssetIntent(storage, intent)).rejects.toThrow('cancellation');
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ data: cancelled() })));
  await expect(cancelWebsiteAssetIntent(storage, intent, cancellation)).resolves.toMatchObject({
    state: 'cancelled',
  });
  expect(JSON.parse(fetcher.mock.calls[0]?.[1].body)).toEqual({
    requestText: intent.requestText,
    reason: cancellation.reason,
    confirmed: true,
  });
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ data: positive() })));
  await expect(cancelWebsiteAssetIntent(storage, intent, cancellation)).resolves.toMatchObject({
    state: 'recorded',
  });
  expect(storage.length).toBe(2);
});
it('refuses self-consistent cancellation for a different reason, while GET may recover its retained original reason', async () => {
  const storage = new Memory();
  retainWebsiteAssetIntent(storage, intent);
  const cancellation = retainWebsiteAssetCancellation(storage, intent, 'Original reason');
  fetcher.mockResolvedValueOnce(
    new Response(JSON.stringify({ data: cancelled('Different reason') })),
  );
  await expect(cancelWebsiteAssetIntent(storage, intent, cancellation)).rejects.toThrow('reason');
  expect(storage.length).toBe(2);
  fetcher.mockResolvedValueOnce(
    new Response(JSON.stringify({ data: cancelled('Different reason') })),
  );
  await expect(readWebsiteAssetIntent(intent)).resolves.toMatchObject({ state: 'cancelled' });
});
it('requires retained exact cancellation before sending', async () => {
  const storage = new Memory();
  retainWebsiteAssetIntent(storage, intent);
  await expect(
    cancelWebsiteAssetIntent(storage, intent, { ...intent, reason: 'Unretained', confirmed: true }),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it('uses secure RNG fallback when randomUUID is missing, and sends nothing without secure RNG', async () => {
  const storage = new Memory();
  retainWebsiteAssetIntent(storage, intent);
  vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
  await expect(sendWebsiteAssetIntent(storage, intent)).resolves.toMatchObject({
    state: 'recorded',
  });
  fetcher.mockClear();
  vi.stubGlobal('crypto', undefined);
  await expect(sendWebsiteAssetIntent(storage, intent)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  expect(storage.length).toBe(1);
});
it('does not send an already-aborted request', async () => {
  const storage = new Memory();
  retainWebsiteAssetIntent(storage, intent);
  await expect(sendWebsiteAssetIntent(storage, intent, AbortSignal.abort())).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

it('selection GET binds rendered tenant, explicit parent and pagination without mutation or RNG', async () => {
  const page = {
    kind: 'targets',
    tenantId: tenant,
    actorId: actor,
    estateId: id,
    systemId: key,
    rows: [],
    nextCursor: null,
  };
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: page })));
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('crypto', {});
  const query = { kind: 'targets' as const, estateId: id, systemId: key, after: null };
  expect(await readWebsiteAssetSelection(tenant, actor, query)).toEqual(page);
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    method: 'GET',
    headers: { 'X-Tenant-Id': tenant },
    cache: 'no-store',
  });
  expect(String(fetcher.mock.calls[0]?.[0])).toContain('estateId=' + id);
  for (const change of [
    { tenantId: id },
    { actorId: id },
    { systemId: id },
    { nextCursor: id },
    {
      rows: [
        {
          id,
          snapshotText: positive().snapshotText,
          snapshotSha256: positive().snapshotSha256,
          withdrawn: false,
          inventoryCurrent: true,
        },
        {
          id,
          snapshotText: positive().snapshotText,
          snapshotSha256: positive().snapshotSha256,
          withdrawn: false,
          inventoryCurrent: true,
        },
      ],
    },
  ]) {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ data: { ...page, ...change } })));
    await expect(readWebsiteAssetSelection(tenant, actor, query)).rejects.toThrow();
  }
  fetcher.mockClear();
  await expect(readWebsiteAssetSelection('invalid', actor, query)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it('association selectors retain actual creation receipts and reject mismatched rows or target contexts', async () => {
  const requestText = encodePublicWebsiteAssetRequest({
    version: 1,
    kind: 'capture',
    confirmed: true,
    operationKey: key,
    targetId: id,
    expectedTargetSha256: positive().snapshotSha256,
  });
  const snapshotText = canonicalJson({
    version: 1,
    kind: 'association',
    id: key,
    tenantId: tenant,
    actorId: actor,
    ownershipVerified: false,
    connectorAccessGranted: false,
    targetId: id,
    targetSha256: positive().snapshotSha256,
    checkId: id,
    payloadSha256: 'c'.repeat(64),
    captureReceipt: { id: '9', entryHash: 'd'.repeat(64) },
    requestedUrl: 'https://public.org/',
    finalUrl: 'https://public.org/',
    checkedAt: '2026-10-16T00:00:00Z',
  });
  const operation = {
    ...positive(),
    kind: 'capture',
    requestText,
    requestSha256: sha(requestText),
    snapshotText,
    snapshotSha256: sha(snapshotText),
  };
  const row = {
      id: key,
      snapshotText,
      snapshotSha256: sha(snapshotText),
      operation,
      withdrawn: false,
    },
    page = {
      kind: 'associations',
      tenantId: tenant,
      actorId: actor,
      targetId: id,
      rows: [row],
      nextCursor: null,
    };
  const fetcher = vi
    .fn()
    .mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ data: page }))));
  vi.stubGlobal('fetch', fetcher);
  const query = { kind: 'associations' as const, targetId: id, after: null };
  expect(await readWebsiteAssetSelection(tenant, actor, query)).toEqual(page);
  for (const change of [
    { targetId: key },
    { rows: [{ ...row, id }] },
    { rows: [{ ...row, snapshotSha256: 'f'.repeat(64) }] },
    { rows: [{ ...row, operation: { ...operation, tenantId: id } }] },
  ]) {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ data: { ...page, ...change } })));
    await expect(readWebsiteAssetSelection(tenant, actor, query)).rejects.toThrow();
  }
});
it('capture pagination is bounded, ordered and scoped to its target and tenant', async () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({
      tenantId: tenant,
      checkId: '80000000-0000-4000-8000-' + String(i + 1).padStart(12, '0'),
      payloadSha256: 'a'.repeat(64),
      captureReceipt: { id: '10', entryHash: 'b'.repeat(64) },
      requestedUrl: 'https://public.org/',
      finalUrl: 'https://public.org/',
      checkedAt: '2026-10-16T00:00:00Z',
    })),
    page = {
      kind: 'captures',
      tenantId: tenant,
      actorId: actor,
      targetId: id,
      rows,
      nextCursor: rows.at(-1)!.checkId,
    },
    query = { kind: 'captures' as const, targetId: id, after: null };
  const fetcher = vi
    .fn()
    .mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ data: page }))));
  vi.stubGlobal('fetch', fetcher);
  expect(await readWebsiteAssetSelection(tenant, actor, query)).toEqual(page);
  for (const change of [
    { targetId: key },
    { rows: [{ ...rows[0], tenantId: id }], nextCursor: null },
    { rows: [rows[1], rows[0]], nextCursor: null },
    { nextCursor: key },
  ]) {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ data: { ...page, ...change } })));
    await expect(readWebsiteAssetSelection(tenant, actor, query)).rejects.toThrow();
  }
  await expect(
    readWebsiteAssetSelection(tenant, actor, { ...query, after: rows[0]!.checkId }),
  ).rejects.toThrow();
});
