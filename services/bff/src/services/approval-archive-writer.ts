import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadEnv } from '@axiom/config';

let cached: SupabaseClient | null = null;
let cachedKey: string | null = null;

/** This credential is issued only to the BFF; the generic service key is shared with agents. */
export function createApprovalArchiveWriter(): SupabaseClient {
  const env = loadEnv();
  const key = process.env.SUPABASE_ARCHIVE_WRITER_KEY;
  if (!key || key === env.SUPABASE_SERVICE_KEY) {
    throw new Error('Dedicated approval archive writer credential is required');
  }
  try {
    const pieces = key.split('.');
    if (pieces.length !== 3) throw new Error('invalid JWT');
    const claims: unknown = JSON.parse(Buffer.from(pieces[1]!, 'base64url').toString('utf8'));
    if (
      typeof claims !== 'object' ||
      claims === null ||
      !('role' in claims) ||
      claims.role !== 'approval_archive_writer' ||
      !('exp' in claims) ||
      typeof claims.exp !== 'number' ||
      claims.exp <= Math.floor(Date.now() / 1000)
    )
      throw new Error('invalid JWT claims');
  } catch {
    throw new Error('Approval archive writer credential has invalid role or expiry');
  }
  if (!cached || cachedKey !== key) {
    // Kong accepts the registered anon API key; PostgREST authorizes the
    // separate scoped Bearer. A custom role JWT is not a gateway API key.
    cached = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${key}` } },
    });
    cachedKey = key;
  }
  return cached;
}
