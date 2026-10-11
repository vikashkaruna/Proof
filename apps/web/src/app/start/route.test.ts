import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({ role: 'owner', internal: false }));
vi.mock('@/lib/tenant-context', () => ({
  requireTenantContext: async () => ({ role: state.role, isAxiomInternal: state.internal }),
}));
import { GET } from './route';

const land = async () =>
  new URL((await GET(new NextRequest('http://app.test/start'))).headers.get('location')!).pathname;

beforeEach(() => {
  state.role = 'owner';
  state.internal = false;
});

it('opens the Workbench for the internal founder', async () => {
  state.role = 'founder';
  state.internal = true;
  expect(await land()).toBe('/workbench');
});

it.each([
  ['founder', false],
  ['axiom_analyst', true],
  ['owner', false],
  ['admin', false],
  ['approver', false],
  ['reviewer', false],
  ['viewer', false],
])('opens the Client Portal for %s (internal=%s)', async (role, internal) => {
  state.role = role;
  state.internal = internal;
  expect(await land()).toBe('/portal');
});
