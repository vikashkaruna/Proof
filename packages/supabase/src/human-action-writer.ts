import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadEnv } from '@axiom/config';

let cached: SupabaseClient | null = null;

/** BFF-only PostgREST identity for an authenticated human's mutation RPCs. */
export function createHumanActionWriter(): SupabaseClient {
  const env = loadEnv();
  const key = env.SUPABASE_HUMAN_ACTION_WRITER_KEY;
  if (!key || key === env.SUPABASE_SERVICE_KEY) {
    throw new Error('BFF human action writer credential is unavailable');
  }
  const parts = key.split('.');
  let claims: unknown;
  try {
    if (parts.length !== 3) throw new Error('Invalid credential');
    claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid human action writer credential');
  }
  if (
    !claims ||
    typeof claims !== 'object' ||
    !('role' in claims) ||
    claims.role !== 'human_action_writer' ||
    !('exp' in claims) ||
    typeof claims.exp !== 'number' ||
    claims.exp <= Math.floor(Date.now() / 1000)
  ) {
    throw new Error('Invalid human action writer credential');
  }
  // PostgREST authenticates the signature; this check catches misconfiguration.
  if (cached) return cached;
  cached = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${key}` } },
  });
  return cached;
}
