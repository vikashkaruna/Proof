import { beforeEach, expect, it, vi } from 'vitest';
import { loadEnv, resetEnvCache } from '@axiom/config';
import { ApprovalEngine } from '@axiom/approval-engine';
const state = vi.hoisted(() => ({
  agentRpc: vi.fn(),
  adminRpc: vi.fn(),
  agent: vi.fn(),
  admin: vi.fn(),
}));
vi.mock('@axiom/supabase', () => ({
  createSupabaseAdmin: state.admin,
  createAgentLedgerWriter: state.agent,
}));
import { createConfiguredStandingCoordinator } from './standing-composition.js';
function env() {
  resetEnvCache();
  return loadEnv({
    NODE_ENV: 'test',
    ENVIRONMENT: 'local',
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_ANON_KEY: 'a'.repeat(40),
    SUPABASE_SERVICE_KEY: 'b'.repeat(40),
  });
}
beforeEach(() => {
  state.agent.mockReset().mockReturnValue({ rpc: state.agentRpc });
  state.admin.mockReset().mockReturnValue({ rpc: state.adminRpc });
  state.agentRpc
    .mockReset()
    .mockImplementation(() => ({ abortSignal: async () => ({ data: { work: [] }, error: null }) }));
  state.adminRpc.mockReset();
});
it('does not create privileged clients or a background loop when disabled', () => {
  expect(createConfiguredStandingCoordinator(env(), new ApprovalEngine())).toBeNull();
  expect(state.agent).not.toHaveBeenCalled();
  expect(state.admin).not.toHaveBeenCalled();
});
it('technical polling uses only the existing scoped agent writer, not the broad read client', async () => {
  const coordinator = createConfiguredStandingCoordinator(
    { ...env(), AXIOM_STANDING_POLICY_COORDINATOR_ENABLED: 'true' },
    new ApprovalEngine(),
  );
  expect(coordinator).not.toBeNull();
  expect(state.agent).toHaveBeenCalledOnce();
  await coordinator!.once();
  expect(state.agentRpc).toHaveBeenCalledWith('reserve_standing_policy_work', {});
  expect(state.adminRpc).not.toHaveBeenCalled();
  expect(coordinator!.health().phase).toBe('idle');
});
it('refuses a direct misconfigured deployment even before creating clients', () => {
  expect(() =>
    createConfiguredStandingCoordinator(
      { ...env(), ENVIRONMENT: 'production', AXIOM_STANDING_POLICY_COORDINATOR_ENABLED: 'true' },
      new ApprovalEngine(),
    ),
  ).toThrow(/deployment refused/);
  expect(state.agent).not.toHaveBeenCalled();
  expect(state.admin).not.toHaveBeenCalled();
});
it('an enabled deployment without its existing agent credential fails closed', () => {
  state.agent.mockImplementationOnce(() => {
    throw Error('Existing agent writer unavailable');
  });
  expect(() =>
    createConfiguredStandingCoordinator(
      { ...env(), AXIOM_STANDING_POLICY_COORDINATOR_ENABLED: 'true' },
      new ApprovalEngine(),
    ),
  ).toThrow(/writer unavailable/);
});
