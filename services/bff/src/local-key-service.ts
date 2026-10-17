import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { controllerFilePath, readControllerFile } from './workloads/controller-files.js';
import { IssuerSyncHealth, issuerNodeId } from './workloads/issuer-sync-health.js';
import { WorkloadApiX509Source } from './workloads/workload-api-x509.js';
import { LocalKeyService } from './workloads/local-key-service.js';
import { LocalKeyTlsIdentities, serveLocalKeyMtlsGeneration } from './workloads/local-key-mtls.js';
import { verifyLocalCustodyPolicy } from './workloads/local-key-admission.js';
import {
  acceptedRunResolver,
  roleRoutedKeyAuthority,
  runGenerations,
  verifierReadRpc,
  type VerifierRole,
} from './workloads/local-key-daemon.js';
import { x509Identity } from './workloads/x509-svid.js';

const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const localKeyServiceConfiguration = z
  .object({
    policyFile: controllerFilePath,
    policySha256: sha,
    keyDirectory: controllerFilePath,
    endpoint: z.union([
      z.object({ path: controllerFilePath }).strict(),
      z.object({ host: z.literal('127.0.0.1'), port: z.number().int().min(1).max(65535) }).strict(),
    ]),
    supabaseUrl: z.url().refine((s) => {
      const u = new URL(s);
      return !u.username && !u.password && !u.search && !u.hash;
    }),
    credentials: z
      .object({
        operator: controllerFilePath.optional(),
        producer: controllerFilePath.optional(),
        controller: controllerFilePath.optional(),
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
    peers: z.array(
      z.object({ spiffeId: x509Identity, role: z.enum(['producer', 'controller']) }).strict(),
    ),
  })
  .strict();

/** Operator-run local custody key service (D2: operator-managed custody).
 * --check  verifies configuration, policy digest and credential shapes only.
 * --provision  creates the policy's primary key version once (operator role).
 * --serve  answers producer wraps and controller unwraps, one mTLS exchange per
 *          generation, every operation re-admitted in SQL with that role's own
 *          verifier credential. No master key leaves this process. */
export async function prepareLocalKeyService(args: string[]) {
  try {
    if (args.length !== 2 || !['--check', '--provision', '--serve'].includes(args[0]!))
      throw new Error();
    const config = localKeyServiceConfiguration.parse(
      JSON.parse((await readControllerFile(args[1]!)).toString('utf8')),
    );
    const policyText = (await readControllerFile(config.policyFile)).toString('utf8');
    const policy = verifyLocalCustodyPolicy(policyText, config.policySha256);
    const principals: Record<VerifierRole, string> = {
      operator: 'operator:' + policy.nominatedOperatorId,
      producer: policy.servicePrincipals.producer,
      controller: policy.servicePrincipals.controller,
    };
    const reads = Object.fromEntries(
      (Object.entries(config.credentials) as [VerifierRole, string | undefined][])
        .filter((entry): entry is [VerifierRole, string] => entry[1] !== undefined)
        .map(([role, file]) => [
          role,
          verifierReadRpc(config.supabaseUrl, file, {
            tenantId: policy.tenantId,
            workloadId: policy.targetWorkloadId,
            principalKind: role,
            servicePrincipal: principals[role],
          }),
        ]),
    );
    // Only the configured principals are reachable; every peer must be the
    // policy's own producer/controller identity, never an extra mapping.
    for (const peer of config.peers) if (peer.spiffeId !== principals[peer.role]) throw new Error();
    const authority = roleRoutedKeyAuthority(policyText, config.policySha256, reads);
    const service = new LocalKeyService(config.keyDirectory, authority);
    const operator = {
      tenantId: policy.tenantId,
      workloadId: policy.targetWorkloadId,
      role: 'operator' as const,
      servicePrincipal: principals.operator,
    };
    return {
      mode: args[0] as '--check' | '--provision' | '--serve',
      provision: () => service.provision(operator, policy.keyPolicy.primary),
      serve: (stop: AbortSignal, onRefused?: () => void) => {
        if (!reads.controller && !reads.producer) throw new Error();
        const health = new IssuerSyncHealth(
          config.workload.issuerNodeId,
          config.workload.healthFile,
        );
        const source = new WorkloadApiX509Source(
          {
            socketPath: config.workload.socketPath,
            spiffeId: config.workload.spiffeId,
            purpose: 'server',
          },
          health,
        );
        const identities = new LocalKeyTlsIdentities([
          {
            spiffeId: config.workload.spiffeId,
            servicePrincipal: config.workload.spiffeId,
            tenantId: policy.tenantId,
            workloadId: policy.targetWorkloadId,
            role: 'key_service',
          },
          ...config.peers.map((peer) => ({
            spiffeId: peer.spiffeId,
            servicePrincipal: peer.spiffeId,
            tenantId: policy.tenantId,
            workloadId: policy.targetWorkloadId,
            role: peer.role,
          })),
        ]);
        const resolveAcceptedRun = reads.controller
          ? acceptedRunResolver(
              { tenantId: policy.tenantId, policyId: policy.policyId },
              reads.controller,
            )
          : async () => {
              throw new Error('Refused');
            };
        return runGenerations(
          (deadline) =>
            serveLocalKeyMtlsGeneration({
              source,
              identities,
              service,
              endpoint: config.endpoint,
              deadline,
              resolveAcceptedRun,
              listening: () => {},
            }),
          stop,
          { onRefused },
        );
      },
    };
  } catch {
    throw new Error('Local key service startup refused');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const prepared = await prepareLocalKeyService(process.argv.slice(2));
    if (prepared.mode === '--check') {
      process.stdout.write('Local key service configuration checks passed.\n');
    } else if (prepared.mode === '--provision') {
      await prepared.provision();
      process.stdout.write('Primary key version provisioned.\n');
    } else {
      const stop = new AbortController();
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort());
      process.stdout.write('Local key service serving.\n');
      await prepared.serve(stop.signal);
    }
  } catch {
    process.stderr.write('Local key service refused.\n');
    process.exitCode = 1;
  }
}
