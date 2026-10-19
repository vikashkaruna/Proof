import { dataFlowContext, type DataFlowContext } from '@axiom/types';
export interface DeclaredFlowGraph {
  nodes: { id: string; kind: 'system' | 'party' | 'unknown'; label: string }[];
  edges: {
    id: string;
    from: string;
    to: string;
    label: 'DECLARED · reviewed-current';
    href: string;
    reviewValidUntil: string;
    receiptId: string;
  }[];
  excluded: number;
}
/** Only explicit independently reviewed-current declarations create edges.
 * This projection grants nothing and never infers a party/system by name. */
export function projectDeclaredFlows(
  raw: unknown,
  tenantId: string,
  actorId: string,
  now = new Date(),
): DeclaredFlowGraph {
  const context: DataFlowContext = dataFlowContext.parse(raw);
  if (context.tenantId !== tenantId || context.actorId !== actorId)
    throw Error('Foreign declaration context');
  const nodes = new Map<string, DeclaredFlowGraph['nodes'][number]>();
  const edges: DeclaredFlowGraph['edges'] = [];
  for (const r of context.revisions) {
    if (r.tenantId !== tenantId) throw Error('Foreign declaration revision');
    if (
      !r.isHead ||
      r.state !== 'approved' ||
      r.reviewReceiptId === null ||
      Date.parse(r.request.validUntil) <= now.getTime()
    )
      continue;
    const source = context.systems.find(
      (s) =>
        s.pin.systemId === r.source.origin.systemId &&
        s.pin.estateId === r.source.origin.estateId &&
        s.pin.version === r.source.origin.version &&
        s.pin.contentSha256 === r.source.origin.contentSha256,
    );
    if (!source) continue;
    const from = 'system:' + source.pin.systemId;
    nodes.set(from, { id: from, kind: 'system', label: source.name });
    let to: string;
    const d = r.source.destination;
    if (d.kind === 'system') {
      const system = context.systems.find(
        (s) =>
          s.pin.systemId === d.system.systemId &&
          s.pin.estateId === d.system.estateId &&
          s.pin.version === d.system.version &&
          s.pin.contentSha256 === d.system.contentSha256,
      );
      if (!system) continue;
      to = 'system:' + system.pin.systemId;
      nodes.set(to, { id: to, kind: 'system', label: system.name });
    } else if (d.kind === 'party') {
      if (!r.party || r.party.partyRef !== d.party.partyRef) continue;
      to = 'party:' + r.party.partyRef;
      nodes.set(to, {
        id: to,
        kind: 'party',
        label: r.party.label + ' (declared ' + r.party.role + ')',
      });
    } else {
      to = 'unknown:' + r.revisionId;
      nodes.set(to, { id: to, kind: 'unknown', label: 'Explicitly unknown destination' });
    }
    edges.push({
      id: r.revisionId,
      from,
      to,
      label: 'DECLARED · reviewed-current',
      href: '/datamap/flows/' + r.revisionId,
      reviewValidUntil: r.request.validUntil,
      receiptId: r.reviewReceiptId,
    });
  }
  return {
    nodes: [...nodes.values()].filter((n) => edges.some((e) => e.from === n.id || e.to === n.id)),
    edges,
    excluded: context.revisions.length - edges.length,
  };
}
