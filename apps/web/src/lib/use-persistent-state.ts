'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * React state backed by `localStorage`, safe under server rendering.
 *
 * Why this exists
 * ---------------
 * The pattern it replaces was an empty-dependency effect that read
 * `localStorage` and called `setState`:
 *
 *     const [items, setItems] = useState(initial);
 *     useEffect(() => {
 *       const saved = localStorage.getItem(key);
 *       if (saved) setItems(JSON.parse(saved));
 *     }, []);
 *
 * That renders twice on every mount — once with the server value, once with
 * the stored one — and the second render is a cascading render triggered from
 * inside an effect (`react-hooks/set-state-in-effect`). On a list view it
 * means the user sees the wrong data flash before the right data arrives.
 *
 * A lazy `useState` initialiser cannot fix it: `localStorage` does not exist
 * during server rendering, so reading it there throws, and reading it only on
 * the client produces markup that does not match the server's — a hydration
 * mismatch, which React resolves by discarding the server HTML.
 *
 * `useSyncExternalStore` is built for exactly this. React renders
 * `getServerSnapshot` on the server *and* during hydration, so the markup
 * matches; immediately after hydration it reads `getSnapshot` and re-renders
 * only if the value genuinely differs. No effect, no cascading render, no
 * mismatch.
 *
 * The subtle part
 * ---------------
 * `getSnapshot` runs on every render and React compares results with
 * `Object.is`. `JSON.parse` returns a fresh object each call, so a naive
 * implementation re-renders forever. The cache below keys on the RAW STRING:
 * the parsed object is reused unless the stored text actually changed.
 *
 * `storage` events fire only in *other* tabs, so same-tab writes dispatch a
 * custom event as well — otherwise a component would not see its own write.
 */

const SAME_TAB_EVENT = 'axiom:local-storage';

/** Raw string → parsed value, so repeated snapshots are referentially stable. */
const cache = new Map<string, { raw: string | null; value: unknown }>();

/** Test helper: drop the memo so cases start from a known state. */
export function __resetSnapshotCache(): void {
  cache.clear();
}

/**
 * Exported for tests. The referential-stability behaviour below is the part
 * that can break catastrophically — returning a fresh object from a
 * `useSyncExternalStore` snapshot re-renders forever — and it is pure, so it
 * is worth testing directly rather than only through a rendered component.
 */
export function readSnapshot<T>(key: string, fallback: T): T {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    // Private mode, blocked site data, or a browser that refuses access.
    // Persistence is a convenience here; the component must still render.
    return fallback;
  }

  const cached = cache.get(key);
  if (cached && cached.raw === raw) return cached.value as T;

  let value: T = fallback;
  if (raw !== null) {
    try {
      value = JSON.parse(raw) as T;
    } catch {
      // Corrupt entry — fall back rather than crash the page.
      value = fallback;
    }
  }

  cache.set(key, { raw, value });
  return value;
}

function subscribe(onChange: () => void): () => void {
  const handler = () => onChange();
  window.addEventListener('storage', handler);
  window.addEventListener(SAME_TAB_EVENT, handler);
  return () => {
    window.removeEventListener('storage', handler);
    window.removeEventListener(SAME_TAB_EVENT, handler);
  };
}

export type PersistentStateSetter<T> = (next: T | ((previous: T) => T)) => void;

/**
 * @param key       localStorage key
 * @param fallback  the value rendered on the server and used when nothing is
 *                  stored. Must be referentially stable across renders —
 *                  pass a prop or a module constant, not an inline literal.
 */
export function usePersistentState<T>(key: string, fallback: T): [T, PersistentStateSetter<T>] {
  const getSnapshot = useCallback(() => readSnapshot(key, fallback), [key, fallback]);
  const getServerSnapshot = useCallback(() => fallback, [fallback]);

  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setValue = useCallback<PersistentStateSetter<T>>(
    (next) => {
      const resolved =
        typeof next === 'function'
          ? (next as (previous: T) => T)(readSnapshot(key, fallback))
          : next;
      try {
        window.localStorage.setItem(key, JSON.stringify(resolved));
      } catch {
        // Storage unavailable or full. Still notify, so the in-memory cache
        // below keeps the UI responsive for this session.
      }
      // Seed the cache so the next snapshot is this value even if the write
      // above failed, then wake every subscriber in this tab.
      cache.set(key, { raw: JSON.stringify(resolved), value: resolved });
      window.dispatchEvent(new Event(SAME_TAB_EVENT));
    },
    [key, fallback],
  );

  return [value, setValue];
}
