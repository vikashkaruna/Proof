import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadEnv, isAuthBypassEnabled } from '@axiom/config';
import { createE2ESupabaseClient } from './e2e';

let cached: SupabaseClient | null = null;

/**
 * Create a Supabase client with the service-role key. Bypasses RLS —
 * use only on the server side, only for trusted operations.
 *
 * The BFF, agent runtime, and Temporal workers use this. The Next.js
 * apps NEVER use this — they go through the user-scoped client and
 * rely on RLS to enforce tenancy. `scripts/check-env-security-gate.sh`
 * enforces that invariant in CI (SEC-3).
 */
export function createSupabaseAdmin(): SupabaseClient {
  const env = loadEnv();

  // SEC-13 row 7: this used to substitute an in-memory fixture client whenever
  // ENVIRONMENT was 'preprod', or the URL merely *contained* the substrings
  // 'preprod-supabase' or 'placeholder', or the service key was absent. The
  // effect was that every page, query and agent read in preprod was answered
  // from constants compiled into the bundle — so a green preprod run was
  // evidence about a fixture file and nothing else.
  //
  // The mock is now reachable only under `e2e-bypass`, which @axiom/config
  // refuses to parse outside local/test. A deployed environment that cannot
  // reach its database now fails loudly instead of quietly serving fixtures.
  if (isAuthBypassEnabled()) {
    return createE2ESupabaseClient();
  }

  if (cached) return cached;
  cached = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  return cached;
}
