import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { loadWebEnv, isWebAuthBypassEnabled } from '@axiom/config';
import { createE2ESupabaseClient } from './e2e';

/**
 * Create a Supabase client for use in Next.js Server Components,
 * Route Handlers, and Server Actions. Reads/writes session cookies.
 */
export async function createSupabaseServerClient() {
  const env = loadWebEnv();
  const cookieStore = await cookies();

  const authCookie = cookieStore
    .getAll()
    .find((c) => c.name.startsWith('sb-') && c.name.includes('-auth-token') && c.value.length > 0);

  const isLoggedOut = cookieStore.get('axiom_e2e_logged_out')?.value === 'true';
  const userEmail = cookieStore.get('axiom_user_email')?.value || 'founder@axiomminds.ai';

  // SEC-2 / SEC-13 row 8: this used to return the in-memory fixture client when
  // ENVIRONMENT was 'preprod', when the URL contained certain substrings, or —
  // with no environment guard at all — when the request carried an
  // `axiom_e2e_bypass=true` cookie. That last clause meant any visitor could
  // opt themselves into a mock session, in production.
  //
  // The mock is now reachable only under `e2e-bypass`, refused at boot outside
  // local/test.
  if (!isLoggedOut && isWebAuthBypassEnabled()) {
    return createE2ESupabaseClient(userEmail);
  }

  const cookieName = authCookie ? authCookie.name.replace(/\.\d+$/, '') : undefined;

  return createServerClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    cookieOptions: cookieName ? { name: cookieName } : undefined,
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // The `setAll` method was called from a Server Component.
          // This can be ignored if you have middleware refreshing user sessions.
        }
      },
    },
  });
}
