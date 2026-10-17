import { z } from 'zod';
import { controllerFilePath } from './controller-files.js';
import { IssuerSyncHealth, issuerNodeId } from './issuer-sync-health.js';
import { WorkloadApiX509Source } from './workload-api-x509.js';
import { LocalKeyTlsIdentities } from './local-key-mtls.js';
import { LocalDispatchKeyWrapper } from './local-dispatch-key-wrapper.js';
import { localCustodyPinsSchema } from './assessment-dispatch.js';
import { x509Identity } from './x509-svid.js';

/** Deployment configuration for a producer or controller that uses the
 * operator-run local key service (0143–0150) instead of cloud KMS. The pins
 * travel with every enqueue/claim; SQL refuses any that are not the active,
 * activated custody policy. Never read from HTTP. */
export const localCustodyKeysConfiguration = z
  .object({
    provider: z.literal('local'),
    custody: localCustodyPinsSchema,
    keyService: z
      .object({
        spiffeId: x509Identity,
        endpoint: z.union([
          z.object({ path: controllerFilePath }).strict(),
          z
            .object({ host: z.literal('127.0.0.1'), port: z.number().int().min(1).max(65535) })
            .strict(),
        ]),
      })
      .strict(),
    workload: z
      .object({
        socketPath: z.string().min(2).max(100),
        spiffeId: x509Identity,
        issuerNodeId,
        healthFile: controllerFilePath.optional(),
      })
      .strict(),
  })
  .strict();
export type LocalCustodyKeysConfiguration = z.infer<typeof localCustodyKeysConfiguration>;

/** The X.509 client for this process's role. The only accepted server is the
 * configured key service identity; the key service maps this process back to
 * its policy principal, and SQL re-admits every operation. */
export function localDispatchKeyWrapper(
  config: LocalCustodyKeysConfiguration,
  binding: { tenantId: string; workloadId: string; role: 'producer' | 'controller' },
) {
  const health = new IssuerSyncHealth(config.workload.issuerNodeId, config.workload.healthFile);
  const source = new WorkloadApiX509Source(
    {
      socketPath: config.workload.socketPath,
      spiffeId: config.workload.spiffeId,
      purpose: 'client',
    },
    health,
  );
  const identities = new LocalKeyTlsIdentities([
    {
      spiffeId: config.keyService.spiffeId,
      servicePrincipal: config.keyService.spiffeId,
      tenantId: binding.tenantId,
      workloadId: binding.workloadId,
      role: 'key_service',
    },
    {
      spiffeId: config.workload.spiffeId,
      servicePrincipal: config.workload.spiffeId,
      tenantId: binding.tenantId,
      workloadId: binding.workloadId,
      role: binding.role,
    },
  ]);
  return new LocalDispatchKeyWrapper({
    source,
    identities,
    serverIdentity: config.keyService.spiffeId,
    endpoint: config.keyService.endpoint,
  });
}
