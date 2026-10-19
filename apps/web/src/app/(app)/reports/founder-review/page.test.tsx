import { beforeEach, expect, it, vi } from 'vitest';
import { UserRole } from '@axiom/types';
import Page from './page';
const state = vi.hoisted(() => ({
  role: 'founder',
  internal: true,
  live: true,
  error: null as unknown,
  context: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock('@/lib/tenant-context', () => ({ requireCapabilityContext: state.context }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw Error(to);
  },
}));
beforeEach(() => {
  state.role = 'founder';
  state.internal = true;
  state.live = true;
  state.error = null;
  state.rpc
    .mockReset()
    .mockImplementation(() => ({
      abortSignal: async () => ({ data: state.live, error: state.error }),
    }));
  state.context
    .mockReset()
    .mockImplementation(async () => ({
      tenantId: 'tenant',
      userId: 'actor',
      tenantName: 'Selected organization',
      role: state.role,
      isAxiomInternal: state.internal,
      supabase: { rpc: state.rpc },
    }));
});
it.each([
  UserRole.OWNER,
  UserRole.ADMIN,
  UserRole.REVIEWER,
  UserRole.VIEWER,
  UserRole.AXIOM_ANALYST,
])(
  'refuses direct workspace access for %s even if a client can forge a menu flag',
  async (role) => {
    state.role = role;
    await expect(Page()).rejects.toThrow('/reports?error=founder_required');
    expect(state.rpc).not.toHaveBeenCalled();
  },
);
it('refuses former-live explicit founder labels, noninternal profiles and RPC failures', async () => {
  state.live = false;
  await expect(Page()).rejects.toThrow('founder_required');
  state.live = true;
  state.internal = false;
  await expect(Page()).rejects.toThrow('founder_required');
  state.internal = true;
  state.error = { message: 'unavailable' };
  await expect(Page()).rejects.toThrow('founder_required');
});
it('binds the live founder workspace to only the selected organization and authenticated actor', async () => {
  const result = await Page();
  expect(state.context).toHaveBeenCalledWith('workbench.access');
  expect(result.key).toBe('tenant:actor');
  expect(result.props).toEqual({
    tenantId: 'tenant',
    actorId: 'actor',
    tenantName: 'Selected organization',
  });
});
