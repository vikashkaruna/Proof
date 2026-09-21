/** SSR forwards to the authoritative BFF with no database or mail credentials. */
export async function gapScanBackend(path: string, init: RequestInit = {}): Promise<Response> {
  const origin = process.env.BFF_PUBLIC_URL;
  if (!origin) throw new Error('Report service is not configured');
  return fetch(new URL(path, origin), {
    ...init,
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(25_000),
  });
}
