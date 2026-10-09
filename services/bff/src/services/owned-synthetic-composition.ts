/** Owned synthetic testing is confined to strict local/test topology. No customer or cloud adapter. */
import { createClient } from '@supabase/supabase-js';
import { createHumanActionWriter } from '@axiom/supabase';
import { loadEnv } from '@axiom/config';
import { z } from 'zod';
import { createOwnedSyntheticController } from './owned-synthetic-controller.js';
const claims = z
  .object({
    role: z.literal('owned_target_controller'),
    exp: z.number().int().safe().positive(),
    nbf: z.number().int().safe().nonnegative().optional(),
  })
  .passthrough();
export function readOwnedSyntheticConfiguration(source: NodeJS.ProcessEnv = process.env) {
  if (
    source.AXIOM_OWNED_SYNTHETIC_ENABLED !== 'true' ||
    !['local', 'test'].includes(source.ENVIRONMENT ?? '') ||
    (source.AXIOM_AUTH_MODE ?? 'strict') !== 'strict'
  )
    return null;
  const key = source.SUPABASE_OWNED_TARGET_CONTROLLER_KEY;
  if (
    !key ||
    [
      source.SUPABASE_SERVICE_KEY,
      source.SUPABASE_HUMAN_ACTION_WRITER_KEY,
      source.SUPABASE_AGENT_LEDGER_WRITER_KEY,
      source.SUPABASE_EVIDENCE_INGESTION_WRITER_KEY,
    ].some((value) => value === key)
  )
    return null;
  const parts = key.split('.');
  if (parts.length !== 3 || parts.some((p) => !p)) return null;
  try {
    const parsed = claims.safeParse(
        JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')),
      ),
      now = Math.floor(Date.now() / 1000);
    if (
      !parsed.success ||
      parsed.data.exp <= now ||
      (parsed.data.nbf !== undefined && parsed.data.nbf > now)
    )
      return null;
  } catch {
    return null;
  }
  // The target PostgREST authenticates the signature; local claim checks catch misconfiguration.
  return { targetKey: key };
}
export function createConfiguredOwnedSynthetic(isKilled: (tenantId: string) => Promise<boolean>) {
  const config = readOwnedSyntheticConfiguration();
  if (!config) return null;
  const env = loadEnv();
  return createOwnedSyntheticController({
    isKilled,
    humanWriterFactory: createHumanActionWriter,
    targetControllerFactory: () =>
      createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${config.targetKey}` } },
      }),
  });
}
