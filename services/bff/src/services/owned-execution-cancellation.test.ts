import { expect, it, vi } from 'vitest';
import { cancelOwnedPendingRequest } from './owned-execution-cancellation.js';
import { ownedHash } from './owned-execution-plan.js';
const id = (n: number) => `89120000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
  const context = {
    tenantId: id(1),
    actorId: id(2),
    expectedActorId: id(2),
    sessionId: id(3),
    idempotencyKey: id(4),
  };
  const request = {
    operationKey: id(5),
    bindingId: id(6),
    engagementId: id(7),
    expectedSnapshotHash: 'a'.repeat(64),
    reason: 'Original explicit human owned configuration request.',
    acknowledgeOwnedSynthetic: true,
    actionType: 'config.audit_log_enable',
    desiredEnabled: true,
  };
  const input = {
    request,
    cancellationKey: id(4),
    reason: 'Stop my unrecorded owned configuration request.',
  };
  const receipt = {
    tenantId: id(1),
    actorId: id(2),
    operationKey: id(5),
    requestHash: ownedHash({ tenantId: id(1), actorId: id(2), request }),
    cancellationKey: id(4),
    reason: input.reason,
    state: 'cancelled',
    humanReceipt: '101',
    planId: null,
    executionAllowed: false,
  };
  const ports = {
    authorizeCurrentHuman: vi.fn(async () => {}),
    cancelOriginalPendingRequest: vi.fn(async (): Promise<unknown> => receipt),
  };
  return { context, input, receipt, ports };
}
it('binds the cancellation receipt to exact original human body and separate cancellation key', async () => {
  const f = fixture();
  expect(await cancelOwnedPendingRequest(f.context, f.input, f.ports)).toEqual(f.receipt);
  expect(f.ports.cancelOriginalPendingRequest).toHaveBeenCalledWith({
    p_tenant_id: id(1),
    p_actor_id: id(2),
    p_session_id: id(3),
    p_operation_key: id(5),
    p_request_hash: f.receipt.requestHash,
    p_cancellation_key: id(4),
    p_reason: f.input.reason,
  });
});
it.each(['actor', 'key', 'session', 'extra', 'originalExtra'])(
  'refuses %s before authorization or writes',
  async (mode) => {
    const f = fixture();
    if (mode === 'actor') f.context.expectedActorId = id(99);
    if (mode === 'key') f.context.idempotencyKey = id(99);
    if (mode === 'session') f.context.sessionId = '';
    const input =
      mode === 'extra'
        ? { ...f.input, approvalTokenId: id(99) }
        : mode === 'originalExtra'
          ? { ...f.input, request: { ...f.input.request, registerTarget: true } }
          : f.input;
    await expect(cancelOwnedPendingRequest(f.context, input, f.ports)).rejects.toMatchObject({
      code: 'owned_cancellation_invalid',
    });
    expect(f.ports.authorizeCurrentHuman).not.toHaveBeenCalled();
    expect(f.ports.cancelOriginalPendingRequest).not.toHaveBeenCalled();
  },
);
it('current authority failure makes no cancellation write', async () => {
  const f = fixture();
  f.ports.authorizeCurrentHuman.mockRejectedValue(Error('Revoked human MFA'));
  await expect(cancelOwnedPendingRequest(f.context, f.input, f.ports)).rejects.toThrow(
    'Revoked human MFA',
  );
  expect(f.ports.cancelOriginalPendingRequest).not.toHaveBeenCalled();
});
it.each([
  { tenantId: id(99) },
  { actorId: id(99) },
  { operationKey: id(99) },
  { requestHash: 'b'.repeat(64) },
  { cancellationKey: id(99) },
  { reason: 'A different cancellation request reason.' },
  { planId: id(99) },
  { executionAllowed: true },
  { humanReceipt: '0' },
  { humanReceipt: '9223372036854775808' },
  { humanReceipt: '9999999999999999999' },
  { state: 'recorded' },
  { approvalTokenId: id(99) },
])('refuses substituted or authority-inflating receipt %j', async (change) => {
  const f = fixture();
  f.ports.cancelOriginalPendingRequest.mockResolvedValue({ ...f.receipt, ...change });
  await expect(cancelOwnedPendingRequest(f.context, f.input, f.ports)).rejects.toMatchObject({
    code: 'owned_cancellation_source_refused',
  });
});
it('lost committed reply stays uncertain and exact retry reuses original keys and body', async () => {
  const f = fixture();
  f.ports.cancelOriginalPendingRequest.mockRejectedValueOnce(Error('Committed response discarded'));
  await expect(cancelOwnedPendingRequest(f.context, f.input, f.ports)).rejects.toMatchObject({
    code: 'owned_cancellation_outcome_unconfirmed',
  });
  expect(await cancelOwnedPendingRequest(f.context, f.input, f.ports)).toEqual(f.receipt);
  expect(f.ports.cancelOriginalPendingRequest.mock.calls[0]).toEqual(
    f.ports.cancelOriginalPendingRequest.mock.calls[1],
  );
  expect(f.ports.authorizeCurrentHuman).toHaveBeenCalledTimes(2);
});
it('accepts the exact signed-int64 cancellation receipt boundary', async () => {
  const f = fixture();
  f.ports.cancelOriginalPendingRequest.mockResolvedValue({
    ...f.receipt,
    humanReceipt: '9223372036854775807',
  });
  expect((await cancelOwnedPendingRequest(f.context, f.input, f.ports)).humanReceipt).toBe(
    '9223372036854775807',
  );
});
