// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { EstateGraph } from './estate-graph-client';
import type { GraphInput } from '@/lib/estate-graph';

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
  expect(exported.documentElement.textContent).toContain('AXIOM PROOF');
  expect(exported.documentElement.textContent).toContain(snapshot.tenantName);
  expect(exported.querySelector('[onload]')).toBeNull();
  expect(source).toContain(`Snapshot: ${snapshot.capturedAt}`);
  expect(source).toContain('View: Production estate · All agents · Read and write');
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
