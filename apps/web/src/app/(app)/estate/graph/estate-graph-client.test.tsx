// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { EstateGraph } from './estate-graph-client';
import type { GraphInput } from '@/lib/estate-graph';
import { serializeEstateGraph } from '@/lib/estate-graph-export';

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
const snapshot = {
  tenantName: 'Test company <svg onload="bad">',
  capturedAt: '2026-10-01T00:00:00.000Z',
};

const input: GraphInput = {
  now: new Date('2026-10-01T00:00:00Z'),
  agents: [
    { name: 'karya', displayName: 'Karya' },
    { name: 'sudhaar', displayName: 'Sudhaar' },
  ],
  estates: [{ id: 'estate-1', name: 'Production estate', status: 'active' }],
  systems: [
    {
      id: 'system-1',
      estateId: 'estate-1',
      name: 'Payroll',
      status: 'active',
      categories: ['identity'],
    },
  ],
  connectors: [
    {
      id: 'connector-1',
      systemId: 'system-1',
      name: 'Payroll connector',
      status: 'active',
      assurance: 'registered',
    },
  ],
  grants: [
    {
      id: 'grant-1',
      connectorId: 'connector-1',
      agentName: 'karya',
      scope: 'connector.write',
      expiresAt: '2026-11-01T00:00:00Z',
      revokedAt: null,
    },
    {
      id: 'grant-2',
      connectorId: 'connector-1',
      agentName: 'sudhaar',
      scope: 'connector.write',
      expiresAt: '2026-11-01T00:00:00Z',
      revokedAt: '2026-09-01T00:00:00Z',
    },
  ],
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  refresh.mockClear();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(URL, 'createObjectURL');
  Reflect.deleteProperty(URL, 'revokeObjectURL');
});

it('renders only active grants and exposes a selected node through keyboard access', () => {
  const { container } = render(<EstateGraph snapshot={snapshot} input={input} />);
  expect(screen.getByTestId('graph-summary').textContent).toContain('1 write grants');
  expect(container.querySelectorAll('[data-edge="write"]')).toHaveLength(1);
  fireEvent.keyDown(screen.getByRole('button', { name: 'agent Sudhaar' }), { key: 'Enter' });
  expect(screen.getByTestId('no-relationships').textContent).toContain('None in this view');
});

function crossesBoxInterior(line: Element, box: Element) {
  return segmentCrossesBoxInterior(
    ['x1', 'y1', 'x2', 'y2'].map((name) => Number(line.getAttribute(name))) as [
      number,
      number,
      number,
      number,
    ],
    box,
  );
}

function segmentCrossesBoxInterior([x, y, x2, y2]: [number, number, number, number], box: Element) {
  const value = (element: Element, name: string) => Number(element.getAttribute(name));
  const dx = x2 - x;
  const dy = y2 - y;
  const inset = 0.001; // Border contact alone does not intersect the box interior.
  const left = value(box, 'x') + inset;
  const right = value(box, 'x') + value(box, 'width') - inset;
  const top = value(box, 'y') + inset;
  const bottom = value(box, 'y') + value(box, 'height') - inset;
  let entering = 0;
  let leaving = 1;
  const boundaries: [number, number][] = [
    [-dx, x - left],
    [dx, right - x],
    [-dy, y - top],
    [dy, bottom - y],
  ];
  for (const [direction, distance] of boundaries) {
    if (direction === 0) {
      if (distance < 0) return false;
    } else if (direction < 0) entering = Math.max(entering, distance / direction);
    else leaving = Math.min(leaving, distance / direction);
  }
  return entering <= leaving;
}

it.each(['write', 'read'] as const)(
  'keeps the rendered %s grant between columns without crossing ungranted agent boxes',
  (access) => {
    const multipleAgents: GraphInput = {
      ...input,
      agents: [
        ...Array.from({ length: 9 }, (_, index) => ({
          name: `ungranted-${index}`,
          displayName: `No grant ${index}`,
        })),
        input.agents[0]!,
      ],
      connectors: [
        input.connectors[0]!,
        ...Array.from({ length: 9 }, (_, index) => ({
          ...input.connectors[0]!,
          id: `ungranted-connector-${index}`,
          name: `No grant connector ${index}`,
        })),
      ],
      grants: [{ ...input.grants[0]!, scope: `connector.${access}` }],
    };
    const { container } = render(<EstateGraph snapshot={snapshot} input={multipleAgents} />);
    const line = container.querySelector(`[data-edge="${access}"] line`)!;
    expect(line).not.toBeNull();
    expect(container.querySelectorAll('[data-edge="write"]')).toHaveLength(
      access === 'write' ? 1 : 0,
    );
    const agentBox = screen.getByRole('button', { name: 'agent Karya' }).querySelector('rect')!;
    const connectorBox = screen
      .getByRole('button', { name: 'connector Payroll connector' })
      .querySelector('rect')!;
    const ungrantedBoxes = Array.from(
      container.querySelectorAll('[data-node="agent"] rect'),
    ).filter((box) => box !== agentBox);
    expect(ungrantedBoxes).toHaveLength(9);
    for (const box of ungrantedBoxes) {
      expect(crossesBoxInterior(line, box), 'a grant line crosses an ungranted agent').toBe(false);
    }
    const ungrantedConnectors = Array.from(
      container.querySelectorAll('[data-node="connector"] rect'),
    ).filter((box) => box !== connectorBox);
    expect(ungrantedConnectors).toHaveLength(9);
    for (const box of ungrantedConnectors) {
      expect(crossesBoxInterior(line, box), 'a grant line crosses an ungranted connector').toBe(
        false,
      );
    }
    expect(Number(line.getAttribute('x1'))).toBe(
      Number(agentBox.getAttribute('x')) + Number(agentBox.getAttribute('width')),
    );
    expect(Number(line.getAttribute('x2'))).toBe(Number(connectorBox.getAttribute('x')));
    expect(Number(line.getAttribute('y1'))).toBe(
      Number(agentBox.getAttribute('y')) + Number(agentBox.getAttribute('height')) / 2,
    );
    expect(Number(line.getAttribute('y2'))).toBe(
      Number(connectorBox.getAttribute('y')) + Number(connectorBox.getAttribute('height')) / 2,
    );
    if (access === 'write') {
      const marker = container.querySelector('[data-edge="write"] text')!;
      const center = Number(marker.getAttribute('x'));
      const width = Number(marker.getAttribute('textLength'));
      expect(marker.textContent).toContain('WRITE');
      expect(marker.getAttribute('text-anchor')).toBe('middle');
      expect(width).toBeGreaterThan(0);
      expect(center - width / 2).toBeGreaterThan(Number(line.getAttribute('x1')));
      expect(center + width / 2).toBeLessThan(Number(line.getAttribute('x2')));
    }
    const visible = container.querySelector('svg')!;
    const exported = new DOMParser().parseFromString(
      serializeEstateGraph(visible, snapshot, 'All agents').source,
      'image/svg+xml',
    );
    const exportedLine = exported.querySelector(`[data-edge="${access}"] line`)!;
    for (const coordinate of ['x1', 'y1', 'x2', 'y2']) {
      expect(exportedLine.getAttribute(coordinate)).toBe(line.getAttribute(coordinate));
    }
    fireEvent.click(screen.getByRole('button', { name: 'agent No grant 4' }));
    expect(screen.getByTestId('no-relationships').textContent).toContain('None in this view');
  },
);

const manyRows: GraphInput = {
  ...input,
  systems: [
    input.systems[0]!,
    ...Array.from({ length: 9 }, (_, index) => ({
      ...input.systems[0]!,
      id: `other-system-${index}`,
      name: `Other system ${index}`,
    })),
  ],
  connectors: [
    input.connectors[0]!,
    ...Array.from({ length: 9 }, (_, index) => ({
      ...input.connectors[0]!,
      id: `other-connector-${index}`,
      name: `Other connector ${index}`,
    })),
  ],
};

it('keeps reverse containment and mismatched adjacent rows outside unrelated node boxes', () => {
  const { container } = render(<EstateGraph snapshot={snapshot} input={manyRows} />);
  const lines = container.querySelectorAll('[data-edge="contains"] line');
  expect(lines).toHaveLength(20);
  const cases = [
    {
      line: lines[9]!,
      source: screen
        .getByRole('button', { name: 'estate Production estate' })
        .querySelector('rect')!,
      target: screen.getByRole('button', { name: 'system Other system 8' }).querySelector('rect')!,
    },
    {
      line: lines[19]!,
      source: screen.getByRole('button', { name: 'system Payroll' }).querySelector('rect')!,
      target: screen
        .getByRole('button', { name: 'connector Other connector 8' })
        .querySelector('rect')!,
    },
  ];
  for (const { line, source, target } of cases) {
    for (const box of container.querySelectorAll('[data-node] rect')) {
      if (box === source || box === target) continue;
      expect(crossesBoxInterior(line, box), 'containment crosses an unrelated node').toBe(false);
    }
    // Both recorded relationship directions here travel right-to-left.
    expect(Number(line.getAttribute('x1'))).toBe(Number(source.getAttribute('x')));
    expect(Number(line.getAttribute('x2'))).toBe(
      Number(target.getAttribute('x')) + Number(target.getAttribute('width')),
    );
    expect(line.getAttribute('stroke-dasharray')).toBe('4 4');
  }
});

it('routes declarations below nodes without suggesting an intermediate estate relationship', () => {
  const { container } = render(<EstateGraph snapshot={snapshot} input={manyRows} />);
  const svg = container.querySelector('svg')!;
  const boxes = Array.from(container.querySelectorAll('[data-node] rect'));
  const bottom = Math.max(
    ...boxes.map((box) => Number(box.getAttribute('y')) + Number(box.getAttribute('height'))),
  );
  const declarations = container.querySelectorAll('[data-edge="declares"] polyline');
  expect(declarations).toHaveLength(10);
  for (const declaration of declarations) {
    const points = declaration
      .getAttribute('points')!
      .trim()
      .split(/\s+/)
      .map((point) => point.split(',').map(Number) as [number, number]);
    for (let index = 1; index < points.length; index++) {
      const from = points[index - 1]!;
      const to = points[index]!;
      for (const box of boxes) {
        expect(
          segmentCrossesBoxInterior([from[0], from[1], to[0], to[1]], box),
          'declaration crosses a node instead of using the empty lane',
        ).toBe(false);
      }
    }
    expect(points).toHaveLength(6);
    expect(points[2]![1]).toBeGreaterThan(bottom);
    expect(points[3]![1]).toBe(points[2]![1]);
    expect(points[2]![1]).toBeLessThan(Number(svg.getAttribute('height')));
  }
  const exported = new DOMParser().parseFromString(
    serializeEstateGraph(svg, snapshot, 'All active estates').source,
    'image/svg+xml',
  );
  expect(
    Array.from(exported.querySelectorAll('[data-edge="declares"] polyline'), (edge) =>
      edge.getAttribute('points'),
    ),
  ).toEqual(Array.from(declarations, (edge) => edge.getAttribute('points')));
  expect(exported.querySelectorAll('[data-edge="contains"]')).toHaveLength(20);
});

it('filters to the selected agent and access type without inventing write authority', () => {
  const { container } = render(<EstateGraph snapshot={snapshot} input={input} />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Agent filter' }), {
    target: { value: 'sudhaar' },
  });
  fireEvent.change(screen.getByRole('combobox', { name: 'Access filter' }), {
    target: { value: 'write' },
  });
  expect(screen.getByTestId('graph-summary').textContent).toContain('0 write grants');
  expect(container.querySelectorAll('[data-edge="write"]')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Everything Karya can write to' }));
  expect(screen.getByTestId('graph-summary').textContent).toContain('1 write grants');
});

it('shows no access relationships in an empty estate', () => {
  const { container } = render(
    <EstateGraph
      snapshot={snapshot}
      input={{ ...input, estates: [], systems: [], connectors: [], grants: [] }}
    />,
  );
  expect(screen.getByTestId('graph-summary').textContent).toContain('0 write grants');
  expect(container.querySelectorAll('[data-edge="write"]')).toHaveLength(0);
  expect(document.body.textContent).not.toContain('Payroll connector');
});

it('shows the exact recorded write relationship and expiry for the selected connector', () => {
  render(<EstateGraph snapshot={snapshot} input={input} />);
  fireEvent.click(screen.getByRole('button', { name: 'connector Payroll connector' }));
  const detail = screen.getByTestId('graph-detail');
  expect(detail.textContent).toContain('WRITE Karya → Payroll connector');
  expect(detail.textContent).toContain('expires');
  expect(detail.textContent).not.toContain('WRITE Sudhaar');
});

it('filters to one estate without leaking another estate or its system names', () => {
  const other = {
    ...input,
    estates: [
      ...input.estates,
      { id: 'estate-2', name: 'Other estate', status: 'active' as const },
    ],
    systems: [
      ...input.systems,
      {
        id: 'system-2',
        estateId: 'estate-2',
        name: 'Other payroll',
        status: 'active' as const,
        categories: ['identity'],
      },
    ],
  };
  render(<EstateGraph snapshot={snapshot} input={other} />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Estate filter' }), {
    target: { value: 'estate-1' },
  });
  expect(screen.getByRole('button', { name: 'system Payroll' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'system Other payroll' })).toBeNull();
});

it('does not claim global absence of access when another estate has a valid grant', () => {
  const other: GraphInput = {
    ...input,
    estates: [
      ...input.estates,
      { id: 'estate-2', name: 'Second estate', status: 'active' as const },
    ],
    systems: [
      ...input.systems,
      {
        id: 'system-2',
        estateId: 'estate-2',
        name: 'Second payroll',
        status: 'active' as const,
        categories: ['identity'],
      },
    ],
    connectors: [
      ...input.connectors,
      {
        id: 'connector-2',
        systemId: 'system-2',
        name: 'Second connector',
        status: 'active' as const,
        assurance: 'registered' as const,
      },
    ],
    grants: [
      ...input.grants,
      {
        id: 'grant-3',
        connectorId: 'connector-2',
        agentName: 'sudhaar',
        scope: 'connector.read',
        expiresAt: '2026-11-01T00:00:00Z',
        revokedAt: null,
      },
    ],
  };
  render(<EstateGraph snapshot={snapshot} input={other} />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Estate filter' }), {
    target: { value: 'estate-1' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'agent Sudhaar' }));
  expect(screen.getByTestId('no-relationships').textContent).toContain('None in this view');
  expect(document.body.textContent).not.toContain('holds no client-system access');
  expect(screen.getByTestId('graph-summary').textContent).toContain(
    'Other estates or filters may have additional grants.',
  );
});

it('exports only the filtered, visible graph to a local SVG download', async () => {
  const other: GraphInput = {
    ...input,
    estates: [...input.estates, { id: 'estate-2', name: 'Other estate', status: 'active' }],
    systems: [
      ...input.systems,
      {
        id: 'system-2',
        estateId: 'estate-2',
        name: 'Other payroll',
        status: 'active',
        categories: [],
      },
    ],
  };
  const blobs: Blob[] = [];
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:local-graph';
    }),
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  render(<EstateGraph snapshot={snapshot} input={other} />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Estate filter' }), {
    target: { value: 'estate-1' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Export SVG' }));
  expect(click).toHaveBeenCalledOnce();
  expect(blobs).toHaveLength(1);
  const source = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blobs[0]!);
  });
  expect(source).toContain('Payroll');
  const exported = new DOMParser().parseFromString(source, 'image/svg+xml');
  expect(exported.querySelector('parsererror')).toBeNull();
  const visibleText = Array.from(exported.querySelectorAll('text'), (node) => node.textContent);
  expect(visibleText).toContain('AXIOM PROOF');
  expect(visibleText).toContain(snapshot.tenantName);
  expect(exported.querySelector('[onload]')).toBeNull();
  expect(visibleText).toContain(`Snapshot: ${snapshot.capturedAt}`);
  expect(visibleText).toContain('View: Production estate · All agents · Read and write');
  expect(source).toContain('Read grant');
  expect(source).toContain('Write grant');
  expect(source).not.toContain('Other payroll');
  expect(source).not.toContain('Other estate');
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-graph');
});

it('rasterizes the visible graph locally and releases both temporary object URLs', async () => {
  const urls = ['blob:svg-source', 'blob:png-result'];
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => urls.shift()),
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  const clicked: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push(this.download);
  });
  vi.stubGlobal(
    'Image',
    class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillStyle: '',
    fillRect: vi.fn(),
    scale: vi.fn(),
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
    callback(new Blob(['png'], { type: 'image/png' }));
  });
  render(<EstateGraph snapshot={snapshot} input={input} />);
  fireEvent.click(screen.getByRole('button', { name: 'Export PNG' }));
  await vi.waitFor(() => expect(clicked).toEqual(['estate-graph.png']));
  expect(drawImage).toHaveBeenCalledOnce();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:svg-source');
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:png-result');
});

it('refreshes visible data on demand and return, preserves filters, and stops polling after unmount', () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, 'visibilityState', 'get');
  visibility.mockReturnValue('visible');
  const { unmount } = render(<EstateGraph snapshot={snapshot} input={input} />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Estate filter' }), {
    target: { value: 'estate-1' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh graph' }));
  expect(refresh).toHaveBeenCalledTimes(1);
  expect((screen.getByRole('combobox', { name: 'Estate filter' }) as HTMLSelectElement).value).toBe(
    'estate-1',
  );
  visibility.mockReturnValue('hidden');
  act(() => vi.advanceTimersByTime(60_000));
  expect(refresh).toHaveBeenCalledTimes(1);
  visibility.mockReturnValue('visible');
  fireEvent(window, new Event('focus'));
  act(() => vi.advanceTimersByTime(60_000));
  expect(refresh).toHaveBeenCalledTimes(3);
  unmount();
  fireEvent(window, new Event('focus'));
  act(() => vi.advanceTimersByTime(60_000));
  expect(refresh).toHaveBeenCalledTimes(3);
});

it('reports PNG conversion failure and releases its temporary SVG', async () => {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:failed-svg'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.stubGlobal(
    'Image',
    class {
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    },
  );
  render(<EstateGraph snapshot={snapshot} input={input} />);
  fireEvent.click(screen.getByRole('button', { name: 'Export PNG' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Try the SVG export');
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:failed-svg');
});

it('removes expired access while the graph is open and reflects revocation on refreshed data', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(snapshot.capturedAt));
  const shortLived = {
    ...input,
    grants: [{ ...input.grants[0]!, expiresAt: '2026-10-01T00:00:01.000Z' }],
  };
  const { container, rerender } = render(<EstateGraph snapshot={snapshot} input={shortLived} />);
  expect(container.querySelectorAll('[data-edge="write"]')).toHaveLength(1);
  act(() => vi.advanceTimersByTime(1001));
  expect(container.querySelectorAll('[data-edge="write"]')).toHaveLength(0);
  rerender(<EstateGraph snapshot={snapshot} input={input} />);
  expect(container.querySelectorAll('[data-edge="write"]')).toHaveLength(1);
  rerender(
    <EstateGraph
      snapshot={snapshot}
      input={{
        ...input,
        grants: input.grants.map((g) => ({ ...g, revokedAt: '2026-10-01T00:00:01.000Z' })),
      }}
    />,
  );
  expect(container.querySelectorAll('[data-edge="write"]')).toHaveLength(0);
});
it('shows narrow approved derivation and a safe source link without changing graph topology', () => {
  const provenance = {
    state: 'available' as const,
    bySystem: {
      'system-1': {
        state: 'recorded' as const,
        proposalId: '10000000-0000-4000-8000-000000000004',
        sourceIndex: 0,
        contentSha256: 'a'.repeat(64),
        reviewReceiptId: '123',
        reviewedAt: '2026-10-19T00:00:00Z',
        sourceHref: '/estate/onboarding#proposal-10000000-0000-4000-8000-000000000004',
      },
    },
  };
  const { container, rerender } = render(
    <EstateGraph snapshot={snapshot} input={{ ...input, provenance }} />,
  );
  const nodes = container.querySelectorAll('[data-node]').length,
    edges = container.querySelectorAll('[data-edge]').length;
  fireEvent.click(screen.getByRole('button', { name: 'system Payroll' }));
  expect(screen.getByText(/intake item 1 → this system/)).toBeTruthy();
  expect(screen.getByText(/Approval receipt 123/)).toBeTruthy();
  expect(
    screen.getByRole('link', { name: 'Open approved onboarding source' }).getAttribute('href'),
  ).toBe(provenance.bySystem['system-1'].sourceHref);
  expect(
    screen.getByText(/Current configuration, connectivity and data transfers are not established/),
  ).toBeTruthy();
  rerender(
    <EstateGraph
      snapshot={snapshot}
      input={{
        ...input,
        provenance: { state: 'unavailable', bySystem: { 'system-1': { state: 'unavailable' } } },
      }}
    />,
  );
  expect(screen.queryByRole('link', { name: 'Open approved onboarding source' })).toBeNull();
  expect(screen.getByText(/Creation provenance is unavailable/)).toBeTruthy();
  expect(container.querySelectorAll('[data-node]')).toHaveLength(nodes);
  expect(container.querySelectorAll('[data-edge]')).toHaveLength(edges);
});
it('keeps readable approved metadata for read-only readers without an unavailable source link', () => {
  render(
    <EstateGraph
      snapshot={snapshot}
      input={{
        ...input,
        provenance: {
          state: 'available',
          bySystem: {
            'system-1': {
              state: 'recorded',
              proposalId: '10000000-0000-4000-8000-000000000004',
              sourceIndex: 0,
              contentSha256: 'a'.repeat(64),
              reviewReceiptId: '123',
              reviewedAt: '2026-10-19T00:00:00Z',
              sourceHref: null,
            },
          },
        },
      }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'system Payroll' }));
  expect(screen.getByText(/Approval receipt 123/)).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Open approved onboarding source' })).toBeNull();
});
it('shows actual recorded category source in relationships, and does not invent a source for old data', () => {
  render(
    <EstateGraph
      snapshot={snapshot}
      input={{
        ...input,
        systems: [
          { ...input.systems[0]!, categoryOrigins: [{ category: 'identity', source: 'observed' }] },
        ],
      }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'system Payroll' }));
  expect(screen.getByTestId('graph-detail').textContent).toContain(
    'Recorded as observed (scan evidence not linked)',
  );
  expect(screen.getByTestId('graph-detail').textContent).toContain(
    'Creation provenance is unavailable',
  );
});
it('exposes historical inventory only with server-verified founder visibility and immediately removes it when authority changes', () => {
  const historical = structuredClone(input);
  historical.estates.push({ id: 'old-estate', name: 'Archived estate', status: 'archived' });
  historical.systems.push({
    id: 'old-system',
    estateId: 'old-estate',
    name: 'Archived system',
    status: 'archived',
    categories: [],
  });
  const view = render(<EstateGraph input={historical} snapshot={snapshot} canViewInactive />);
  expect(
    (screen.getByRole('combobox', { name: 'Inventory visibility' }) as HTMLSelectElement).value,
  ).toBe('all');
  expect(screen.getByRole('button', { name: 'estate Archived estate' })).not.toBeNull();
  fireEvent.change(screen.getByRole('combobox', { name: 'Inventory visibility' }), {
    target: { value: 'active' },
  });
  expect(screen.queryByRole('button', { name: 'estate Archived estate' })).toBeNull();
  fireEvent.change(screen.getByRole('combobox', { name: 'Inventory visibility' }), {
    target: { value: 'all' },
  });
  view.rerender(<EstateGraph input={historical} snapshot={snapshot} canViewInactive={false} />);
  expect(screen.queryByRole('combobox', { name: 'Inventory visibility' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'estate Archived estate' })).toBeNull();
});
