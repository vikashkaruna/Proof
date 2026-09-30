import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadEnv } from '@axiom/config';

let cached: SupabaseClient | null = null;

/** A distinct PostgREST identity held only by the BFF for proof mutations. */
export function createStatutoryProofWriter(): SupabaseClient {
  const env = loadEnv();
  const key = env.SUPABASE_STATUTORY_PROOF_WRITER_KEY;
  if (!key || key === env.SUPABASE_SERVICE_KEY) {
    throw new Error('BFF statutory proof writer credential is unavailable');
  }
  const parts = key.split('.');
  if (parts.length !== 3) throw new Error('Invalid statutory proof writer credential');
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid statutory proof writer credential');
  }
  if (
    !claims ||
    typeof claims !== 'object' ||
    !('role' in claims) ||
    claims.role !== 'statutory_proof_writer' ||
    !('exp' in claims) ||
    typeof claims.exp !== 'number' ||
    claims.exp <= Math.floor(Date.now() / 1000)
  ) {
    throw new Error('Invalid statutory proof writer credential');
  }
  // This local structural check is only configuration validation. PostgREST
  // authenticates the HS256 signature and assumes the restricted DB role.
  if (cached) return cached;
  // Supabase's API gateway accepts the public anon key in `apikey`; PostgREST
  // evaluates the separate scoped Bearer token. A custom JWT is not itself a
  // registered gateway API key on every self-hosted/deployed topology.
  cached = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${key}` } },
  });
  return cached;
}
