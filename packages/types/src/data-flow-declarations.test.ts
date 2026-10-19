import { expect, it } from 'vitest';
import { dataFlowIntent, dataFlowOperation, encodeDataFlowIntent } from './data-flow-declarations';
const id = '10000000-0000-4000-8000-000000000001',
  hash = 'a'.repeat(64);
const decision = {
  schemaVersion: 1 as const,
  operationKey: id,
  revisionId: id,
  expectedContentSha256: hash,
  reason: 'Reviewed explicit metadata scope carefully.',
};
it('domain separates exact declaration decision phases', () => {
  const approve = dataFlowIntent.parse({ phase: 'approve', request: decision }),
    withdraw = dataFlowIntent.parse({ phase: 'withdraw', request: decision });
  expect(encodeDataFlowIntent(approve)).not.toBe(encodeDataFlowIntent(withdraw));
});
it('refuses caller additions and incomplete recovery scope', () => {
  expect(
    dataFlowIntent.safeParse({ phase: 'approve', request: { ...decision, connectorGrant: true } })
      .success,
  ).toBe(false);
  expect(
    dataFlowOperation.safeParse({
      recorded: false,
      requestSha256: hash,
      fenced: false,
      fenceReceiptId: null,
      challengeExpiresAt: null,
    }).success,
  ).toBe(false);
});
it('never accepts an execution destination or implicit free-text system', () => {
  expect(
    dataFlowIntent.safeParse({
      phase: 'declare',
      request: {
        schemaVersion: 1,
        operationKey: id,
        destination: { kind: 'system', name: 'Payroll' },
      },
    }).success,
  ).toBe(false);
});

const declaration = {
  schemaVersion: 1,
  operationKey: id,
  flowId: id,
  previousRevisionId: null,
  origin: { systemId: id, estateId: id, version: 1, contentSha256: hash },
  destination: { kind: 'unknown', reason: 'Destination has not been established.' },
  purpose: null,
  dataCategories: null,
  originCountry: null,
  destinationCountries: null,
  crossBorder: null,
  transferSafeguards: null,
  sourceRopaId: null,
  sourceNote: 'Synthetic metadata only',
  validUntil: '2030-01-01T00:00:00Z',
  reason: 'Reviewed exact declared metadata carefully.',
};
it('preserves explicit nulls and empty lists without replacing Unknown with false', () => {
  const parsed = dataFlowIntent.parse({ phase: 'declare', request: declaration });
  expect(parsed.request).toMatchObject({
    crossBorder: null,
    dataCategories: null,
    destinationCountries: null,
  });
  expect(
    dataFlowIntent.parse({
      phase: 'declare',
      request: { ...declaration, dataCategories: [], destinationCountries: [] },
    }).request,
  ).toMatchObject({ dataCategories: [], destinationCountries: [] });
});
it.each([
  { origin: { ...declaration.origin, version: '1' } },
  { origin: { ...declaration.origin, contentSha256: 123 } },
  {
    destination: {
      kind: 'party',
      party: {
        kind: 'new',
        declaration: { partyRef: id, label: 'A', role: null, supersedesPartyRef: null },
      },
      system: null,
    },
  },
  { sourceNote: ' leading whitespace' },
  { crossBorder: 'false' },
  { dataCategories: ['identity', 'identity'] },
  { validUntil: null },
  { validUntil: '2030-01-01' },
  { destinationCountries: ['india'] },
  { destination: { kind: 'system', endpoint: 'postgres://invalid' } },
])('refuses malformed/unbound declaration facts %#', (change) => {
  expect(
    dataFlowIntent.safeParse({ phase: 'declare', request: { ...declaration, ...change } }).success,
  ).toBe(false);
});
it('bounds UTF-8 canonical bytes before a durable request can be retained', () => {
  expect(
    dataFlowIntent.safeParse({
      phase: 'declare',
      request: {
        ...declaration,
        purpose: 'अ'.repeat(1900),
        sourceNote: 'अ'.repeat(1900),
        transferSafeguards: 'अ'.repeat(1900),
        reason: 'अ'.repeat(1900),
      },
    }).success,
  ).toBe(false);
});
