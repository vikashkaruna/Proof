import { expect, it } from 'vitest';
import { fixture, id, hash } from '@/app/(app)/datamap/flows/flow.test-fixture';
import { projectDeclaredFlows } from './declared-flow-graph';
function saved() {
  const { context, journal, source } = fixture();
  if (journal.intent.phase !== 'declare') throw Error();
  return {
    ...context,
    revisions: [
      {
        revisionId: id(30),
        flowId: id(31),
        version: 1,
        tenantId: id(3),
        preparerId: id(1),
        isHead: true,
        request: journal.intent.request,
        requestSha256: hash,
        contentSha256: hash,
        sourceSha256: hash,
        source: { origin: source, destination: { kind: 'unknown' as const }, ropa: null },
        party: null,
        state: 'approved' as const,
        declarationReceiptId: '1',
        reviewReceiptId: '2',
        withdrawalReceiptId: null,
        createdAt: context.checkedAt,
        reviewedAt: context.checkedAt,
      },
    ],
  };
}
it('projects explicit unknown only after independent review, with immutable source path', () => {
  const g = projectDeclaredFlows(saved(), id(3), id(1));
  expect(g.edges).toHaveLength(1);
  expect(g.edges[0]).toMatchObject({
    label: 'DECLARED · reviewed-current',
    href: '/datamap/flows/' + id(30),
  });
  expect(g.nodes[1]?.kind).toBe('unknown');
});
it.each(['proposed', 'rejected', 'withdrawn', 'superseded', 'expired', 'stale'])(
  'does not create factual transfer edges for %s history',
  (state) => {
    const c = saved();
    expect(
      projectDeclaredFlows({ ...c, revisions: [{ ...c.revisions[0], state }] }, id(3), id(1)).edges,
    ).toHaveLength(0);
  },
);
it('refuses foreign scope and excludes source version drift and validity elapsed after read', () => {
  const c = saved();
  expect(() => projectDeclaredFlows(c, id(99), id(1))).toThrow('Foreign');
  expect(() =>
    projectDeclaredFlows(
      { ...c, revisions: [{ ...c.revisions[0], tenantId: id(99) }] },
      id(3),
      id(1),
    ),
  ).toThrow('Foreign');
  expect(projectDeclaredFlows({ ...c, systems: [] }, id(3), id(1)).edges).toHaveLength(0);
  expect(projectDeclaredFlows(c, id(3), id(1), new Date(Date.now() + 86400001)).edges).toHaveLength(
    0,
  );
});
