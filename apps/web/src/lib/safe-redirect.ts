/**
 * Only same-origin absolute paths are honoured after authentication. A
 * `redirect` value is attacker-controllable, and an open redirect on the page
 * that follows sign-in lets a phishing flow borrow this domain.
 */
export function safeRedirectPath(value: unknown, fallback = '/dashboard'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback;
  // Reject control characters, which some browsers strip into `//host`.
  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback;
  return value;
}
