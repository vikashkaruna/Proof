import { describe, expect, it } from 'vitest';
import { sha256 } from '@axiom/ledger';
import { ownedDeploymentOperationCanonicalJSON } from '@axiom/types';
import {
  deploymentJournal,
  deploymentJournalKey,
  retainDeploymentJournal,
  readDeploymentJournal,
  checkDeploymentReadback,
  completeDeploymentJournal,
  deploymentBody,
} from './deployment-journal';
const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  actorId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  operationKey = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
function original() {
  return deploymentJournal.parse({
    version: 1,
    tenantId,
    actorId,
    requestId: operationKey,
    intent: {
      phase: 'request',
      request: {
        operationKey,
        engagementId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        connectorId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        manifestSha256: 'a'.repeat(64),
        reason: 'Prepare the explicitly owned synthetic demonstration',
        acknowledgeOwnedSynthetic: true,
      },
    },
  });
}
function storage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}
async function readback() {
  const value = original();
  return {
    data: {
      tenantId,
      actorId,
      requestId: operationKey,
      operationKey,
      phase: 'request',
      outcome: 'recorded',
      intent: value.intent,
      receiptId: '123',
      result: null,
      phaseResult: null,
      canonicalRequestHash: await sha256(
        ownedDeploymentOperationCanonicalJSON({
          tenantId,
          actorId,
          requestId: operationKey,
          operationKey,
          intent: value.intent,
        }),
      ),
    },
  };
}
describe('durable setup recovery', () => {
  it('recovers the exact original after reload and refuses cross-tenant, actor, phase, key, hash or intent receipts', async () => {
    const saved = storage(),
      value = retainDeploymentJournal(saved, original());
    const restored = readDeploymentJournal(saved, tenantId, actorId)!;
    expect(restored).toEqual(value);
    const valid = await readback();
    expect((await checkDeploymentReadback(valid, restored)).receiptId).toBe('123');
    for (const change of [
      { tenantId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
      { actorId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
      { phase: 'install' },
      { operationKey: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
      { canonicalRequestHash: 'f'.repeat(64) },
      {
        intent: {
          ...value.intent,
          request: {
            ...value.intent.request,
            reason: 'Changed after the human request was frozen',
          },
        },
      },
    ])
      await expect(
        checkDeploymentReadback({ data: { ...valid.data, ...change } }, restored),
      ).rejects.toThrow();
    expect(readDeploymentJournal(saved, tenantId, actorId)).toEqual(value);
  });
  it('keeps the original if receipt persistence fails, and refuses to clear a step replaced by another tab', () => {
    const saved = storage(),
      value = retainDeploymentJournal(saved, original());
    expect(() =>
      completeDeploymentJournal(
        {
          ...saved,
          setItem: () => {
            throw Error('Storage quota');
          },
        },
        value,
        '123',
      ),
    ).toThrow('Storage quota');
    expect(readDeploymentJournal(saved, tenantId, actorId)).toEqual(value);
    if (value.intent.phase !== 'request') throw Error('Expected request fixture');
    retainDeploymentJournal(saved, {
      ...value,
      intent: {
        ...value.intent,
        request: {
          ...value.intent.request,
          reason: 'Changed by another tab with its own reviewed reason',
        },
      },
    });
    expect(() => completeDeploymentJournal(saved, value, '123')).toThrow('Another tab');
    expect(saved.getItem(deploymentJournalKey(tenantId, actorId))).not.toBeNull();
  });
  it('strictly excludes codes from durable intent and only adds them to transient verification transport', () => {
    const verify = deploymentJournal.parse({
      ...original(),
      intent: {
        phase: 'verify',
        challengeId: operationKey,
        request: {
          operationKey,
          expectedManifestSha256: 'a'.repeat(64),
          expectedPreflightSha256: 'b'.repeat(64),
          expectedRollbackSha256: 'c'.repeat(64),
          reason: 'Approve this reviewed synthetic scope only',
          acknowledgeOwnedSynthetic: true,
        },
      },
    });
    const saved = storage();
    retainDeploymentJournal(saved, verify);
    expect(deploymentBody(verify, '123456')).toMatchObject({ code: '123456' });
    expect(JSON.stringify(readDeploymentJournal(saved, tenantId, actorId))).not.toContain('123456');
    expect(() =>
      deploymentJournal.parse({ ...verify, intent: { ...verify.intent, code: '123456' } }),
    ).toThrow();
    if (verify.intent.phase !== 'verify') throw Error('Expected verification fixture');
    expect(
      deploymentBody({ ...verify, intent: { ...verify.intent, phase: 'approve' } }),
    ).not.toHaveProperty('code');
  });
});

it('keeps stop intent separate from installation and excludes codes from its durable proof', () => {
  const request = {
    operationKey,
    expectedManifestSha256: 'a'.repeat(64),
    expectedApprovalId: operationKey,
    reason: 'Stop the exact retained synthetic enrollment authority',
    acknowledgeOwnedSynthetic: true,
  };
  const challenge = deploymentJournal.parse({
    ...original(),
    intent: { phase: 'revoke_challenge', request },
  });
  const verify = deploymentJournal.parse({
    ...original(),
    intent: { phase: 'revoke_verify', request, challengeId: operationKey },
  });
  const revoke = deploymentJournal.parse({
    ...original(),
    intent: { phase: 'revoke', request, challengeId: operationKey },
  });
  expect(deploymentBody(challenge)).toEqual({ request });
  expect(deploymentBody(verify, '482901')).toEqual({
    request,
    challengeId: operationKey,
    code: '482901',
  });
  expect(deploymentBody(revoke)).toEqual({ request, challengeId: operationKey });
  expect(() => deploymentBody(verify)).toThrow('Enter your current');
  expect(JSON.stringify(verify)).not.toContain('482901');
  expect(deploymentJournal.safeParse({ ...verify, code: '482901' }).success).toBe(false);
});
