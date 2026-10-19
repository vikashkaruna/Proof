/** Default-off local enrollment. Authority is the normal human writer, existing
 * approval signer and dedicated bound MFA; no installer receives signing keys. */
import path from 'node:path';
import { loadEnv } from '@axiom/config';
import { OwnedDeploymentOperatorAuth } from './owned-deployment-operator.js';
import {
  OwnedDeploymentInstaller,
  actualOwnedTransportVerifier,
} from './owned-deployment-installer.js';
import { createSupabaseAdmin, createHumanActionWriter } from '@axiom/supabase';
import type { ApprovalEngine } from '@axiom/approval-engine';
import type { MfaService } from './mfa.js';
import { OwnedDeploymentController } from './owned-deployment-controller.js';
import { readOwnedDeploymentManifests } from './owned-deployment-manifest.js';
export function ownedDeploymentConfiguration(source: NodeJS.ProcessEnv = process.env) {
  if (
    source.AXIOM_OWNED_DEPLOYMENT_ENABLED !== 'true' ||
    !['local', 'test'].includes(source.ENVIRONMENT ?? '') ||
    (source.AXIOM_AUTH_MODE ?? 'strict') !== 'strict'
  )
    return null;
  const manifestFile = source.AXIOM_OWNED_DEPLOYMENT_MANIFEST_FILE;
  const transportFile = source.AXIOM_OWNED_DEPLOYMENT_TRANSPORT_FILE;
  const credentialDirectory = source.AXIOM_OWNED_TARGET_CREDENTIAL_DIRECTORY;
  if (
    !manifestFile ||
    !transportFile ||
    !credentialDirectory ||
    ![manifestFile, transportFile, credentialDirectory].every(
      (v) => path.isAbsolute(v) && path.normalize(v) === v,
    )
  )
    return null;
  return { manifestFile, transportFile, credentialDirectory };
}
export function createConfiguredOwnedDeployment(
  approval: Pick<ApprovalEngine, 'issue' | 'sign'>,
  mfa: MfaService,
  source: NodeJS.ProcessEnv = process.env,
) {
  const config = ownedDeploymentConfiguration(source);
  if (!config) return null;
  const rpc = async (
    writer: ReturnType<typeof createSupabaseAdmin>,
    name: string,
    args: Record<string, unknown>,
  ) => {
    const result = await writer.rpc(name, args).abortSignal(AbortSignal.timeout(15000));
    if (result.error) throw Error('Owned deployment source unavailable');
    return result.data as unknown;
  };
  return new OwnedDeploymentController({
    approval,
    mfa,
    manifests: () => readOwnedDeploymentManifests(config.manifestFile),
    humanRpc: (name, args) => rpc(createHumanActionWriter(), name, args),
    serviceRpc: (name, args) => rpc(createSupabaseAdmin(), name, args),
  });
}

export function createConfiguredOwnedDeploymentPrivate(
  approval: Pick<ApprovalEngine, 'issue' | 'sign'>,
  source: NodeJS.ProcessEnv = process.env,
) {
  const config = ownedDeploymentConfiguration(source);
  if (!config) return null;
  const env = loadEnv(source);
  return {
    auth: new OwnedDeploymentOperatorAuth(config.transportFile, true),
    installer: new OwnedDeploymentInstaller({
      approval,
      credentialDirectory: config.credentialDirectory,
      manifests: () => readOwnedDeploymentManifests(config.manifestFile),
      serviceRpc: async (name, args) => {
        const result = await createSupabaseAdmin()
          .rpc(name, args)
          .abortSignal(AbortSignal.timeout(15000));
        if (result.error) throw Error('Owned deployment private source unavailable');
        return result.data as unknown;
      },
      verifyTransport: actualOwnedTransportVerifier(env.SUPABASE_URL, env.SUPABASE_ANON_KEY),
    }),
  };
}
