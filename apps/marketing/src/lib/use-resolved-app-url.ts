'use client';

import { useSyncExternalStore } from 'react';
import { resolveAppUrl } from './url-resolver';

/**
 * The Workbench URL, resolved correctly on both the server and the client.
 *
 * `resolveAppUrl()` deliberately returns different answers in the two
 * environments: on the client it reads `window.location` to map a marketing
 * host onto its paired app host, and on the server it falls back to
 * configuration. So the value genuinely changes between the server render and
 * the first client render — it is not a bug to paper over.
 *
 * The previous shape was a lazy `useState` initialiser plus an effect that
 * immediately called `setAppUrl(resolveAppUrl())`. That re-rendered on every
 * mount from inside an effect (`react-hooks/set-state-in-effect`), and it also
 * meant the header briefly linked to the server-computed URL — on a Cloud Run
 * preview host, a "Sign in" link pointing at the wrong environment.
 *
 * `useSyncExternalStore` handles exactly this: React uses `getServerSnapshot`
 * for the server render and for hydration (so the markup matches), then reads
 * `getSnapshot` and re-renders only if the value differs. No effect.
 *
 * `getSnapshot` runs on every render, so the result is cached — React compares
 * with `Object.is`, and a value derived from `window.location` is stable for
 * the lifetime of the document.
 */

/** Location does not change without a full navigation, so nothing to observe. */
function subscribe(): () => void {
  return () => {};
}

let clientUrl: string | null = null;

function getSnapshot(): string {
  clientUrl ??= resolveAppUrl();
  return clientUrl;
}

let serverUrl: string | null = null;

function getServerSnapshot(): string {
  serverUrl ??= resolveAppUrl();
  return serverUrl;
}

export function useResolvedAppUrl(): string {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
