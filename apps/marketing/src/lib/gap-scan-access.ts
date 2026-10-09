import { cookies } from 'next/headers';

const TOKEN = /^[a-f0-9]{64}$/;
const COOKIE_PREFIX = 'gap-scan.';

/** Firebase Hosting forwards only __session to rewritten Cloud Run services. */
export const GAP_SCAN_SESSION_COOKIE = '__session';

export function encodeGapScanSession(token: string): string {
  if (!TOKEN.test(token)) throw new Error('Invalid gap-scan ownership token');
  return `${COOKIE_PREFIX}${token}`;
}

export async function readGapScanAccess(): Promise<string | undefined> {
  const jar = await cookies();
  const session = jar.get(GAP_SCAN_SESSION_COOKIE)?.value;
  if (session?.startsWith(COOKIE_PREFIX)) {
    const token = session.slice(COOKIE_PREFIX.length);
    return TOKEN.test(token) ? token : undefined;
  }
  // Reports created before Firebase hosting used this host-only cookie on
  // direct Cloud Run. Never treat an unmarked __session as report authority.
  const legacy = jar.get('gap_scan_access')?.value;
  return legacy && TOKEN.test(legacy) ? legacy : undefined;
}
