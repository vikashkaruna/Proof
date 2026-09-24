'use client';
import { useMemo, useRef, useState } from 'react';
import { AgentIcon, Button, Card, CardContent } from '@axiom/ui';
import {
  buildEstateGraph,
  COLUMNS,
  layout,
  type GraphFilter,
  type GraphInput,
  type GraphNode,
} from '@/lib/estate-graph';

const WIDTH = 1000;
const TEAL = '#0FB5A5';
const INDIGO = '#1E2A4A';
const GREY = '#94A3B8';
const COLUMN_LABELS = ['Agents', 'Connectors', 'Systems', 'Estates', 'Data categories'];
const fieldClass = 'rounded-md border border-input bg-background p-2 text-sm';

export function EstateGraph({ input }: { input: GraphInput }) {
  const [filter, setFilter] = useState<GraphFilter>({ access: 'all' });
  const [selected, setSelected] = useState<string | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const graph = useMemo(() => buildEstateGraph(input, filter), [input, filter]);
  const { positions, height } = useMemo(() => layout(graph.nodes, WIDTH), [graph.nodes]);
  const node = graph.nodes.find((n) => n.id === selected) ?? null;
  const related = graph.edges.filter((e) => e.from === selected || e.to === selected);
  const label = (id: string) => graph.nodes.find((n) => n.id === id)?.label ?? id;

  function exportSvg() {
    if (!svg.current) return;
    const text = new XMLSerializer().serializeToString(svg.current);
    const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'estate-graph.svg';
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-4" data-testid="estate-graph">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-sm">
          Estate
          <select
            aria-label="Estate filter"
            className={fieldClass}
            value={filter.estateId ?? ''}
            onChange={(e) => setFilter({ ...filter, estateId: e.target.value || undefined })}
          >
            <option value="">All active estates</option>
            {input.estates
              .filter((e) => e.status === 'active')
              .map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
          </select>
        </label>
        <label className="flex flex-col text-sm">
          Agent
          <select
            aria-label="Agent filter"
            className={fieldClass}
            value={filter.agentName ?? ''}
            onChange={(e) => setFilter({ ...filter, agentName: e.target.value || undefined })}
          >
            <option value="">All agents</option>
            {input.agents.map((a) => (
              <option key={a.name} value={a.name}>
                {a.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-sm">
          Access
          <select
            aria-label="Access filter"
            className={fieldClass}
            value={filter.access ?? 'all'}
            onChange={(e) =>
              setFilter({ ...filter, access: e.target.value as GraphFilter['access'] })
            }
          >
            <option value="all">Read and write</option>
            <option value="read">Read only</option>
            <option value="write">Write only</option>
          </select>
        </label>
        <Button
          type="button"
          onClick={() => setFilter({ ...filter, agentName: 'karya', access: 'write' })}
        >
          Everything Karya can write to
        </Button>
        <Button type="button" onClick={exportSvg}>
          Export SVG
        </Button>
      </div>
      <p className="text-sm" data-testid="graph-summary">
        {graph.edges.filter((e) => e.kind === 'read').length} read grants ·{' '}
        {graph.edges.filter((e) => e.kind === 'write').length} write grants · agents without an edge
        hold no client-system access.
      </p>
      <div className="flex flex-col gap-4 lg:flex-row">
        <div className="overflow-x-auto rounded-md border">
          <svg
            ref={svg}
            xmlns="http://www.w3.org/2000/svg"
            width={WIDTH}
            height={height}
            viewBox={`0 0 ${WIDTH} ${height}`}
            role="img"
            aria-label="Estate relationship graph"
          >
            {COLUMN_LABELS.map((text, i) => (
              <text
                key={text}
                x={(WIDTH / COLUMNS.length) * i + WIDTH / COLUMNS.length / 2}
                y={18}
                textAnchor="middle"
                fontSize={12}
                fill={INDIGO}
              >
                {text}
              </text>
            ))}
            {graph.edges.map((e) => {
              const a = positions.get(e.from);
              const b = positions.get(e.to);
              if (!a || !b) return null;
              const access = e.kind === 'read' || e.kind === 'write';
              return (
                <g key={e.id} data-edge={e.kind}>
                  <line
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={e.kind === 'read' ? TEAL : e.kind === 'write' ? INDIGO : GREY}
                    strokeWidth={access ? 2.5 : 1}
                    strokeDasharray={e.kind === 'contains' ? '4 4' : undefined}
                  />
                  {e.kind === 'write' && (
                    <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 4} fontSize={10} fill={INDIGO}>
                      🔒 WRITE
                    </text>
                  )}
                </g>
              );
            })}
            {graph.nodes.map((n) => {
              const p = positions.get(n.id)!;
              const active = n.id === selected;
              return (
                <g
                  key={n.id}
                  data-node={n.kind}
                  role="button"
                  tabIndex={0}
                  aria-label={`${n.kind} ${n.label}`}
                  onClick={() => setSelected(n.id)}
                  onKeyDown={(k) => (k.key === 'Enter' || k.key === ' ') && setSelected(n.id)}
                  style={{ cursor: 'pointer' }}
                >
                  <rect
                    x={p.x - 80}
                    y={p.y - 16}
                    width={160}
                    height={32}
                    rx={6}
                    fill="white"
                    stroke={active ? TEAL : n.kind === 'agent' ? INDIGO : GREY}
                    strokeWidth={active ? 2.5 : 1}
                  />
                  <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize={11} fill={INDIGO}>
                    {n.label.length > 24 ? `${n.label.slice(0, 23)}…` : n.label}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
        <Card className="lg:w-72" data-testid="graph-detail">
          <CardContent className="flex flex-col gap-2 pt-4 text-sm">
            {!node ? (
              <p>Select a node to see its details and relationships.</p>
            ) : (
              <NodeDetail node={node} related={related} label={label} />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function NodeDetail({
  node,
  related,
  label,
}: {
  node: GraphNode;
  related: ReturnType<typeof buildEstateGraph>['edges'];
  label: (id: string) => string;
}) {
  return (
    <>
      <div className="flex items-center gap-2">
        {node.kind === 'agent' && <AgentIcon agent={node.detail.agent ?? ''} size="sm" />}
        <p className="font-semibold">{node.label}</p>
      </div>
      <p className="text-xs uppercase">{node.kind}</p>
      {Object.entries(node.detail).map(([k, v]) => (
        <p key={k}>
          {k}: {v}
        </p>
      ))}
      <p className="font-semibold">Relationships</p>
      {related.length === 0 ? (
        <p data-testid="no-relationships">
          None{node.kind === 'agent' ? ' — this agent holds no client-system access.' : '.'}
        </p>
      ) : (
        <ul>
          {related.map((e) => (
            <li key={e.id}>
              {e.kind === 'write' ? 'WRITE' : e.kind} {label(e.from)} → {label(e.to)}
              {e.detail.expiresAt
                ? ` (expires ${new Date(e.detail.expiresAt).toLocaleDateString()})`
                : ''}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
