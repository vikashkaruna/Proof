// @vitest-environment jsdom
import {
  readCustodyResolution,
  retainCustodyResolution,
  assertCustodyResolution,
  clearCustodyResolution,
} from './custody-journal';
import { cancellation } from './__tests__/fixtures';
import { beforeEach, expect, it } from 'vitest';
import {
  readCustodyIntents,
  retainCustodyIntent,
  clearCustodyIntent,
  assertCustodyIntent,
  intentFor,
} from './custody-journal';
import { tenant, actor, other, request } from './__tests__/fixtures';
beforeEach(() => localStorage.clear());
it('retains exact unknown bytes across reload and blocks only the same tenant and actor', () => {
  const one = intentFor(tenant, actor, request());
  retainCustodyIntent(localStorage, one);
  expect(readCustodyIntents(localStorage, tenant, actor)).toEqual([one]);
  const changed = { ...one, request: { ...one.request, reason: 'Edited' } };
  expect(() => retainCustodyIntent(localStorage, changed)).toThrow();
  expect(() =>
    retainCustodyIntent(localStorage, { ...one, request: { ...one.request, operationKey: other } }),
  ).toThrow();
  retainCustodyIntent(localStorage, intentFor(other, actor, request(other)));
  expect(readCustodyIntents(localStorage, tenant, actor)).toEqual([one]);
  retainCustodyIntent(localStorage, intentFor(tenant, other, request()));
  expect(readCustodyIntents(localStorage, tenant, other)).toHaveLength(1);
});
it('compare-and-clear preserves a changed or foreign operation', () => {
  const one = intentFor(tenant, actor, request());
  retainCustodyIntent(localStorage, one);
  expect(() =>
    clearCustodyIntent(localStorage, { ...one, request: { ...one.request, reason: 'Other' } }),
  ).toThrow();
  expect(readCustodyIntents(localStorage, tenant, actor)).toHaveLength(1);
  clearCustodyIntent(localStorage, one);
  expect(readCustodyIntents(localStorage, tenant, actor)).toEqual([]);
  expect(() => assertCustodyIntent(localStorage, one, true)).toThrow();
});
it('corruption fails closed without clearing or accepting new intent', () => {
  const one = intentFor(tenant, actor, request());
  retainCustodyIntent(localStorage, one);
  const key = localStorage.key(0)!;
  localStorage.setItem(key, '{');
  expect(() => readCustodyIntents(localStorage, tenant, actor)).toThrow();
  expect(() => retainCustodyIntent(localStorage, one)).toThrow();
  expect(localStorage.getItem(key)).toBe('{');
});
it('observed concurrent retained intents prevent mutation but both can be recovered', () => {
  const one = intentFor(tenant, actor, request());
  retainCustodyIntent(localStorage, one);
  const second = { ...one, request: { ...one.request, operationKey: other } };
  const key = localStorage.key(0)!.replace(one.request.operationKey, other);
  localStorage.setItem(key, JSON.stringify(second));
  expect(() => assertCustodyIntent(localStorage, one, true)).toThrow();
  expect(() => assertCustodyIntent(localStorage, one, false)).not.toThrow();
  clearCustodyIntent(localStorage, one);
  expect(readCustodyIntents(localStorage, tenant, actor)).toEqual([second]);
});

it('does not rewrite an already retained exact intent', () => {
  const one = intentFor(tenant, actor, request());
  retainCustodyIntent(localStorage, one);
  const prototype = Object.getPrototypeOf(localStorage) as Storage;
  const original = prototype.setItem;
  let writes = 0;
  prototype.setItem = function (key: string, value: string) {
    writes++;
    original.call(this, key, value);
  };
  try {
    retainCustodyIntent(localStorage, one);
    expect(writes).toBe(0);
  } finally {
    prototype.setItem = original;
  }
});

it('refuses oversized, foreign and excessive retained entries without deleting them', () => {
  const one = intentFor(tenant, actor, request());
  retainCustodyIntent(localStorage, one);
  const key = localStorage.key(0)!;
  localStorage.setItem(key, 'x'.repeat(131073));
  expect(() => readCustodyIntents(localStorage, tenant, actor)).toThrow();
  localStorage.setItem(key, JSON.stringify({ ...one, actorId: other }));
  expect(() => readCustodyIntents(localStorage, tenant, actor)).toThrow();
  localStorage.clear();
  for (let i = 0; i < 21; i++) {
    const op = `88888888-8888-4888-8888-${String(i).padStart(12, '0')}`;
    localStorage.setItem(
      `axiom:custody-policy:v1:${tenant}:${actor}:${op}`,
      JSON.stringify({ ...one, request: { ...one.request, operationKey: op } }),
    );
  }
  expect(() => readCustodyIntents(localStorage, tenant, actor)).toThrow();
  expect(localStorage.length).toBe(21);
});
it('write/readback failure makes no optimistic retained success', () => {
  const one = intentFor(tenant, actor, request());
  const storage: Storage = {
    length: 0,
    key: () => null,
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  };
  expect(() => retainCustodyIntent(storage, one)).toThrow(/could not be retained/);
});
it('compare-and-clear observes changes between initial validation and removal', () => {
  const one = intentFor(tenant, actor, request());
  let value = JSON.stringify(one),
    reads = 0,
    removed = false;
  const changed = JSON.stringify({
    ...one,
    request: { ...one.request, reason: 'Changed in another tab' },
  });
  const storage: Storage = {
    length: 1,
    key: () => '',
    getItem: () => {
      reads++;
      if (reads === 2) value = changed;
      return value;
    },
    setItem: () => {},
    removeItem: () => {
      removed = true;
    },
    clear: () => {},
  };
  expect(() => clearCustodyIntent(storage, one)).toThrow(/Changed custody request/);
  expect(removed).toBe(false);
  expect(value).toBe(changed);
});

it('keeps a separate exact cancellation across reload; no overwrite, no original discard, actor/tenant scoped', () => {
  const original = intentFor(tenant, actor, request());
  retainCustodyIntent(localStorage, original);
  const linked = { tenantId: tenant, actorId: actor, resolution: cancellation() };
  retainCustodyResolution(localStorage, original, linked);
  expect(readCustodyResolution(localStorage, original)).toEqual(linked);
  expect(readCustodyIntents(localStorage, tenant, actor)).toEqual([original]);
  expect(() =>
    retainCustodyResolution(localStorage, original, {
      ...linked,
      resolution: { ...linked.resolution, reason: 'changed' },
    }),
  ).toThrow();
  expect(() =>
    retainCustodyResolution(localStorage, original, { ...linked, actorId: other }),
  ).toThrow();
  assertCustodyResolution(localStorage, original, linked);
  clearCustodyResolution(localStorage, original, linked);
  expect(readCustodyResolution(localStorage, original)).toBeNull();
  expect(readCustodyIntents(localStorage, tenant, actor)).toEqual([original]);
});

it('orphaned or corrupted linked resolution blocks only its own tenant+actor namespace', () => {
  const original = intentFor(tenant, actor, request());
  retainCustodyIntent(localStorage, original);
  retainCustodyResolution(localStorage, original, {
    tenantId: tenant,
    actorId: actor,
    resolution: cancellation(),
  });
  localStorage.removeItem(
    `axiom:custody-policy:v1:${tenant}:${actor}:${original.request.operationKey}`,
  );
  expect(() => readCustodyIntents(localStorage, tenant, actor)).toThrow(/Orphaned/);
  expect(readCustodyIntents(localStorage, other, actor)).toEqual([]);
  expect(readCustodyIntents(localStorage, tenant, other)).toEqual([]);
});
