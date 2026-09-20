import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

/**
 * Auth middleware for the web app.
 * Refreshes the Supabase session cookie on every request and
 * gates authenticated routes.
 */

const PUBLIC_PATHS = new Set<string>([
  '/',
  '/api/health',
  '/login',
  '/about',
  '/favicon.ico',
  '/robots.txt',
  '/sitemap.xml',
]);

const PUBLIC_PREFIXES = ['/_next/', '/api/public/'];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.has(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // SEC-2: the block that stood here skipped the session check entirely when
  // ENVIRONMENT was 'preprod', when the Supabase URL merely *contained*
  // 'preprod-supabase' or 'placeholder', or — with no environment guard at
  // all — when the request carried `axiom_e2e_bypass=true`.
  //
  // That cookie clause was step 2 of a complete unauthenticated takeover
  // chain: cookie set in any browser → page session check skipped → the BFF
  // proxy injects `test-access-token` → the BFF resolves that to the founder
  // identity → the tenant resolver accepts any X-Tenant-Id with role `owner`.
  // It was reachable in production, and the app handed the cookie out itself
  // whenever login hit a transient network failure.
  //
  // There is now one path, and it runs in every environment.
  const supabaseUrl =
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:55321';
  const supabaseAnonKey =
    process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // A missing anon key used to fall back to a hardcoded live JWT (SEC-2). Fail
  // closed instead: without a key we cannot validate a session, so we must not
  // pretend we did.
  if (!supabaseAnonKey) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('error', 'Authentication is not configured.');
    return NextResponse.redirect(url);
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      get(name: string) {
        return request.cookies.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        request.cookies.set({ name, value, ...options });
        response = NextResponse.next({ request });
        response.cookies.set({ name, value, ...options });
      },
      remove(name: string, options: CookieOptions) {
        request.cookies.set({ name, value: '', ...options });
        response = NextResponse.next({ request });
        response.cookies.set({ name, value: '', ...options });
      },
    },
  });

  let user = null;
  try {
    const {
      data: { user: authUser },
    } = await supabase.auth.getUser();
    user = authUser;
  } catch {
    user = null;
  }

  if (!user && !pathname.startsWith('/login')) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('redirect', pathname);
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
