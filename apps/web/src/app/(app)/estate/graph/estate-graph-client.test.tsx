// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { EstateGraph } from './estate-graph-client';
import type { GraphInput } from '@/lib/estate-graph';

const input: GraphInput = {
  now: new Date('2026-10-01T00:00:00Z'),
  agents: [{ name: 'karya', displayName: 'Karya' }, { name: 'sudhaar', displayName: 'Sudhaar' }],
  estates: [{ id: 'estate-1', name: 'Production estate', status: 'active' }],
  systems: [{ id: 'system-1', estateId: 'estate-1', name: 'Payroll', status: 'active', categories: ['identity'] }],
  connectors: [{ id: 'connector-1', systemId: 'system-1', name: 'Payroll connector', status: 'active', assurance: 'registered' }],
  grants: [
    { id: 'grant-1', connectorId: 'connector-1', agentName: 'karya', scope: 'connector.write', expiresAt: '2026-11-01T00:00:00Z', revokedAt: null },
    { id: 'grant-2', connectorId: 'connector-1', agentName: 'sudhaar', scope: 'connector.write', expiresAt: '2026-11-01T00:00:00Z', revokedAt: '2026-09-01T00:00:00Z' },
  ],
};
afterEach(cleanup);

it('renders only active grants and exposes a selected node through keyboard access', () => {
  const { container } = render(<EstateGraph input={input} />);
  expect(screen.getByTestId('graph-summary').textContent).toContain('1 write grants');
  expect(container.querySelectorAll('[data-edge="write"]')).toHaveLength(1);
  fireEvent.keyDown(screen.getByRole('button', { name: 'agent Sudhaar' }), { key: 'Enter' });
  expect(screen.getByTestId('no-relationships').textContent).toContain('no client-system access');
});

it('filters to the selected agent and access type without inventing write authority', () => {
  const { container } = render(<EstateGraph input={input} />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Agent filter' }), { target: { value: 'sudhaar' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Access filter' }), { target: { value: 'write' } });
  expect(screen.getByTestId('graph-summary').textContent).toContain('0 write grants');
  expect(container.querySelectorAll('[data-edge="write"]')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Everything Karya can write to' }));
  expect(screen.getByTestId('graph-summary').textContent).toContain('1 write grants');
});

it('shows no access relationships in an empty estate', () => {
  const { container } = render(<EstateGraph input={{ ...input, estates: [], systems: [], connectors: [], grants: [] }} />);
  expect(screen.getByTestId('graph-summary').textContent).toContain('0 write grants');
  expect(container.querySelectorAll('[data-edge="write"]')).toHaveLength(0);
  expect(document.body.textContent).not.toContain('Payroll connector');
});
