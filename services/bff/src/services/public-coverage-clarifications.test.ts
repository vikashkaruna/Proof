import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { canonicalJson } from '@axiom/ledger';
import { verifyPublicCoverageClarification } from './public-coverage-clarifications';
const tenantId = '11111111-1111-4111-8111-111111111111',
  actorId = '22222222-2222-4222-8222-222222222222',
  engagementId = '33333333-3333-4333-8333-333333333333',
  checkId = '44444444-4444-4444-8444-444444444444',
  operationKey = '55555555-5555-4555-8555-555555555555',
  id = '66666666-6666-4666-8666-666666666666',
  payloadSha256 = 'a'.repeat(64);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function fixture() {
  const request = {
    version: 1,
    operationKey,
    engagementId,
    checkId,
    payloadSha256,
    expectedPreviousRevisionId: null,
    clarifications: [
      {
        page: 'privacy',
        sourceState: 'unexamined',
        sourceTruncated: false,
        reasonCategory: 'not_public',
        reason: 'The policy is available privately for further owner review.',
        proposedPublicUrl: null,
      },
    ],
  };
  const requestText = canonicalJson(request);
  const snapshotText = canonicalJson({
    version: 1,
    disposition: 'owner_declarations_unverified',
    tenantId,
    actorId,
    revisionId: id,
    previousRevisionId: null,
    recordedAt: '2026-10-21T10:00:00.000000Z',
    request,
  });
  return {
    id,
    tenantId,
    actorId,
    engagementId,
    checkId,
    payloadSha256,
    operationKey,
    requestText,
    requestSha256: hash(requestText),
    snapshotText,
    snapshotSha256: hash(snapshotText),
    receiptId: '123',
  };
}
const scope = { tenantId, actorId, engagementId, checkId, payloadSha256, operationKey };
it('verifies exact source and canonical unverified owner declaration receipt', () => {
  const record = fixture();
  expect(
    verifyPublicCoverageClarification(record, { ...scope, requestText: record.requestText })
      .snapshot.disposition,
  ).toBe('owner_declarations_unverified');
});
it.each([
  'tenantId',
  'actorId',
  'engagementId',
  'checkId',
  'payloadSha256',
  'operationKey',
] as const)('refuses %s scope substitution', (key) => {
  const record = fixture();
  expect(() =>
    verifyPublicCoverageClarification(record, {
      ...scope,
      [key]: key === 'payloadSha256' ? 'b'.repeat(64) : '77777777-7777-4777-8777-777777777777',
    }),
  ).toThrow();
});
it('refuses altered receipt bytes even with valid JSON', () => {
  const record = fixture();
  expect(() =>
    verifyPublicCoverageClarification(
      { ...record, snapshotText: record.snapshotText + ' ' },
      scope,
    ),
  ).toThrow();
});
it('refuses a recomputed snapshot that changes observed source or actor', () => {
  const record = fixture();
  const changed = JSON.parse(record.snapshotText) as { actorId: string };
  changed.actorId = tenantId;
  const snapshotText = canonicalJson(changed);
  expect(() =>
    verifyPublicCoverageClarification(
      { ...record, snapshotText, snapshotSha256: hash(snapshotText) },
      scope,
    ),
  ).toThrow();
});
it('refuses a different canonical pending request after a lost response', () => {
  const record = fixture();
  expect(() =>
    verifyPublicCoverageClarification(record, {
      ...scope,
      requestText: record.requestText.replace('privately', 'internally'),
    }),
  ).toThrow();
});
