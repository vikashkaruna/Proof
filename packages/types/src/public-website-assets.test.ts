import { expect, it } from 'vitest';
import {
  encodePublicWebsiteAssetRequest,
  parsePublicWebsiteAssetRequestText,
  parsePublicWebsiteAssetSnapshotText,
  publicWebsiteAssetRequestSchema,
  publicWebsiteAssetUrlSchema,
} from './public-website-assets';
const id = '11111111-1111-4111-8111-111111111111';
const registration = {
  version: 1,
  operationKey: id,
  confirmed: true,
  kind: 'register_target',
  estateId: id,
  systemId: id,
  expectedEstateVersion: 1,
  expectedSystemVersion: 1,
  url: 'https://public.org/',
};
it('canonical registration codec round trips immutable scalar fields with no authority claim', () => {
  const text = encodePublicWebsiteAssetRequest(registration);
  expect(parsePublicWebsiteAssetRequestText(text)).toEqual(registration);
  expect(
    encodePublicWebsiteAssetRequest(Object.fromEntries(Object.entries(registration).reverse())),
  ).toBe(text);
});
it.each([
  'duplicate',
  'escaped_duplicate',
  'unknown',
  'space',
  'float',
  'uppercase',
  'missing_confirmation',
])('rejects %s retained request bytes', (mode) => {
  let text = encodePublicWebsiteAssetRequest(registration);
  if (mode === 'duplicate') text = text.replace('"version":1', '"version":0,"version":1');
  if (mode === 'escaped_duplicate')
    text = text.replace('"version":1', '"vers\\u0069on":0,"version":1');
  if (mode === 'unknown') text = text.slice(0, -1) + ',"ownershipVerified":true}';
  if (mode === 'space') text += ' ';
  if (mode === 'float')
    text = text.replace('"expectedEstateVersion":1', '"expectedEstateVersion":1.0');
  if (mode === 'uppercase') text = text.replaceAll(id, id.toUpperCase());
  if (mode === 'missing_confirmation') text = text.replace('"confirmed":true', '"confirmed":false');
  // Digits-only UUID needs an alphabetic canonicality substitution.
  if (mode === 'uppercase') text = text.replaceAll(id, 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA');
  expect(() => parsePublicWebsiteAssetRequestText(text)).toThrow('refused');
});
it.each([
  'https://public.org/?token=x',
  'https://user:password@public.org/',
  'http://public.org/',
  'https://public.org/#secret',
  'https://127.0.0.1/',
  'https://localhost/',
  'https://public.org:8443/',
  'https://public.org/\ud800',
])('refuses non-public or secret-bearing registration reference %s', (url) => {
  expect(publicWebsiteAssetUrlSchema.safeParse(url).success).toBe(false);
});
it('normalizes only explicitly encoded target input before retaining canonical bytes', () => {
  expect(
    parsePublicWebsiteAssetRequestText(
      encodePublicWebsiteAssetRequest({ ...registration, url: 'https://PUBLIC.org' }),
    ),
  ).toMatchObject({ url: 'https://public.org/' });
});
it.each(['capture', 'associate_capture', 'withdraw'])(
  'admits only reviewed identifiers for %s operations',
  (kind) => {
    const common = { version: 1, operationKey: id, confirmed: true, kind };
    const req =
      kind === 'withdraw'
        ? {
            ...common,
            subjectType: 'association',
            subjectId: id,
            expectedSubjectSha256: 'a'.repeat(64),
            reason: 'Wrong public reference; append withdrawal.',
          }
        : kind === 'capture'
          ? { ...common, targetId: id, expectedTargetSha256: 'a'.repeat(64) }
          : {
              ...common,
              targetId: id,
              expectedTargetSha256: 'a'.repeat(64),
              checkId: id,
              expectedPayloadSha256: 'b'.repeat(64),
              expectedCaptureReceipt: '1',
            };
    expect(parsePublicWebsiteAssetRequestText(encodePublicWebsiteAssetRequest(req))).toEqual(req);
    expect(
      publicWebsiteAssetRequestSchema.safeParse({ ...req, credentials: 'secret' }).success,
    ).toBe(false);
  },
);
it('never accepts verification/connector authority in snapshots or malformed retained bytes', () => {
  const value = {
    version: 1,
    id,
    tenantId: id,
    actorId: id,
    kind: 'withdrawal',
    subjectType: 'target',
    subjectId: id,
    subjectSha256: 'a'.repeat(64),
    reason: 'Historical correction.',
    ownershipVerified: false,
    connectorAccessGranted: false,
  };
  const text = JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))),
  );
  expect(parsePublicWebsiteAssetSnapshotText(text)).toEqual(value);
  expect(() =>
    parsePublicWebsiteAssetSnapshotText(
      text.replace('"ownershipVerified":false', '"ownershipVerified":true'),
    ),
  ).toThrow();
  expect(() => parsePublicWebsiteAssetSnapshotText(text + ' ')).toThrow();
  expect(() => parsePublicWebsiteAssetSnapshotText('x'.repeat(16385))).toThrow();
});

it('refuses nil/max UUID and canonical URL expansion beyond SQL byte limits', () => {
  for (const operationKey of [
    '00000000-0000-0000-0000-000000000000',
    'ffffffff-ffff-ffff-ffff-ffffffffffff',
  ])
    expect(() => encodePublicWebsiteAssetRequest({ ...registration, operationKey })).toThrow();
  expect(() =>
    encodePublicWebsiteAssetRequest({
      ...registration,
      url: 'https://public.org/' + '文'.repeat(700),
    }),
  ).toThrow();
});
