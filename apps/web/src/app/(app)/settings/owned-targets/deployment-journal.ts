import { z } from 'zod';
import { canonicalJson, sha256 } from '@axiom/ledger';
import {
  ownedDeploymentOperationReadback,
  ownedDeploymentOperationCanonicalJSON,
  ownedDeploymentOperationIntent,
} from '@axiom/types';

export const deploymentJournal = z
  .object({
    version: z.literal(1),
    tenantId: z.uuid(),
    actorId: z.uuid(),
    requestId: z.uuid(),
    intent: ownedDeploymentOperationIntent,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.intent.phase === 'request' && value.requestId !== value.intent.request.operationKey)
      ctx.addIssue({ code: 'custom', message: 'Initial request identity changed' });
  });
export type DeploymentJournal = z.infer<typeof deploymentJournal>;
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;
export const deploymentJournalKey = (tenant: string, actor: string) =>
  `axiom:owned-deployment:v1:${z.uuid().parse(tenant)}:${z.uuid().parse(actor)}`;
export function readDeploymentJournal(storage: Storage, tenant: string, actor: string) {
  const raw = storage.getItem(deploymentJournalKey(tenant, actor));
  if (raw === null) return null;
  if (raw.length > 16384) throw Error('Retained setup request exceeds its bound');
  const result = deploymentJournal.parse(JSON.parse(raw));
  if (result.tenantId !== tenant || result.actorId !== actor) throw Error('Setup identity changed');
  return result;
}
export function retainDeploymentJournal(storage: Storage, value: DeploymentJournal) {
  const parsed = deploymentJournal.parse(value),
    key = deploymentJournalKey(parsed.tenantId, parsed.actorId);
  storage.setItem(key, JSON.stringify(parsed));
  if (
    canonicalJson(readDeploymentJournal(storage, parsed.tenantId, parsed.actorId)) !==
    canonicalJson(parsed)
  )
    throw Error('Setup request could not be retained');
  return parsed;
}
export function assertCurrentDeploymentJournal(storage: Storage, original: DeploymentJournal) {
  if (
    canonicalJson(readDeploymentJournal(storage, original.tenantId, original.actorId)) !==
    canonicalJson(original)
  )
    throw Error('Another tab changed the retained setup request. Reload its original step.');
}
export async function checkDeploymentReadback(value: unknown, original: DeploymentJournal) {
  const row = ownedDeploymentOperationReadback.parse(value).data;
  if (
    row.requestId !== original.requestId ||
    row.tenantId !== original.tenantId ||
    row.actorId !== original.actorId ||
    row.phase !== original.intent.phase ||
    row.operationKey !== original.intent.request.operationKey
  )
    throw Error('Setup receipt belongs to another request');
  if (row.outcome !== 'not_recorded') {
    if (canonicalJson(row.intent) !== canonicalJson(original.intent))
      throw Error('Setup intent changed');
    const expected = await deploymentIntentHash(original);
    if (row.canonicalRequestHash !== expected) throw Error('Setup receipt hash changed');
  }
  if (
    row.phaseResult?.phase === 'fence' &&
    row.phaseResult.receipt.fenceReceiptId !== row.receiptId
  )
    throw Error('Setup retirement receipt changed');
  return row;
}
export async function deploymentIntentHash(original: DeploymentJournal) {
  return sha256(
    ownedDeploymentOperationCanonicalJSON({
      tenantId: original.tenantId,
      actorId: original.actorId,
      requestId: original.requestId,
      operationKey: original.intent.request.operationKey,
      intent: original.intent,
    }),
  );
}
export async function retainDeploymentFence(
  storage: Storage,
  original: DeploymentJournal,
  operationKey: string,
) {
  assertCurrentDeploymentJournal(storage, original);
  const phase = original.intent.phase;
  if (phase === 'install' || phase === 'fence')
    throw Error('Installation effects cannot be retired in this screen');
  const targetPhase = phase === 'request' || phase === 'preflight' ? phase : 'decision';
  const next = deploymentJournal.parse({
    ...original,
    intent: {
      phase: 'fence',
      request: {
        operationKey,
        target: {
          phase: targetPhase,
          operationKey: original.intent.request.operationKey,
          canonicalRequestHash: await deploymentIntentHash(original),
        },
        reason: 'superseded_after_no_effect',
      },
    },
  });
  assertCurrentDeploymentJournal(storage, original);
  const sourceKey = `${deploymentJournalKey(original.tenantId, original.actorId)}:fence-source:${operationKey}`;
  const text = JSON.stringify(original);
  storage.setItem(sourceKey, text);
  if (storage.getItem(sourceKey) !== text)
    throw Error('Original setup intent could not be preserved');
  assertCurrentDeploymentJournal(storage, original);
  return retainDeploymentJournal(storage, next);
}
export async function withDeploymentLock<T>(tenant: string, actor: string, fn: () => Promise<T>) {
  if (!navigator.locks)
    throw Error('This browser cannot safely coordinate setup steps across tabs');
  return navigator.locks.request(deploymentJournalKey(tenant, actor), { mode: 'exclusive' }, fn);
}
export function completeDeploymentJournal(
  storage: Storage,
  original: DeploymentJournal,
  receiptId: string,
) {
  assertCurrentDeploymentJournal(storage, original);
  if (!/^[1-9][0-9]{0,18}$/.test(receiptId)) throw Error('Recorded setup receipt required');
  const key = deploymentJournalKey(original.tenantId, original.actorId);
  const receiptKey = `${key}:receipt:${original.requestId}:${original.intent.phase}:${original.intent.request.operationKey}`;
  const receipt = JSON.stringify({ original, receiptId });
  storage.setItem(receiptKey, receipt);
  if (storage.getItem(receiptKey) !== receipt) throw Error('Setup receipt could not be retained');
  assertCurrentDeploymentJournal(storage, original);
  storage.removeItem(key);
  if (storage.getItem(key) !== null) throw Error('Setup step remains retained');
}
/** Never persist a code, session token, signing key or installation credential. */
export function deploymentBody(original: DeploymentJournal, code?: string) {
  const value = original.intent;
  if (value.phase === 'challenge') return { request: value.request };
  if (value.phase === 'verify') {
    if (!code?.trim()) throw Error('Enter your current authenticator or recovery code');
    return { request: value.request, challengeId: value.challengeId, code: code.trim() };
  }
  if (value.phase === 'approve') return { request: value.request, challengeId: value.challengeId };
  return value.request;
}
export async function deploymentTransport(
  scope: { tenantId: string; actorId: string },
  path: string,
  body?: unknown,
  key?: string,
) {
  z.uuid().parse(scope.tenantId);
  z.uuid().parse(scope.actorId);
  const response = await fetch(`/api/bff/v1/owned-deployments${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    cache: 'no-store',
    signal: AbortSignal.timeout(30000),
    headers: {
      'X-Tenant-Id': scope.tenantId,
      'X-Expected-Actor-Id': scope.actorId,
      ...(body === undefined
        ? {}
        : { 'Content-Type': 'application/json', 'Idempotency-Key': z.uuid().parse(key) }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok || !response.body)
    throw Error('Setup outcome is unavailable. Keep the original step and check it again.');
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.length;
      if (total > 2097152) throw Error('Setup response exceeds its bound');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}
