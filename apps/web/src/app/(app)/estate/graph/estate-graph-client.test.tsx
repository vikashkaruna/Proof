// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { EstateGraph } from './estate-graph-client';
import type { GraphInput } from '@/lib/estate-graph';

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
  vi.unstubAllGlobals();
  Reflect.deleteProperty(URL, 'createObjectURL');
  Reflect.deleteProperty(URL, 'revokeObjectURL');
});

it('renders only active grants and exposes a selected node through keyboard access', () => {
  const { container } = render(<EstateGraph input={input} />);
  expect(screen.getByTestId('graph-summary').textContent).toContain('1 write grants');
  expect(container.querySelectorAll('[data-edge="write"]')).toHaveLength(1);
  fireEvent.keyDown(screen.getByRole('button', { name: 'agent Sudhaar' }), { key: 'Enter' });
  expect(screen.getByTestId('no-relationships').textContent).toContain('None in this view');
});

it('filters to the selected agent and access type without inventing write authority', () => {
  const { container } = render(<EstateGraph input={input} />);
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
    <EstateGraph input={{ ...input, estates: [], systems: [], connectors: [], grants: [] }} />,
  );
  expect(screen.getByTestId('graph-summary').textContent).toContain('0 write grants');
  expect(container.querySelectorAll('[data-edge="write"]')).toHaveLength(0);
  expect(document.body.textContent).not.toContain('Payroll connector');
});

it('shows the exact recorded write relationship and expiry for the selected connector', () => {
  render(<EstateGraph input={input} />);
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
  render(<EstateGraph input={other} />);
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
  render(<EstateGraph input={other} />);
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
  render(<EstateGraph input={other} />);
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
  render(<EstateGraph input={input} />);
  fireEvent.click(screen.getByRole('button', { name: 'Export PNG' }));
  await vi.waitFor(() => expect(clicked).toEqual(['estate-graph.png']));
  expect(drawImage).toHaveBeenCalledOnce();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:svg-source');
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:png-result');
});
