/** Exact per-binding protected transport. No global target key, mint, grant or
 * credential cache; current enrollment is re-read before each provider call. */
import path from 'node:path';
import { z } from 'zod';
import type { OwnedRpcClient } from './owned-synthetic-controller.js';
import { ownedTargetScope, withOwnedTargetCredential } from './owned-target-credentials.js';
const uuid = z.uuid();
export interface OwnedTargetTransportPorts {
  serviceRpc(name: string, args: Record<string, unknown>): Promise<unknown>;
  client(accessToken: string): OwnedRpcClient;
  credentialDirectory: string;
}
export function createOwnedTargetTransport(ports: OwnedTargetTransportPorts) {
  if (
    !path.isAbsolute(ports.credentialDirectory) ||
    path.normalize(ports.credentialDirectory) !== ports.credentialDirectory
  )
    throw Error('Owned credential directory refused');
  return async (
    tenantId: string,
    bindingId: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => {
    uuid.parse(tenantId);
    uuid.parse(bindingId);
    if (
      signal.aborted ||
      args.p_tenant_id !== tenantId ||
      (args.p_binding_id !== undefined && args.p_binding_id !== bindingId)
    )
      throw Error('Owned target transport scope refused');
    const current = z
      .object({ scope: ownedTargetScope, credentialSha256: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(
        await ports.serviceRpc('read_owned_deployment_credential_scope', {
          p_tenant_id: tenantId,
          p_binding_id: bindingId,
        }),
      );
    if (
      current.scope.tenantId !== tenantId ||
      current.scope.bindingId !== bindingId ||
      signal.aborted
    )
      throw Error('Owned target transport scope refused');
    const filename = path.join(
      ports.credentialDirectory,
      bindingId,
      current.scope.credentialId,
      'backend.key',
    );
    return withOwnedTargetCredential(
      filename,
      current.credentialSha256,
      current.scope,
      async (token) => {
        if (signal.aborted) throw Error('Owned target transport expired');
        const result = await ports.client(token).rpc(name, args).abortSignal(signal);
        if (result.error || signal.aborted)
          throw Error('Owned target provider outcome unconfirmed');
        return result;
      },
    );
  };
}
