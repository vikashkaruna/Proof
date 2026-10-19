import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  controllerFilePath,
  readControllerFile,
  controllerBackendCredentials,
} from './workloads/controller-files.js';
import { workloadTrustDomain } from './workloads/jwt-svid.js';
import {
  IssuerSyncHealth,
  SyncedWorkloadTrust,
  issuerNodeId,
} from './workloads/issuer-sync-health.js';
import { WorkloadApiJwtTrust } from './workloads/workload-api-trust.js';
import { fetchPrativedanControllerToken } from './workloads/prativedan-controller-token.js';
import {
  prativedanContainerConfiguration,
  prativedanContainerFactory,
  verifyPrativedanContainerImage,
} from './workloads/prativedan-container.js';
import { PrativedanPrivateController } from './workloads/prativedan-private-controller.js';
import { startPrativedanSocket } from './workloads/prativedan-socket.js';

export const localPrativedanConfiguration = z.strictObject({
  tenantId: z.uuid(),
  trustDomain: workloadTrustDomain,
  issuerNodeId,
  workloadSocket: controllerFilePath,
  backendFile: controllerFilePath,
  launcher: prativedanContainerConfiguration,
  socket: z.strictObject({ directory: controllerFilePath, socketGroup: z.literal(20114) }),
});

/** Explicit opt-in CLI. No registration, credential issuance, grant, mutation,
 * migration or publication at startup. UID is a fixed reviewed source selector. */
export async function prepareLocalPrativedan(args: string[], env: NodeJS.ProcessEnv) {
  let bytes: Buffer | undefined;
  try {
    if (
      process.getuid?.() !== 20107 ||
      args.length !== 2 ||
      !['--check', '--serve'].includes(args[0]!)
    )
      throw new Error();
    bytes = await readControllerFile(args[1]!);
    const c = localPrativedanConfiguration.parse(JSON.parse(bytes.toString('utf8')));
    const credential = await controllerBackendCredentials(c.backendFile, env, c.tenantId, {
      localHttp: true,
      role: 'axiom_prativedan_controller',
    });
    const db = createClient(credential.url, credential.apiKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${credential.accessToken}` } },
    });
    const auth = createClient(credential.url, credential.apiKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const health = new IssuerSyncHealth(c.issuerNodeId);
    if (health.domain !== c.trustDomain) throw new Error();
    const trust = new SyncedWorkloadTrust(
      new WorkloadApiJwtTrust({ socketPath: c.workloadSocket, trustDomains: [c.trustDomain] }),
      health,
    );
    const token = () =>
      fetchPrativedanControllerToken(
        { socketPath: c.workloadSocket, trustDomain: c.trustDomain },
        trust,
      );
    await verifyPrativedanContainerImage(c.launcher);
    // Fresh own SVID and current dedicated tenant registration are read-only.
    await token();
    const registration = await db
      .rpc('read_prativedan_accounted_registration', {
        t: c.tenantId,
        subject: `spiffe://${c.trustDomain}/agent/prativedan`,
      })
      .abortSignal(AbortSignal.timeout(5000));
    if (registration.error || !registration.data) throw new Error();
    const controller = new PrativedanPrivateController({
      tenantId: c.tenantId,
      trustDomain: c.trustDomain,
      trust,
      token,
      writer: db,
      currentUser: async (bearer) => {
        const response = await auth.auth.getUser(bearer);
        if (response.error || !response.data.user) throw new Error('current_human_refused');
        return response.data.user;
      },
      computation: prativedanContainerFactory(c.launcher, 'computation'),
      renderer: prativedanContainerFactory(c.launcher, 'renderer'),
    });
    return {
      mode: args[0],
      serve: () => startPrativedanSocket({ ...c.socket, run: (input) => controller.handle(input) }),
    };
  } catch {
    throw new Error('Prativedan controller startup refused');
  } finally {
    bytes?.fill(0);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const prepared = await prepareLocalPrativedan(process.argv.slice(2), process.env);
    if (prepared.mode === '--check')
      process.stdout.write('Prativedan controller read-only checks passed.\n');
    else {
      const socket = await prepared.serve();
      process.stdout.write('Prativedan controller private socket ready.\n');
      for (const signal of ['SIGTERM', 'SIGINT'] as const)
        process.once(signal, () => void socket.close().finally(() => process.exit(0)));
    }
  } catch {
    process.stderr.write('Prativedan controller refused.\n');
    process.exitCode = 1;
  }
}
