/** Explicit local synthetic target composition with per-binding retained scope. */
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { createHumanActionWriter, createSupabaseAdmin } from '@axiom/supabase';
import { loadEnv } from '@axiom/config';
import { createOwnedSyntheticController } from './owned-synthetic-controller.js';
import { createOwnedTargetTransport } from './owned-target-transport.js';
export function readOwnedSyntheticConfiguration(source: NodeJS.ProcessEnv = process.env) {
  if (
    source.AXIOM_OWNED_SYNTHETIC_ENABLED !== 'true' ||
    !['local', 'test'].includes(source.ENVIRONMENT ?? '') ||
    (source.AXIOM_AUTH_MODE ?? 'strict') !== 'strict' ||
    source.SUPABASE_OWNED_TARGET_CONTROLLER_KEY
  )
    return null;
  const credentialDirectory = source.AXIOM_OWNED_TARGET_CREDENTIAL_DIRECTORY;
  if (
    !credentialDirectory ||
    !path.isAbsolute(credentialDirectory) ||
    path.normalize(credentialDirectory) !== credentialDirectory
  )
    return null;
  return { credentialDirectory };
}
/** PostgREST itself authenticates JWT cryptography and role-switch transport. */
export function ownedTargetControllerFactory(url: string, anonKey: string, targetKey: string) {
  return () =>
    createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${targetKey}` } },
    });
}
export function configuredOwnedTargetTransport(
  credentialDirectory: string,
  source: NodeJS.ProcessEnv = process.env,
) {
  const env = loadEnv(source);
  return createOwnedTargetTransport({
    credentialDirectory,
    serviceRpc: async (name, args) => {
      const result = await createSupabaseAdmin()
        .rpc(name, args)
        .abortSignal(AbortSignal.timeout(15000));
      if (result.error) throw Error('Owned enrollment scope unavailable');
      return result.data as unknown;
    },
    client: (token) =>
      ownedTargetControllerFactory(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, token)(),
  });
}
export function createConfiguredOwnedSynthetic(isKilled: (tenantId: string) => Promise<boolean>) {
  const config = readOwnedSyntheticConfiguration();
  if (!config) return null;
  return createOwnedSyntheticController({
    isKilled,
    humanWriterFactory: createHumanActionWriter,
    targetRpc: configuredOwnedTargetTransport(config.credentialDirectory),
  });
}
