/**
 * W3.5 entity-relationship graph model. Pure: built only from rows the tenant
 * can read. Access edges come solely from active, unrevoked connector grants,
 * so an agent with no grant has no edge — the default for eight of ten agents.
 */
export interface GraphInput {
  agents: { name: string; displayName: string }[];
  estates: { id: string; name: string; status: string }[];
  systems: { id: string; estateId: string; name: string; status: string; categories: string[] }[];
  connectors: { id: string; systemId: string; name: string; status: string; assurance: string }[];
  grants: {
    id: string;
    connectorId: string;
    agentName: string;
    scope: 'connector.read' | 'connector.write';
    expiresAt: string;
    revokedAt: string | null;
  }[];
  now?: Date;
}
export type NodeKind = 'agent' | 'connector' | 'system' | 'estate' | 'category';
export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  detail: Record<string, string>;
}
export type EdgeKind = 'contains' | 'declares' | 'read' | 'write';
export interface GraphEdge {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  detail: Record<string, string>;
}
export interface GraphFilter {
  estateId?: string;
  agentName?: string;
  access?: 'all' | 'read' | 'write';
}

export function buildEstateGraph(input: GraphInput, filter: GraphFilter = {}) {
  const now = input.now ?? new Date();
  const estates = input.estates.filter(
    (e) => e.status === 'active' && (!filter.estateId || e.id === filter.estateId),
  );
  const estateIds = new Set(estates.map((e) => e.id));
  const systems = input.systems.filter((s) => s.status === 'active' && estateIds.has(s.estateId));
  const systemIds = new Set(systems.map((s) => s.id));
  const connectors = input.connectors.filter(
    (c) => c.status !== 'archived' && systemIds.has(c.systemId),
  );
  const connectorIds = new Set(connectors.map((c) => c.id));
  const access = filter.access ?? 'all';
  const grants = input.grants.filter(
    (g) =>
      g.revokedAt === null &&
      new Date(g.expiresAt) > now &&
      connectorIds.has(g.connectorId) &&
      (!filter.agentName || g.agentName === filter.agentName) &&
      (access === 'all' || g.scope === `connector.${access}`),
  );

  const nodes: GraphNode[] = [
    ...input.agents.map((a) => ({
      id: `agent:${a.name}`,
      kind: 'agent' as const,
      label: a.displayName,
      detail: { agent: a.name },
    })),
    ...connectors.map((c) => ({
      id: `connector:${c.id}`,
      kind: 'connector' as const,
      label: c.name,
      detail: {
        status: c.status,
        assurance: c.assurance,
        note: 'Registration, not a live connection',
      },
    })),
    ...systems.map((s) => ({
      id: `system:${s.id}`,
      kind: 'system' as const,
      label: s.name,
      detail: { categories: s.categories.join(', ') || 'none declared' },
    })),
    ...estates.map((e) => ({
      id: `estate:${e.id}`,
      kind: 'estate' as const,
      label: e.name,
      detail: {},
    })),
  ];
  const categories = [...new Set(systems.flatMap((s) => s.categories))].sort();
  nodes.push(
    ...categories.map((c) => ({
      id: `category:${c}`,
      kind: 'category' as const,
      label: c,
      detail: {},
    })),
  );

  const edges: GraphEdge[] = [
    ...systems.map((s) => ({
      id: `contains:${s.estateId}:${s.id}`,
      kind: 'contains' as const,
      from: `estate:${s.estateId}`,
      to: `system:${s.id}`,
      detail: {},
    })),
    ...connectors.map((c) => ({
      id: `contains:${c.systemId}:${c.id}`,
      kind: 'contains' as const,
      from: `system:${c.systemId}`,
      to: `connector:${c.id}`,
      detail: {},
    })),
    ...systems.flatMap((s) =>
      s.categories.map((c) => ({
        id: `declares:${s.id}:${c}`,
        kind: 'declares' as const,
        from: `system:${s.id}`,
        to: `category:${c}`,
        detail: {},
      })),
    ),
    ...grants.map((g) => ({
      id: `grant:${g.id}`,
      kind: g.scope === 'connector.write' ? ('write' as const) : ('read' as const),
      from: `agent:${g.agentName}`,
      to: `connector:${g.connectorId}`,
      detail: { grant: g.id, scope: g.scope, expiresAt: g.expiresAt },
    })),
  ];
  return { nodes, edges };
}

/** Deterministic column layout: agents → connectors → systems → estates → categories. */
export const COLUMNS: NodeKind[] = ['agent', 'connector', 'system', 'estate', 'category'];
export function layout(nodes: GraphNode[], width = 1000, rowHeight = 56) {
  const positions = new Map<string, { x: number; y: number }>();
  const step = width / COLUMNS.length;
  COLUMNS.forEach((kind, column) => {
    nodes
      .filter((n) => n.kind === kind)
      .forEach((n, row) =>
        positions.set(n.id, { x: step * column + step / 2, y: 40 + row * rowHeight }),
      );
  });
  const rows = Math.max(1, ...COLUMNS.map((k) => nodes.filter((n) => n.kind === k).length));
  return { positions, height: 40 + rows * rowHeight };
}
