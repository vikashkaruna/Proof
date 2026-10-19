import { IssuerSyncHealth } from './issuer-sync-health.js';
import { WorkloadApiX509Source } from './workload-api-x509.js';

/** Read-only own-material qualification. Opens no peer/application channel and
 * performs no key operation. The source owns stream cleanup and key erasure. */
export async function requireLocalX509Material(
  workload: {
    readonly socketPath: string;
    readonly spiffeId: string;
    readonly issuerNodeId: string;
    readonly healthFile?: string;
  },
  purpose: 'client' | 'server',
): Promise<void> {
  const source = new WorkloadApiX509Source(
    { socketPath: workload.socketPath, spiffeId: workload.spiffeId, purpose },
    new IssuerSyncHealth(workload.issuerNodeId, workload.healthFile),
  );
  await source.withSnapshot(Date.now() + 5000, async () => undefined);
}
