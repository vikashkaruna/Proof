import { describe, expect, it } from 'vitest';
import { buildEstateGraph, layout, type GraphInput } from './estate-graph';

const now = new Date('2026-09-24T00:00:00Z');
const future = '2026-12-01T00:00:00Z';
const input: GraphInput = {
  now,
  agents: ['drishti', 'karya', 'sudhaar'].map((name) => ({ name, displayName: name })),
  estates: [
    { id: 'e1', name: 'India', status: 'active' },
    { id: 'e2', name: 'Old', status: 'archived' },
  ],
  systems: [
    { id: 's1', estateId: 'e1', name: 'CRM', status: 'active', categories: ['contact'] },
    { id: 's2', estateId: 'e2', name: 'Legacy', status: 'active', categories: [] },
  ],
  connectors: [
    { id: 'c1', systemId: 's1', name: 'CRM reader', status: 'active', assurance: 'high' },
    { id: 'c2', systemId: 's2', name: 'Legacy', status: 'active', assurance: 'low' },
  ],
  grants: [
    {
      id: 'g1',
      connectorId: 'c1',
      agentName: 'drishti',
      scope: 'connector.read',
      expiresAt: future,
      revokedAt: null,
    },
    {
      id: 'g2',
      connectorId: 'c1',
      agentName: 'karya',
      scope: 'connector.write',
      expiresAt: future,
      revokedAt: null,
    },
    {
      id: 'g3',
      connectorId: 'c1',
      agentName: 'drishti',
      scope: 'connector.read',
      expiresAt: future,
      revokedAt: future,
    },
    {
      id: 'g4',
      connectorId: 'c1',
      agentName: 'karya',
      scope: 'connector.write',
      expiresAt: '2026-01-01T00:00:00Z',
      revokedAt: null,
    },
    {
      id: 'g5',
      connectorId: 'c2',
      agentName: 'drishti',
      scope: 'connector.read',
      expiresAt: future,
      revokedAt: null,
    },
  ],
};

describe('estate graph (W3.5)', () => {
  it('derives access edges only from active grants in active inventory', () => {
    const { nodes, edges } = buildEstateGraph(input);
    const access = edges.filter((e) => e.kind === 'read' || e.kind === 'write');
    expect(access.map((e) => e.id).sort()).toEqual(['grant:g1', 'grant:g2']);
    expect(nodes.some((n) => n.id === 'estate:e2' || n.id === 'system:s2')).toBe(false);
    expect(edges.find((e) => e.id === 'grant:g2')).toMatchObject({
      kind: 'write',
      from: 'agent:karya',
    });
  });

  it('keeps agents without grants as nodes with no edges', () => {
    const { nodes, edges } = buildEstateGraph(input);
    expect(nodes.some((n) => n.id === 'agent:sudhaar')).toBe(true);
    expect(edges.some((e) => e.from === 'agent:sudhaar')).toBe(false);
  });

  it('shows everything Karya can write to', () => {
    const { edges } = buildEstateGraph(input, { agentName: 'karya', access: 'write' });
    expect(edges.filter((e) => e.kind === 'write').map((e) => e.to)).toEqual(['connector:c1']);
    expect(edges.some((e) => e.kind === 'read')).toBe(false);
  });

  it('includes containment and declared categories, and lays out every node', () => {
    const { nodes, edges } = buildEstateGraph(input, { estateId: 'e1' });
    expect(edges.map((e) => e.id)).toEqual(
      expect.arrayContaining(['contains:e1:s1', 'contains:s1:c1', 'declares:s1:contact']),
    );
    const { positions } = layout(nodes);
    expect(positions.size).toBe(nodes.length);
  });
});
