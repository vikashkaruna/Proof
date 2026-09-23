import { expect, it, afterEach, vi } from 'vitest';
import { mkdtemp, realpath, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import {
  IssuerSyncHealth,
  SyncedWorkloadTrust,
  readIssuerObservation,
} from './issuer-sync-health.js';
const node = 'spiffe://health.test/spire/agent/gcp_iit/fixture-project/123';
const now = 1800000000000;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0)) await fn();
});
function fixture() {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const value = {
    schemaVersion: 1,
    healthy: true,
    nodeId: node,
    observedAtMs: now - 1000,
    syncAtMs: now - 5000,
    certificateExpiresAtMs: now + 300000,
  };
  const read = vi.fn(async (): Promise<unknown> => value);
  const health = new IssuerSyncHealth(node, '/run/spire-health/status.json', read);
  const source = {
    load: vi.fn(async () => ({ revision: 'key-1', validUntil: now + 10000, jwks: {} })),
    stillCurrent: vi.fn(async () => true),
  };
  return { value, read, health, source, trust: new SyncedWorkloadTrust(source, health) };
}
it('bounds validity by observation, upstream synchronization and certificate expiry', async () => {
  const f = fixture();
  expect(await f.health.validUntil()).toBe(now + 9000);
  f.value.syncAtMs = now - 29000;
  expect(await f.health.validUntil()).toBe(now + 1000);
  f.value.certificateExpiresAtMs = now + 500;
  expect(await f.health.validUntil()).toBe(now + 500);
});
it.each([
  ['observedAtMs', now - 10000],
  ['observedAtMs', now + 1],
  ['syncAtMs', now - 30000],
  ['syncAtMs', now],
  ['syncAtMs', 0],
  ['certificateExpiresAtMs', now],
  ['healthy', false],
  ['nodeId', node + '4'],
  ['schemaVersion', 2],
  ['extra', 'private'],
  ['syncAtMs', '1799999995000'],
])('refuses invalid %s without opening workload trust', async (field, value) => {
  const f = fixture();
  Object.assign(f.value, { [field]: value });
  expect(await f.trust.load('health.test')).toBeNull();
  expect(f.source.load).not.toHaveBeenCalled();
});
it('current observation cannot extend old issuer synchronization', async () => {
  const f = fixture();
  f.value.observedAtMs = now;
  f.value.syncAtMs = now - 30001;
  await expect(f.health.requireFresh()).rejects.toThrow('Issuer synchronization unavailable');
});
it('refuses missing, malformed or unavailable observation without a fallback', async () => {
  const f = fixture();
  for (const value of [null, {}, [], 'private']) {
    f.read.mockResolvedValue(value);
    expect(await f.health.validUntil()).toBeNull();
  }
  f.read.mockRejectedValue(new Error('private mount error'));
  expect(await f.health.validUntil()).toBeNull();
});
it('refuses backward clock movement and overly slow reads', async () => {
  const f = fixture();
  expect(await f.health.validUntil()).not.toBeNull();
  vi.mocked(Date.now).mockReturnValue(now - 1);
  expect(await f.health.validUntil()).toBeNull();
  vi.mocked(Date.now)
    .mockReturnValueOnce(now)
    .mockReturnValue(now + 1001);
  expect(await f.health.validUntil()).toBeNull();
});
it('rechecks health after trust IO and retains the earlier deadline', async () => {
  const f = fixture();
  expect((await f.trust.load('health.test'))?.validUntil).toBe(now + 9000);
  f.source.load.mockImplementation(async () => {
    f.value.healthy = false;
    return { revision: 'key-1', validUntil: now + 10000, jwks: {} };
  });
  expect(await f.trust.load('health.test')).toBeNull();
});
it('an in-flight read cannot revive an expired initial health snapshot', async () => {
  const f = fixture();
  f.value.syncAtMs = now - 29999;
  f.source.load.mockImplementation(async () => {
    vi.mocked(Date.now).mockReturnValue(now + 2);
    f.value.syncAtMs = now;
    return { revision: 'key-1', validUntil: now + 10000, jwks: {} };
  });
  expect(await f.trust.load('health.test')).toBeNull();
});
it('preserves source expiry, key revisions and exact trust domain', async () => {
  const f = fixture();
  f.source.load.mockResolvedValue({ revision: 'key-1', validUntil: now + 500, jwks: {} });
  expect((await f.trust.load('health.test'))?.validUntil).toBe(now + 500);
  expect(await f.trust.stillCurrent('health.test', 'key-2')).toBe(false);
  expect(await f.trust.stillCurrent('health.test', 'key-1')).toBe(true);
  f.read.mockClear();
  expect(await f.trust.load('foreign.test')).toBeNull();
  expect(f.read).not.toHaveBeenCalled();
});
it('sanitizes unavailable or invalid underlying trust without cached fallback', async () => {
  const f = fixture();
  f.source.load.mockRejectedValue(new Error('private transport diagnostic'));
  expect(await f.trust.load('health.test')).toBeNull();
  expect(await f.trust.stillCurrent('health.test', 'key-1')).toBe(false);
  f.source.load.mockResolvedValue({ revision: 'key-1', validUntil: NaN, jwks: {} });
  expect(await f.trust.load('health.test')).toBeNull();
});
it('refuses unsafe filesystem sources with fixed errors', async () => {
  const dir = await mkdtemp((await realpath('/tmp')) + '/issuer-sync-');
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const file = dir + '/status.json';
  await writeFile(file, '{}', { mode: 0o666 });
  await chmod(file, 0o666);
  await expect(readIssuerObservation(file)).rejects.toThrow('Issuer synchronization unavailable');
  const link = dir + '/link.json';
  await symlink(file, link);
  await expect(readIssuerObservation(link)).rejects.toThrow('Issuer synchronization unavailable');
  await expect(readIssuerObservation(dir + '/missing')).rejects.toThrow(
    'Issuer synchronization unavailable',
  );
});
