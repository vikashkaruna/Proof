import { expect, it } from 'vitest';
import { encodePublicWebsiteAssetRequest } from './public-website-assets';
import {
  publicWebsiteAssetCancellationRequestSchema,
  publicWebsiteAssetCancellationSnapshotSchema,
  publicWebsiteAssetResolutionSchema,
} from './public-website-asset-console';
const id = '11111111-1111-4111-8111-111111111111';
const requestText = encodePublicWebsiteAssetRequest({
  version: 1,
  kind: 'capture',
  confirmed: true,
  operationKey: id,
  targetId: id,
  expectedTargetSha256: 'a'.repeat(64),
});
it('cancellation keeps exact original canonical request and explicit per-intent reason/confirmation', () => {
  expect(
    publicWebsiteAssetCancellationRequestSchema.parse({
      requestText,
      reason: 'Abandon this pending operation',
      confirmed: true,
    }),
  ).toEqual({ requestText, reason: 'Abandon this pending operation', confirmed: true });
  for (const bad of [
    { requestText: requestText + ' ' },
    { requestText: '{}' },
    { confirmed: false },
    { reason: ' ' },
    { reason: '\ud800' },
    { requestSha256: 'a'.repeat(64) },
  ])
    expect(
      publicWebsiteAssetCancellationRequestSchema.safeParse({
        requestText,
        reason: 'Abandon',
        confirmed: true,
        ...bad,
      }).success,
    ).toBe(false);
});
it('cancellation schema never upgrades a missing outcome to positive', () => {
  expect(publicWebsiteAssetResolutionSchema.parse({ state: 'not_found' })).toEqual({
    state: 'not_found',
  });
  for (const value of [
    { state: 'cancelled' },
    { state: 'recorded' },
    { state: 'not_found', receipt: 'made-up' },
  ])
    expect(publicWebsiteAssetResolutionSchema.safeParse(value).success).toBe(false);
});
it('cancellation snapshot is scoped, versioned and cannot claim execution or verified ownership', () => {
  const snapshot = {
    version: 1,
    id,
    tenantId: id,
    actorId: id,
    operationKey: id,
    requestSha256: 'a'.repeat(64),
    reason: '🛡️ '.repeat(500),
    confirmed: true,
  };
  expect(publicWebsiteAssetCancellationSnapshotSchema.safeParse(snapshot).success).toBe(true);
  expect(
    publicWebsiteAssetCancellationSnapshotSchema.safeParse({ ...snapshot, ownershipVerified: true })
      .success,
  ).toBe(false);
  expect(
    publicWebsiteAssetCancellationSnapshotSchema.safeParse({
      ...snapshot,
      actorId: '00000000-0000-0000-0000-000000000000',
    }).success,
  ).toBe(false);
});
