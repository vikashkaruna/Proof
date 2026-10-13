import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ role: 'owner', internal: false }));
vi.mock('@/lib/tenant-context', () => ({
  requireTenantContext: async () => ({ role: state.role, isAxiomInternal: state.internal }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
import StartPage from './page';

beforeEach(() => {
  state.role = 'owner';
  state.internal = false;
});

it('opens the Workbench for the internal founder, as a relative redirect', async () => {
  state.role = 'founder';
  state.internal = true;
  await expect(StartPage()).rejects.toThrow('redirect:/workbench');
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
  await expect(StartPage()).rejects.toThrow('redirect:/portal');
});
