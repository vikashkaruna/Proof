import { expect, it } from 'vitest';
import { localCustodyContextSchema } from './local-custody-context';
const id = '11111111-1111-4111-8111-111111111111';
const valid = {
  version: 1,
  tenantId: id,
  actorId: id,
  isDemo: false,
  canRequest: true,
  requestModes: ['operator_managed'],
  selectedPolicyId: null,
  rows: [],
  nextCursor: null,
  history: [],
  nextHistoryCursor: null,
};
it('strict current human context excludes credential and key material fields', () => {
  expect(localCustodyContextSchema.parse(valid)).toEqual(valid);
  for (const extra of [{ jwt: 'secret' }, { keyMaterial: 'secret' }, { canBypassMfa: true }])
    expect(() => localCustodyContextSchema.parse({ ...valid, ...extra })).toThrow();
});
it('rejects invalid pagination and unbounded policy sets', () => {
  expect(() => localCustodyContextSchema.parse({ ...valid, nextHistoryCursor: '-1' })).toThrow();
  expect(() =>
    localCustodyContextSchema.parse({ ...valid, rows: Array.from({ length: 21 }, () => ({})) }),
  ).toThrow();
  expect(() => localCustodyContextSchema.parse({ ...valid, tenantId: 'wrong' })).toThrow();
});

it('rejects contradictory or duplicated request mode guidance', () => {
  expect(() => localCustodyContextSchema.parse({ ...valid, canRequest: false })).toThrow();
  expect(() =>
    localCustodyContextSchema.parse({
      ...valid,
      requestModes: ['operator_managed', 'operator_managed'],
    }),
  ).toThrow();
});
