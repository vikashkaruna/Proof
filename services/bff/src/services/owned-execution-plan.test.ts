import { describe, expect, it, vi } from 'vitest';
import {
  ownedHash,
  produceOwnedMeasuredPlan,
  type OwnedPlanPorts,
  type OwnedPlanReceipt,
} from './owned-execution-plan.js';
const id = (n: number) => `89110000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
  const context = {
    tenantId: id(1),
    actorId: id(2),
    expectedActorId: id(2),
    sessionId: id(3),
    idempotencyKey: id(6),
  };
  const before = { fixture_id: id(4), resource_id: id(5), version: 0, audit_log_enabled: false };
  const request = {
    operationKey: id(6),
    bindingId: id(7),
    engagementId: id(8),
    expectedSnapshotHash: ownedHash(before),
    reason: 'Enable audit logging on my owned disposable fixture only.',
    acknowledgeOwnedSynthetic: true,
    actionType: 'config.audit_log_enable',
    desiredEnabled: true,
  };
  const binding = {
    id: id(7),
    tenantId: id(1),
    engagementId: id(8),
    fixtureId: id(4),
    resourceId: id(5),
    registeredEngineHash: 'a'.repeat(64),
    registeredCapabilitiesHash: ownedHash([
      'atomic_exact_operation_journal',
      'version_and_snapshot_cas',
      'no_write_roundtrip',
    ]),
    scope: 'owned_synthetic_config.audit_log_enable',
    state: 'active',
  };
  const validation = {
    engine: {
      engine: 'owned_boolean_cas_v1',
      implementation_sha256: 'a'.repeat(64),
      capability_sha256: ownedHash([
        'atomic_exact_operation_journal',
        'version_and_snapshot_cas',
        'no_write_roundtrip',
      ]),
      capabilities: [
        'atomic_exact_operation_journal',
        'version_and_snapshot_cas',
        'no_write_roundtrip',
      ],
    },
    before,
    projected_after: { ...before, version: 1, audit_log_enabled: true },
    restored: { ...before, version: 2 },
    persistent_mutations: 0,
    resources_measured: 1,
  };
  const requestHash = ownedHash({ tenantId: context.tenantId, actorId: context.actorId, request });
  const receipt: OwnedPlanReceipt = {
    tenantId: id(1),
    actorId: id(2),
    operationKey: id(6),
    requestHash,
    bindingId: id(7),
    engagementId: id(8),
    planId: id(9),
    actionId: id(10),
    purpose: 'remediation',
    generatedBy: 'human',
    status: 'review',
    actionCount: 1,
    closesFindingCount: 0,
    approvalTokenId: null,
    executionAllowed: false,
    humanReceipt: '101',
    snapshotHash: ownedHash(before),
    validationHash: ownedHash(validation),
  };
  let saved = false;
  let loseReply = false;
  const ports: OwnedPlanPorts = {
    authorizeCurrent: vi.fn(async () => {}),
    validateRoundtrip: vi.fn(async () => validation),
    withCurrentSnapshot: vi.fn(
      async (_binding, _proof, commit) =>
        await commit({ fenceId: id(11), bindingId: id(7), snapshotHash: ownedHash(before) }),
    ),
    rpc: vi.fn(async (name) => {
      if (name === 'prepare_owned_human_plan')
        return {
          tenantId: id(1),
          actorId: id(2),
          operationKey: id(6),
          requestHash,
          binding,
          state: saved ? 'recorded' : 'pending',
          recorded: saved ? receipt : null,
          recordedValidation: saved ? validation : null,
        };
      saved = true;
      if (loseReply) throw new Error('owned fixture injected lost commit acknowledgement');
      return receipt;
    }),
  };
  return {
    context,
    before,
    request,
    binding,
    validation,
    receipt,
    ports,
    lose: () => {
      loseReply = true;
    },
  };
}
describe('unwired owned-synthetic human plan source producer contracts', () => {
  it('passes exact measured source to narrow writer and leaves approval/execution authority absent', async () => {
    const f = fixture();
    expect(await produceOwnedMeasuredPlan(f.context, f.request, f.ports)).toEqual(f.receipt);
    expect(f.ports.authorizeCurrent).toHaveBeenCalledTimes(2);
    expect(f.ports.rpc).toHaveBeenLastCalledWith(
      'record_owned_measured_plan',
      expect.objectContaining({
        p_roundtrip: f.validation,
        p_validation_hash: ownedHash(f.validation),
        p_request_hash: f.receipt.requestHash,
      }),
    );
    expect(f.receipt.generatedBy).toBe('human');
    expect(f.receipt.closesFindingCount).toBe(0);
    expect(f.receipt.approvalTokenId).toBeNull();
  });
  it('same-key recovery resolves retained proof and does not remeasure or create a second plan', async () => {
    const f = fixture();
    f.lose();
    await expect(produceOwnedMeasuredPlan(f.context, f.request, f.ports)).rejects.toThrow();
    expect(await produceOwnedMeasuredPlan(f.context, f.request, f.ports)).toEqual(f.receipt);
    expect(f.ports.validateRoundtrip).toHaveBeenCalledTimes(1);
    expect(f.ports.rpc).toHaveBeenCalledTimes(3);
    expect(f.ports.authorizeCurrent).toHaveBeenCalledTimes(3);
  });
  it.each([
    'url',
    'approvalTokenId',
    'rollbackValidated',
    'planId',
    'sourceReviewPlanId',
    'registeredEngineHash',
    'registeredCapabilitiesHash',
  ])('rejects caller authority or conversion field %s before writer', async (field) => {
    const f = fixture();
    await expect(
      produceOwnedMeasuredPlan(f.context, { ...f.request, [field]: 'untrusted' }, f.ports),
    ).rejects.toThrow('owned_plan_invalid');
    expect(f.ports.rpc).not.toHaveBeenCalled();
  });
  it.each(['fixture_id', 'resource_id'])('refuses foreign measured %s', async (field) => {
    const f = fixture();
    Object.assign(f.validation.before, { [field]: id(99) });
    await expect(produceOwnedMeasuredPlan(f.context, f.request, f.ports)).rejects.toThrow(
      'validation_refused',
    );
    expect(f.ports.rpc).toHaveBeenCalledTimes(1);
  });
  it.each(['implementation', 'roundtrip', 'persistentMutation', 'resourceCount', 'staleVersion'])(
    'refuses invalid proof %s before save',
    async (bad) => {
      const f = fixture();
      if (bad === 'implementation') f.validation.engine.implementation_sha256 = 'b'.repeat(64);
      if (bad === 'roundtrip') f.validation.restored.audit_log_enabled = true;
      if (bad === 'persistentMutation') f.validation.persistent_mutations = 1;
      if (bad === 'resourceCount') f.validation.resources_measured = 2;
      if (bad === 'staleVersion') f.validation.before.version = 1;
      await expect(produceOwnedMeasuredPlan(f.context, f.request, f.ports)).rejects.toThrow(
        'validation_refused',
      );
      expect(f.ports.rpc).toHaveBeenCalledTimes(1);
    },
  );
  it('does not save a validated source after current human authority was revoked', async () => {
    const f = fixture();
    vi.mocked(f.ports.authorizeCurrent)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('current authority revoked'));
    await expect(produceOwnedMeasuredPlan(f.context, f.request, f.ports)).rejects.toThrow(
      'current authority revoked',
    );
    expect(f.ports.rpc).toHaveBeenCalledTimes(1);
  });
  it('refuses wrong expected actor before authority, measurement or writer', async () => {
    const f = fixture();
    await expect(
      produceOwnedMeasuredPlan({ ...f.context, expectedActorId: id(99) }, f.request, f.ports),
    ).rejects.toThrow('owned_plan_invalid');
    expect(f.ports.authorizeCurrent).not.toHaveBeenCalled();
    expect(f.ports.rpc).not.toHaveBeenCalled();
  });
  it('recovery refuses an altered retained proof rather than returning a superficially valid receipt', async () => {
    const f = fixture();
    await produceOwnedMeasuredPlan(f.context, f.request, f.ports);
    f.validation.restored.audit_log_enabled = true;
    await expect(produceOwnedMeasuredPlan(f.context, f.request, f.ports)).rejects.toThrow(
      'validation_refused',
    );
    expect(f.ports.validateRoundtrip).toHaveBeenCalledTimes(1);
  });
  it('a writer cannot label human proposal as approved or agent-created', async () => {
    const f = fixture();
    Object.assign(f.receipt, {
      executionAllowed: true,
      generatedBy: 'sudhaar',
      status: 'approved',
    });
    await expect(produceOwnedMeasuredPlan(f.context, f.request, f.ports)).rejects.toThrow(
      'outcome_unconfirmed',
    );
  });
  it('refuses missing MFA-session context or a different HTTP idempotency key before writer', async () => {
    const f = fixture();
    for (const context of [
      { ...f.context, sessionId: '' },
      { ...f.context, idempotencyKey: id(99) },
    ])
      await expect(produceOwnedMeasuredPlan(context, f.request, f.ports)).rejects.toThrow(
        'owned_plan_invalid',
      );
    expect(f.ports.rpc).not.toHaveBeenCalled();
  });
  it('sanitizes uncertain writer failure while retaining the original operation identity', async () => {
    const f = fixture();
    f.lose();
    await expect(produceOwnedMeasuredPlan(f.context, f.request, f.ports)).rejects.toThrow(
      'owned_plan_outcome_unconfirmed',
    );
    expect(await produceOwnedMeasuredPlan(f.context, f.request, f.ports)).toEqual(f.receipt);
  });
  it('does not save if actual target snapshot cannot be held through persistence', async () => {
    const f = fixture();
    vi.mocked(f.ports.withCurrentSnapshot).mockRejectedValueOnce(
      new Error('current snapshot changed'),
    );
    await expect(produceOwnedMeasuredPlan(f.context, f.request, f.ports)).rejects.toThrow(
      'current snapshot changed',
    );
    expect(f.ports.rpc).toHaveBeenCalledTimes(1);
  });
  it('rejects a fence for another binding or measured snapshot before writer commit', async () => {
    const f = fixture();
    vi.mocked(f.ports.withCurrentSnapshot).mockImplementationOnce(
      async (_binding, _proof, commit) =>
        await commit({ fenceId: id(11), bindingId: id(99), snapshotHash: ownedHash(f.before) }),
    );
    await expect(produceOwnedMeasuredPlan(f.context, f.request, f.ports)).rejects.toThrow(
      'owned_plan_source_refused',
    );
    expect(f.ports.rpc).toHaveBeenCalledTimes(1);
  });
  it('matches the Python reducer capability manifest golden hash', () => {
    const f = fixture();
    expect(ownedHash(f.validation.engine.capabilities)).toBe(
      'a5b3db560e0707307c69aa70dc6bd62ad4a4ae0612c39f9420db6d99c4a20fb9',
    );
  });
});
it.each(['9223372036854775808', '9999999999999999999'])(
  'refuses overflowing signed-int64 plan receipt %s',
  async (humanReceipt) => {
    const f = fixture();
    f.receipt.humanReceipt = humanReceipt;
    await expect(produceOwnedMeasuredPlan(f.context, f.request, f.ports)).rejects.toThrow(
      'owned_plan_outcome_unconfirmed',
    );
  },
);
it('accepts the exact signed-int64 plan receipt boundary without number conversion', async () => {
  const f = fixture();
  f.receipt.humanReceipt = '9223372036854775807';
  expect((await produceOwnedMeasuredPlan(f.context, f.request, f.ports)).humanReceipt).toBe(
    '9223372036854775807',
  );
});
