export interface GraphSnapshot {
  tenantName: string;
  capturedAt: string;
}

const NS = 'http://www.w3.org/2000/svg';
const INDIGO = '#1E2A4A';
const TEAL = '#0FB5A5';
const SLATE = '#64748B';
const HEADER = 116;
const FOOTER = 84;

/** Adds provenance to the visible, filtered SVG using text nodes so tenant
 * names cannot inject markup. The exported artifact stays in the browser. */
export function serializeEstateGraph(
  visible: SVGSVGElement,
  snapshot: GraphSnapshot,
  filters: string,
): { source: string; width: number; height: number } {
  const width = Number(visible.getAttribute('width'));
  const graphHeight = Number(visible.getAttribute('height'));
  const height = graphHeight + HEADER + FOOTER;
  const root = document.createElementNS(NS, 'svg');
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));
  root.setAttribute('viewBox', `0 0 ${width} ${height}`);
  root.setAttribute('font-family', 'Arial, sans-serif');
  const title = document.createElementNS(NS, 'title');
  title.textContent = 'Axiom Proof — Estate relationship graph';
  root.append(title);
  const description = document.createElementNS(NS, 'desc');
  description.textContent = `${snapshot.tenantName}; snapshot ${snapshot.capturedAt}; view ${filters}`;
  root.append(description);
  const background = document.createElementNS(NS, 'rect');
  background.setAttribute('width', '100%');
  background.setAttribute('height', '100%');
  background.setAttribute('fill', '#ffffff');
  root.append(background);
  const text = (content: string, x: number, y: number, size = 12, fill = INDIGO) => {
    const element = document.createElementNS(NS, 'text');
    element.setAttribute('x', String(x));
    element.setAttribute('y', String(y));
    element.setAttribute('font-size', String(size));
    element.setAttribute('fill', fill);
    element.textContent = content;
    root.append(element);
  };
  text('AXIOM PROOF', 24, 28, 16);
  text('by Axiom Minds', 174, 28, 12, TEAL);
  text('Estate relationship graph', 24, 54, 20);
  text(
    snapshot.tenantName.length > 100 ? `${snapshot.tenantName.slice(0, 99)}…` : snapshot.tenantName,
    24,
    76,
  );
  text(`Snapshot: ${snapshot.capturedAt}`, 24, 96, 11, SLATE);
  const graph = visible.cloneNode(true) as SVGSVGElement;
  graph.removeAttribute('xmlns');
  graph.setAttribute('y', String(HEADER));
  graph.removeAttribute('role');
  graph.removeAttribute('aria-label');
  graph.querySelectorAll('[tabindex], [role]').forEach((node) => {
    node.removeAttribute('tabindex');
    node.removeAttribute('role');
  });
  root.append(graph);
  const baseline = HEADER + graphHeight;
  text(`View: ${filters}`, 24, baseline + 20, 11, SLATE);
  const legend = [
    { label: 'Contains', color: '#94A3B8', dashed: true },
    { label: 'Declares data', color: '#94A3B8', dashed: false },
    { label: 'Read grant', color: TEAL, dashed: false },
    { label: 'Write grant', color: INDIGO, dashed: false },
  ];
  legend.forEach((item, index) => {
    const x = 24 + index * 210;
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', String(x));
    line.setAttribute('x2', String(x + 28));
    line.setAttribute('y1', String(baseline + 41));
    line.setAttribute('y2', String(baseline + 41));
    line.setAttribute('stroke', item.color);
    line.setAttribute('stroke-width', '2');
    if (item.dashed) line.setAttribute('stroke-dasharray', '4 4');
    root.append(line);
    text(item.label, x + 36, baseline + 45, 11);
  });
  text(
    'Registration and recorded grants only; current connectivity is a separate check.',
    24,
    baseline + 68,
    11,
    SLATE,
  );
  return { source: new XMLSerializer().serializeToString(root), width, height };
}
