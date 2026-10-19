import { beforeEach, expect, it, vi } from 'vitest';
import Page from './page';
const state = vi.hoisted(() => ({ context: vi.fn() }));
vi.mock('@/lib/tenant-context', () => ({
  Capability: { PLAN_APPROVE: 'plan.approve' },
  requireCapabilityContext: state.context,
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(to);
  },
}));
beforeEach(() => state.context.mockReset());
it('requires plan approval capability and excludes viewer, reviewer and analyst routes', async () => {
  for (const role of ['viewer', 'reviewer', 'analyst']) {
    state.context.mockResolvedValue({ role, tenantId: 'tenant', userId: 'actor' });
    await expect(Page()).rejects.toThrow('/portal?error=forbidden');
  }
  expect(state.context).toHaveBeenCalledWith('plan.approve');
});
it('keys the client by current actor and tenant but leaves readiness to actual server context', async () => {
  state.context.mockResolvedValue({ role: 'owner', tenantId: 'tenant', userId: 'actor' });
  const element = await Page();
  expect(element.key).toBe('tenant:actor');
  expect(element.props).toEqual({ tenantId: 'tenant', actorId: 'actor' });
});
