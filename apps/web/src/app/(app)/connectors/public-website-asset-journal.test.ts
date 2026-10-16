import { expect, it } from 'vitest';
import { canonicalJson } from '@axiom/ledger';
import { encodePublicWebsiteAssetRequest } from '@axiom/types';
import {
  retainWebsiteAssetIntent,
  readWebsiteAssetIntents,
  retainWebsiteAssetCancellation,
  clearConfirmedWebsiteAssetIntent,
  type WebsiteAssetIntent,
} from './public-website-asset-journal';
const actor = '11111111-1111-4111-8111-111111111111',
  tenant = '22222222-2222-4222-8222-222222222222',
  key = '33333333-3333-4333-8333-333333333333',
  other = '44444444-4444-4444-8444-444444444444';
class Memory implements Storage {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}
const intent = (id = key, tenantId = tenant): WebsiteAssetIntent => ({
  version: 1,
  actorId: actor,
  tenantId,
  requestText: encodePublicWebsiteAssetRequest({
    version: 1,
    kind: 'capture',
    confirmed: true,
    operationKey: id,
    targetId: other,
    expectedTargetSha256: 'a'.repeat(64),
  }),
});
it('retains exact body/key across reload and blocks another unresolved intent in the same tenant', () => {
  const storage = new Memory(),
    value = intent();
  retainWebsiteAssetIntent(storage, value);
  expect(readWebsiteAssetIntents(storage, tenant, actor)).toEqual([
    { intent: value, cancellation: null },
  ]);
  expect(() => retainWebsiteAssetIntent(storage, intent(other))).toThrow();
  expect(readWebsiteAssetIntents(storage, tenant, actor)[0]?.intent).toEqual(value);
});
it('independent actors never overwrite or clear one another', () => {
  const storage = new Memory(),
    a = intent(),
    b = { ...intent(other), actorId: other };
  retainWebsiteAssetIntent(storage, a);
  retainWebsiteAssetIntent(storage, b);
  clearConfirmedWebsiteAssetIntent(storage, a, null);
  expect(readWebsiteAssetIntents(storage, tenant, other)[0]?.intent).toEqual(b);
});
it('corruption, duplicate JSON keys and mismatched storage namespace fail closed', () => {
  for (const corrupt of [
    '{}',
    canonicalJson(intent()).replace('"version":1', '"version":0,"version":1'),
    canonicalJson({ ...intent(), tenantId: other }),
  ]) {
    const storage = new Memory();
    retainWebsiteAssetIntent(storage, intent());
    storage.setItem(storage.key(0)!, corrupt);
    expect(() => readWebsiteAssetIntents(storage, tenant, actor)).toThrow();
    expect(() => retainWebsiteAssetIntent(storage, intent(other))).toThrow();
  }
});
it('detects interleaved entries after readback and preserves both unresolved intents', () => {
  const storage = new Memory(),
    a = intent(),
    b = intent(other);
  const original = storage.getItem.bind(storage);
  let inserted = false;
  storage.getItem = (k) => {
    const value = original(k);
    if (value !== null && !inserted) {
      inserted = true;
      storage.map.set(k.replace(key, other), canonicalJson(b));
    }
    return value;
  };
  expect(() => retainWebsiteAssetIntent(storage, a)).toThrow();
  expect(storage.length).toBe(2);
  expect(readWebsiteAssetIntents(storage, tenant, actor)).toHaveLength(2);
});
it('cancellation is separately durable and its unknown reason cannot be changed', () => {
  const storage = new Memory(),
    a = intent();
  retainWebsiteAssetIntent(storage, a);
  const cancelled = retainWebsiteAssetCancellation(storage, a, 'Abandon this exact operation');
  expect(readWebsiteAssetIntents(storage, tenant, actor)).toEqual([
    { intent: a, cancellation: cancelled },
  ]);
  expect(() => retainWebsiteAssetCancellation(storage, a, 'Different reason')).toThrow();
  expect(() => clearConfirmedWebsiteAssetIntent(storage, a, null)).toThrow();
  expect(storage.length).toBe(2);
  clearConfirmedWebsiteAssetIntent(storage, a, cancelled);
  expect(storage.length).toBe(0);
});
it('compare-and-clear refuses changed content and never clears another operation', () => {
  const storage = new Memory(),
    a = intent();
  retainWebsiteAssetIntent(storage, a);
  storage.setItem(storage.key(0)!, canonicalJson({ ...a, requestText: intent(other).requestText }));
  expect(() => clearConfirmedWebsiteAssetIntent(storage, a, null)).toThrow();
  expect(storage.length).toBe(1);
});
it('unavailable storage refuses retention before a request can be sent', () => {
  const storage = new Memory();
  storage.setItem = () => {
    throw Error('quota');
  };
  expect(() => retainWebsiteAssetIntent(storage, intent())).toThrow('quota');
  expect(storage.length).toBe(0);
});
it('a late tab write after confirmed cleanup stays explicitly recoverable, without claiming cross-tab atomic exclusion', () => {
  const storage = new Memory(),
    a = intent();
  retainWebsiteAssetIntent(storage, a);
  clearConfirmedWebsiteAssetIntent(storage, a, null);
  storage.setItem(
    `axiom.public-website-asset.operation.v1:${actor}:${tenant}:${key}`,
    canonicalJson(a),
  );
  expect(readWebsiteAssetIntents(storage, tenant, actor)).toEqual([
    { intent: a, cancellation: null },
  ]);
});
it('allows independent tenant B while tenant A remains unknown', () => {
  const storage = new Memory();
  retainWebsiteAssetIntent(storage, intent());
  expect(() => retainWebsiteAssetIntent(storage, intent(other, other))).not.toThrow();
  expect(readWebsiteAssetIntents(storage, tenant, actor)[0]?.intent).toEqual(intent());
  expect(readWebsiteAssetIntents(storage, other, actor)[0]?.intent).toEqual(intent(other, other));
});
it('orphaned cancellation and failed cancellation readback stop execution without discarding the original', () => {
  const storage = new Memory(),
    value = intent();
  retainWebsiteAssetIntent(storage, value);
  retainWebsiteAssetCancellation(storage, value, 'Abandon');
  const original = [...storage.map.keys()].find((k) => !k.endsWith(':cancel'))!;
  storage.removeItem(original);
  expect(() => readWebsiteAssetIntents(storage, tenant, actor)).toThrow(/lost its exact original/);
  class NoCancelWrite extends Memory {
    override setItem(k: string, v: string) {
      if (!k.endsWith(':cancel')) super.setItem(k, v);
    }
  }
  const unavailable = new NoCancelWrite();
  retainWebsiteAssetIntent(unavailable, value);
  expect(() => retainWebsiteAssetCancellation(unavailable, value, 'Abandon')).toThrow(
    /could not be retained/,
  );
  expect(readWebsiteAssetIntents(unavailable, tenant, actor)).toEqual([
    { intent: value, cancellation: null },
  ]);
});
it('failed confirmed cleanup keeps its exact entries instead of clearing another operation', () => {
  class Sticky extends Memory {
    override removeItem() {
      /* simulate browser storage refusing removal */
    }
  }
  const storage = new Sticky(),
    value = intent();
  retainWebsiteAssetIntent(storage, value);
  const cancelled = retainWebsiteAssetCancellation(storage, value, 'Abandon');
  expect(() => clearConfirmedWebsiteAssetIntent(storage, value, cancelled)).toThrow(
    /cancellation remains/,
  );
  expect(readWebsiteAssetIntents(storage, tenant, actor)[0]?.cancellation).toEqual(cancelled);
  const otherStorage = new Sticky();
  retainWebsiteAssetIntent(otherStorage, value);
  expect(() => clearConfirmedWebsiteAssetIntent(otherStorage, value, null)).toThrow(
    /website request remains/,
  );
  expect(readWebsiteAssetIntents(otherStorage, tenant, actor)).toHaveLength(1);
});
