import { expect, it, vi } from 'vitest';
import {
  createOwnedSyntheticController,
  type OwnedRpcClient,
} from './owned-synthetic-controller.js';
const id = (n: number) => `89150000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const context = {
  tenantId: id(1),
  actorId: id(2),
  expectedActorId: id(2),
  sessionId: id(3),
  idempotencyKey: id(4),
};
const binding = {
  id: id(5),
  tenantId: id(1),
  engagementId: id(6),
  fixtureId: id(7),
  resourceId: id(8),
  registeredEngineHash: 'a'.repeat(64),
  registeredCapabilitiesHash: 'b'.repeat(64),
  scope: 'owned_synthetic_config.audit_log_enable' as const,
  state: 'active' as const,
};
function fixture() {
  const human = vi.fn(
      async () => ({ data: { verified: true }, error: null }) as { data: unknown; error: unknown },
    ),
    target = vi.fn(
      async () =>
        ({ data: { measured: 'actual scoped RPC response' }, error: null }) as {
          data: unknown;
          error: unknown;
        },
    );
  const calls: {
    role: string;
    name: string;
    args: Record<string, unknown>;
    signal: AbortSignal;
  }[] = [];
  const client = (role: string, run: typeof human): OwnedRpcClient => ({
    rpc: (name, args) => ({
      abortSignal: (signal) => {
        calls.push({ role, name, args, signal });
        return run();
      },
    }),
  });
  const deps = createOwnedSyntheticController({
    humanWriterFactory: () => client('human_action_writer', human),
    targetControllerFactory: () => client('owned_target_controller', target),
    isKilled: vi.fn(async () => false),
  });
  return { deps, calls, human, target };
}
it('scoped measurement uses target role while human current authority uses human writer', async () => {
  const f = fixture(),
    ports = f.deps.planPorts(context);
  await ports.authorizeCurrent(context);
  await ports.validateRoundtrip(binding);
  expect(f.calls.map((c) => [c.role, c.name])).toEqual([
    ['human_action_writer', 'verify_owned_human_plan_authority'],
    ['owned_target_controller', 'measure_owned_synthetic_target'],
  ]);
  expect(f.calls[1]?.args).toEqual({
    p_tenant_id: id(1),
    p_binding_id: id(5),
    p_engagement_id: id(6),
  });
  expect(f.calls.every((c) => c.signal instanceof AbortSignal)).toBe(true);
});
it('human-role error does not turn into successful source verification', async () => {
  const f = fixture();
  f.human.mockResolvedValue({
    data: { verified: true },
    error: { message: 'database unavailable' },
  });
  await expect(f.deps.planPorts(context).authorizeCurrent(context)).rejects.toThrow(
    'source unavailable',
  );
  expect(f.target).not.toHaveBeenCalled();
});
it('declared-only current authority response is refused', async () => {
  const f = fixture();
  f.human.mockResolvedValue({ data: { verified: true, skipMfa: true }, error: null });
  await expect(f.deps.planPorts(context).authorizeCurrent(context)).rejects.toThrow();
});
it('target transport errors are refused, with no human result persistence', async () => {
  const f = fixture();
  f.target.mockResolvedValue({
    data: { success: true },
    error: { message: 'lost target response' },
  });
  await expect(f.deps.planPorts(context).validateRoundtrip(binding)).rejects.toThrow(
    'measurement unavailable',
  );
  expect(f.human).not.toHaveBeenCalled();
});
it('foreign tenant measurement makes zero credentialed target calls', async () => {
  const f = fixture();
  await expect(
    f.deps.planPorts(context).validateRoundtrip({ ...binding, tenantId: id(99) }),
  ).rejects.toThrow('tenant changed');
  expect(f.target).not.toHaveBeenCalled();
});
it('authority context cannot be switched after port binding', async () => {
  const f = fixture();
  await expect(
    f.deps.planPorts(context).authorizeCurrent({ ...context, actorId: id(99) }),
  ).rejects.toThrow('context changed');
  expect(f.human).not.toHaveBeenCalled();
});
it('stop verification uses distinct normal human stop authority RPC', async () => {
  const f = fixture();
  await f.deps.cancellationPorts(context).authorizeCurrentHuman(context);
  expect(f.calls[0]?.name).toBe('verify_owned_human_stop_authority');
  expect(f.target).not.toHaveBeenCalled();
});
it('cross-subject stop args are refused before writer use', async () => {
  const f = fixture();
  await expect(
    f.deps.cancellationPorts(context).cancelOriginalPendingRequest({
      p_tenant_id: id(1),
      p_actor_id: id(99),
      p_session_id: id(3),
      p_cancellation_key: id(4),
    }),
  ).rejects.toThrow('source changed');
  expect(f.human).not.toHaveBeenCalled();
});
it('source listing and recovery use only bounded known human RPCs, never target CAS', async () => {
  const f = fixture();
  await f.deps.readTargets(context, id(6));
  await f.deps.readOriginalOutcome(context, id(4), 'c'.repeat(64));
  expect(f.calls.map((c) => c.name)).toEqual([
    'read_owned_human_targets',
    'read_owned_human_request_outcome',
  ]);
  expect(f.target).not.toHaveBeenCalled();
});

it('effect observation uses current human authority RPC only, never an execution token or target credential', async () => {
  const f = fixture();
  const request = { operationKey: id(4), planId: id(10), actionId: id(11), batchId: id(12) };
  await f.deps.observeEffect?.(context, request);
  expect(f.calls.map((c) => [c.role, c.name])).toEqual([
    ['human_action_writer', 'observe_owned_execution_effect'],
  ]);
  expect(f.calls[0]?.args).toEqual({
    p_tenant_id: id(1),
    p_actor_id: id(2),
    p_session_id: id(3),
    p_operation_key: id(4),
    p_plan_id: id(10),
    p_action_id: id(11),
    p_batch_id: id(12),
  });
  expect(f.target).not.toHaveBeenCalled();
});
