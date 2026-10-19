import { expect, it } from 'vitest';
import { projectApprovedDerivation, type GraphProvenance } from './estate-graph-provenance';
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = 'a'.repeat(64),
  when = '2026-10-19T00:00:00Z';
function fixture() {
  const systems = [{ id: id(3), estateId: id(2) }],
    proposals = [
      {
        id: id(4),
        tenant_id: id(1),
        estate_id: id(2),
        content_sha256: hash,
        status: 'approved',
        reviewed_at: when,
        onboarding_proposal_systems: [
          { tenant_id: id(1), proposal_id: id(4), source_index: 0, system_id: id(3) },
        ],
      },
    ],
    receipts = [
      {
        id: '123',
        tenant_id: id(1),
        target_ref: id(4),
        actor_type: 'human',
        action_type: 'onboarding.proposal.approved',
        result: 'success',
        occurred_at: when,
        commitment: hash,
        system_ids: [id(3)],
      },
    ];
  return { systems, proposals, receipts };
}
it('projects only exact approved source, item index, hash, timestamp and receipt with a capability-safe existing source path', () => {
  const f = fixture();
  const p = projectApprovedDerivation(id(1), f.systems, f.proposals, f.receipts, true);
  expect(p.bySystem[id(3)]).toEqual({
    state: 'recorded',
    proposalId: id(4),
    sourceIndex: 0,
    contentSha256: hash,
    reviewReceiptId: '123',
    reviewedAt: when,
    sourceHref: `/estate/onboarding#proposal-${id(4)}`,
  });
  expect(Object.keys(p.bySystem[id(3)]!).sort()).toEqual(
    [
      'state',
      'proposalId',
      'sourceIndex',
      'contentSha256',
      'reviewReceiptId',
      'reviewedAt',
      'sourceHref',
    ].sort(),
  );
});
it('keeps readable metadata without offering a source path that the role cannot open', () => {
  const f = fixture();
  expect(
    projectApprovedDerivation(id(1), f.systems, f.proposals, f.receipts, false).bySystem[id(3)],
  ).toMatchObject({ state: 'recorded', sourceHref: null });
});
it.each([
  'tenant',
  'link-tenant',
  'proposal-reference',
  'unapproved',
  'hash',
  'receipt-target',
  'receipt-time',
  'receipt-tenant',
  'receipt-action',
  'receipt-result',
  'receipt-system',
  'orphan',
  'duplicate-receipt',
  'noncontiguous-index',
  'duplicate-system',
  'estate-moved',
  'extra-sensitive-field',
  'unsafe-receipt-id',
] as const)('refuses %s without fabricating derivation', (kind) => {
  const f = fixture();
  const p = f.proposals[0]!,
    r = f.receipts[0]!,
    l = p.onboarding_proposal_systems[0]!;
  if (kind === 'tenant') p.tenant_id = id(9);
  if (kind === 'link-tenant') l.tenant_id = id(9);
  if (kind === 'proposal-reference') l.proposal_id = id(9);
  if (kind === 'unapproved') p.status = 'pending';
  if (kind === 'hash') r.commitment = 'b'.repeat(64);
  if (kind === 'receipt-target') r.target_ref = id(9);
  if (kind === 'receipt-time') r.occurred_at = '2026-10-18T00:00:00Z';
  if (kind === 'receipt-tenant') r.tenant_id = id(9);
  if (kind === 'receipt-action') r.action_type = 'onboarding.proposal.rejected';
  if (kind === 'receipt-result') r.result = 'failed';
  if (kind === 'receipt-system') r.system_ids = [id(9)];
  if (kind === 'orphan') f.receipts = [];
  if (kind === 'duplicate-receipt') f.receipts.push({ ...r, id: '124' });
  if (kind === 'noncontiguous-index') l.source_index = 1;
  if (kind === 'duplicate-system') p.onboarding_proposal_systems.push({ ...l, source_index: 1 });
  if (kind === 'estate-moved') f.systems[0]!.estateId = id(9);
  if (kind === 'extra-sensitive-field')
    Object.assign(p, { source_snapshot: 'REJECTED_PRIVATE_SOURCE' });
  if (kind === 'unsafe-receipt-id') r.id = '9223372036854775808';
  const result = projectApprovedDerivation(id(1), f.systems, f.proposals, f.receipts, true);
  expect(result.bySystem[id(3)]?.state).toBe('unavailable');
  expect(JSON.stringify(result)).not.toContain('REJECTED_PRIVATE_SOURCE');
});
it('does not match names or attach an orphan source to a different system', () => {
  const f = fixture();
  f.systems = [{ id: id(8), estateId: id(2) }];
  const p = projectApprovedDerivation(id(1), f.systems, f.proposals, f.receipts, true);
  expect(p.bySystem[id(8)]).toEqual({ state: 'absent' });
});
it('rejects oversized source unions instead of displaying a partial success', () => {
  const f = fixture();
  expect(
    projectApprovedDerivation(id(1), f.systems, [...f.proposals, ...f.proposals], f.receipts, true)
      .state,
  ).toBe('unavailable');
});
it('describes absent approved history without inferring manual registration', () => {
  const f = fixture();
  const result: GraphProvenance = projectApprovedDerivation(id(1), f.systems, [], [], true);
  expect(result.bySystem[id(3)]).toEqual({ state: 'absent' });
});

it('requires exact review instants including PostgreSQL microseconds but accepts equivalent offsets', () => {
  const f = fixture();
  f.proposals[0]!.reviewed_at = '2026-10-19T00:00:00.000001Z';
  f.receipts[0]!.occurred_at = '2026-10-19T00:00:00.000002Z';
  expect(
    projectApprovedDerivation(id(1), f.systems, f.proposals, f.receipts, true).bySystem[id(3)]
      ?.state,
  ).toBe('unavailable');
  f.receipts[0]!.occurred_at = '2026-10-19T05:30:00.000001+05:30';
  expect(
    projectApprovedDerivation(id(1), f.systems, f.proposals, f.receipts, true).bySystem[id(3)]
      ?.state,
  ).toBe('recorded');
});
