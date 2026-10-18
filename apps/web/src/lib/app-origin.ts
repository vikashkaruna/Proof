/** The browser-facing origin of the web app. Behind a container the request
 * URL carries the bind host (HOSTNAME=0.0.0.0), and the Host header is
 * client-controlled, so redirects use the configured NEXT_PUBLIC_APP_URL when
 * it is a valid http(s) origin, and the request's own origin only as a last
 * resort. */
export function appOrigin(fallback?: string): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
    } catch {
      // fall through
    }
  }
  return fallback ?? 'http://localhost:3001';
}
