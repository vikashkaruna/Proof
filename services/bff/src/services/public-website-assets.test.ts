import { describe, it, expect } from 'vitest';
import {
  encodePublicWebsiteAssetRequest,
  PUBLIC_WEBSITE_ASSET_REQUEST_CODEC,
  PUBLIC_WEBSITE_ASSET_SNAPSHOT_CODEC,
} from '@axiom/types';
import {
  assetSha256,
  verifyWebsiteAssetOperation,
  verifyWebsiteCaptureTarget,
} from './public-website-assets.js';
export const tenant = '11111111-1111-4111-8111-111111111111',
  actor = '22222222-2222-4222-8222-222222222222',
  key = '33333333-3333-4333-8333-333333333333',
  id = '44444444-4444-4444-8444-444444444444';
export const request = {
  version: 1,
  kind: 'register_target',
  operationKey: key,
  confirmed: true,
  estateId: id,
  systemId: key,
  expectedEstateVersion: 1,
  expectedSystemVersion: 2,
  url: 'https://example.com/',
};
const canonical = (o: Record<string, unknown>) => JSON.stringify(o, Object.keys(o).sort());
export function fixture() {
  const requestText = encodePublicWebsiteAssetRequest(request);
  const snapshotText = canonical({
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
    systemVersion: 2,
    targetVersion: 1,
    estateName: 'Estate',
    systemName: 'Public site',
    url: 'https://example.com/',
  });
  return {
    state: 'recorded',
    tenantId: tenant,
    actorId: actor,
    operationKey: key,
    kind: 'register_target',
    requestCodec: PUBLIC_WEBSITE_ASSET_REQUEST_CODEC,
    requestText,
    requestSha256: assetSha256(requestText),
    snapshotCodec: PUBLIC_WEBSITE_ASSET_SNAPSHOT_CODEC,
    snapshotText,
    snapshotSha256: assetSha256(snapshotText),
    receipt: { id: '10', entryHash: 'a'.repeat(64) },
    replayed: false,
  };
}
describe('immutable public asset receipt', () => {
  it('binds exact canonical request, scope, snapshot and digest', () => {
    const row = fixture();
    expect(
      verifyWebsiteAssetOperation(row, {
        tenantId: tenant,
        actorId: actor,
        operationKey: key,
        requestText: row.requestText,
      }),
    ).toEqual(row);
  });
  it.each(['tenantId', 'actorId', 'operationKey', 'requestSha256', 'snapshotSha256'] as const)(
    'rejects changed %s',
    (field) => {
      const row = fixture();
      expect(() =>
        verifyWebsiteAssetOperation(
          { ...row, [field]: field.endsWith('Sha256') ? 'b'.repeat(64) : id },
          { tenantId: tenant, actorId: actor, operationKey: key },
        ),
      ).toThrow();
    },
  );
  it('rejects a coherently hashed snapshot that changes the reviewed inventory scope', () => {
    const row = fixture();
    const snapshotText = row.snapshotText.replace('"systemVersion":2', '"systemVersion":3');
    expect(() =>
      verifyWebsiteAssetOperation(
        { ...row, snapshotText, snapshotSha256: assetSha256(snapshotText) },
        { tenantId: tenant, actorId: actor, operationKey: key },
      ),
    ).toThrow();
  });
  it('never treats not_found as positive or another body as the same operation', () => {
    expect(() =>
      verifyWebsiteAssetOperation(
        { state: 'not_found' },
        { tenantId: tenant, actorId: actor, operationKey: key },
      ),
    ).toThrow();
    expect(() =>
      verifyWebsiteAssetOperation(fixture(), {
        tenantId: tenant,
        actorId: actor,
        operationKey: key,
        requestText: '{}',
      }),
    ).toThrow();
  });
  it('allows a different authorized capturing actor but binds target tenant/id/hash', () => {
    const row = fixture();
    const scope = { tenantId: tenant, actorId: id };
    const capture = {
      version: 1,
      kind: 'capture',
      confirmed: true,
      operationKey: key,
      targetId: id,
      expectedTargetSha256: row.snapshotSha256,
    } as const;
    const value = { snapshotText: row.snapshotText, snapshotSha256: row.snapshotSha256 };
    expect(verifyWebsiteCaptureTarget(value, scope, capture).url).toBe('https://example.com/');
    expect(() => verifyWebsiteCaptureTarget(value, { ...scope, tenantId: id }, capture)).toThrow();
    expect(() =>
      verifyWebsiteCaptureTarget(value, scope, {
        ...capture,
        expectedTargetSha256: 'b'.repeat(64),
      }),
    ).toThrow();
  });
});
it('binds existing capture references and withdrawal reason rather than accepting coherent substituted snapshots', () => {
  const source = fixture();
  const canonical = (o: unknown): string =>
    o !== null && typeof o === 'object' && !Array.isArray(o)
      ? '{' +
        Object.entries(o)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
          .join(',') +
        '}'
      : JSON.stringify(o);
  const common = {
    version: 1,
    id,
    tenantId: tenant,
    actorId: actor,
    ownershipVerified: false,
    connectorAccessGranted: false,
  };
  const associate = {
    version: 1,
    kind: 'associate_capture',
    operationKey: key,
    confirmed: true,
    targetId: id,
    expectedTargetSha256: 'a'.repeat(64),
    checkId: key,
    expectedPayloadSha256: 'b'.repeat(64),
    expectedCaptureReceipt: '13',
  };
  const association = {
    ...common,
    kind: 'association',
    targetId: id,
    targetSha256: 'a'.repeat(64),
    checkId: key,
    payloadSha256: 'b'.repeat(64),
    captureReceipt: { id: '13', entryHash: 'c'.repeat(64) },
    requestedUrl: 'https://example.com/',
    finalUrl: 'http://example.com/',
    checkedAt: '2026-10-16T00:00:00Z',
  };
  const withdrawal = {
    version: 1,
    kind: 'withdraw',
    operationKey: key,
    confirmed: true,
    subjectType: 'target',
    subjectId: id,
    expectedSubjectSha256: 'd'.repeat(64),
    reason: 'Replace obsolete reference',
  };
  const withdrawn = {
    ...common,
    kind: 'withdrawal',
    subjectType: 'target',
    subjectId: id,
    subjectSha256: 'd'.repeat(64),
    reason: 'Replace obsolete reference',
  };
  for (const [request, snapshot, changed] of [
    [associate, association, { checkId: id }],
    [withdrawal, withdrawn, { reason: 'Different reason' }],
  ] as const) {
    const requestText = encodePublicWebsiteAssetRequest(request);
    const snapshotText = canonical(snapshot);
    const row = {
      ...source,
      kind: request.kind,
      requestText,
      requestSha256: assetSha256(requestText),
      snapshotText,
      snapshotSha256: assetSha256(snapshotText),
    };
    expect(
      verifyWebsiteAssetOperation(row, { tenantId: tenant, actorId: actor, operationKey: key }),
    ).toEqual(row);
    const altered = canonical({ ...snapshot, ...changed });
    expect(() =>
      verifyWebsiteAssetOperation(
        { ...row, snapshotText: altered, snapshotSha256: assetSha256(altered) },
        { tenantId: tenant, actorId: actor, operationKey: key },
      ),
    ).toThrow();
  }
});
