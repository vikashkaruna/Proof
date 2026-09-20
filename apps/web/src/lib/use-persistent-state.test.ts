import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readSnapshot, __resetSnapshotCache } from './use-persistent-state';

/**
 * The snapshot memo is the part of `usePersistentState` that can fail
 * catastrophically rather than gracefully.
 *
 * `useSyncExternalStore` calls `getSnapshot` on every render and compares the
 * result with `Object.is`. `JSON.parse` returns a fresh object each time, so a
 * snapshot that parses unconditionally re-renders forever — React throws
 * "The result of getSnapshot should be cached to avoid an infinite loop".
 *
 * These run in node with a stubbed `window`, because the behaviour under test
 * is pure and does not need a DOM.
 */

const FALLBACK = Object.freeze({ items: [] as string[] });

function stubStorage(initial: Record<string, string> = {}, opts: { throwOnGet?: boolean } = {}) {
  const store = new Map(Object.entries(initial));
  const localStorage = {
    getItem: vi.fn((k: string) => {
      if (opts.throwOnGet) throw new Error('storage access denied');
      return store.get(k) ?? null;
    }),
    setItem: vi.fn((k: string, v: string) => void store.set(k, v)),
  };
  vi.stubGlobal('window', { localStorage });
  return { store, localStorage };
}

beforeEach(() => {
  __resetSnapshotCache();
  vi.unstubAllGlobals();
});

describe('readSnapshot — referential stability', () => {
  it('returns the identical reference across repeated calls', () => {
    stubStorage({ k: JSON.stringify({ items: ['a'] }) });

    const first = readSnapshot('k', FALLBACK);
    const second = readSnapshot('k', FALLBACK);
    const third = readSnapshot('k', FALLBACK);

    // Object.is equality is what React checks. Value equality is not enough.
    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(first).toEqual({ items: ['a'] });
  });

  it('parses only once for an unchanged raw value', () => {
    const { localStorage } = stubStorage({ k: JSON.stringify({ items: ['a'] }) });
    const parse = vi.spyOn(JSON, 'parse');

    readSnapshot('k', FALLBACK);
    readSnapshot('k', FALLBACK);
    readSnapshot('k', FALLBACK);

    expect(parse).toHaveBeenCalledTimes(1);
    // Storage is still consulted each time — that is how a change is noticed.
    expect(localStorage.getItem).toHaveBeenCalledTimes(3);
    parse.mockRestore();
  });

  it('returns a new reference once the stored value changes', () => {
    const { store } = stubStorage({ k: JSON.stringify({ items: ['a'] }) });

    const before = readSnapshot('k', FALLBACK);
    store.set('k', JSON.stringify({ items: ['a', 'b'] }));
    const after = readSnapshot('k', FALLBACK);

    expect(after).not.toBe(before);
    expect(after).toEqual({ items: ['a', 'b'] });
  });

  it('keys the memo per storage key', () => {
    stubStorage({
      one: JSON.stringify({ items: ['1'] }),
      two: JSON.stringify({ items: ['2'] }),
    });

    expect(readSnapshot('one', FALLBACK)).toEqual({ items: ['1'] });
    expect(readSnapshot('two', FALLBACK)).toEqual({ items: ['2'] });
    expect(readSnapshot('one', FALLBACK)).toEqual({ items: ['1'] });
  });
});

describe('readSnapshot — degrades rather than crashes', () => {
  it('returns the fallback when nothing is stored, stably', () => {
    stubStorage();
    const first = readSnapshot('missing', FALLBACK);
    const second = readSnapshot('missing', FALLBACK);
    expect(first).toBe(FALLBACK);
    expect(second).toBe(FALLBACK);
  });

  it('returns the fallback for a corrupt entry rather than throwing', () => {
    stubStorage({ k: '{not valid json' });
    expect(readSnapshot('k', FALLBACK)).toBe(FALLBACK);
  });

  it('returns the fallback when storage access throws', () => {
    // Private browsing, blocked site data, or a hardened browser.
    stubStorage({}, { throwOnGet: true });
    expect(readSnapshot('k', FALLBACK)).toBe(FALLBACK);
  });

  it('handles a stored null without mistaking it for absence', () => {
    stubStorage({ k: 'null' });
    expect(readSnapshot<unknown>('k', FALLBACK)).toBeNull();
  });
});
