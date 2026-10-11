/** Resolve the explicitly configured Workbench URL for marketing links. */
function configuredPlatformUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (
      (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function resolveAppUrl(): string {
  const configured = configuredPlatformUrl(
    process.env.AXIOM_PROOF_PLATFORM_URL || process.env.NEXT_PUBLIC_APP_URL,
  );

  if (typeof window === 'undefined') {
    if (
      configured &&
      (process.env.AXIOM_STRICT_PUBLIC_URLS !== '1' || configured.startsWith('https:'))
    )
      return configured;
    if (process.env.AXIOM_STRICT_PUBLIC_URLS === '1') {
      throw new Error('AXIOM_PROOF_PLATFORM_URL is required for marketing deployment');
    }
    return 'http://localhost:3001';
  }

  const { hostname, protocol } = window.location;
  const local = hostname === 'localhost' || hostname === '127.0.0.1';
  if (configured && (!configured.startsWith('http:') || local)) return configured;
  if (local) return `${protocol}//${hostname}:${process.env.WEB_PORT || '3001'}`;
  // A remote marketing host without an explicit target must not guess a
  // production Workbench, Cloud Run service, or another environment's app.
  throw new Error('Workbench URL is not configured for this marketing host');
}
