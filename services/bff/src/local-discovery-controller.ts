import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { controllerFilePath, readControllerFile } from './workloads/controller-files.js';
import {
  assessmentContainerConfiguration,
  discoveryContainerFactory,
  verifyAssessmentContainerRuntime,
} from './workloads/assessment-container.js';
import { DiscoveryChannel } from './workloads/discovery-channel.js';
import { startDiscoverySocket } from './workloads/discovery-socket.js';
export const discoveryControllerConfiguration = z
  .object({
    schemaVersion: z.literal(1),
    environment: z.literal('local'),
    container: assessmentContainerConfiguration,
    brokerUrl: z
      .string()
      .url()
      .refine((s) => {
        const u = new URL(s);
        return (
          u.protocol === 'http:' &&
          ['127.0.0.1', 'localhost', 'host.docker.internal', 'axiom-bff'].includes(u.hostname) &&
          !u.username &&
          !u.password &&
          !u.search &&
          !u.hash &&
          u.pathname === '/internal/discovery/retained'
        );
      }),
    socket: z.object({ directory: controllerFilePath, socketGroup: z.literal(20112) }).strict(),
  })
  .strict();
export async function startLocalDiscoveryController(filename: string, checkOnly = false) {
  let bytes: Buffer | undefined;
  try {
    if (process.getuid?.() !== 20105) throw new Error();
    const allowed = new Set([
      'PATH',
      'HOME',
      'HOSTNAME',
      'NODE_VERSION',
      'YARN_VERSION',
      'PNPM_HOME',
      'NODE_ENV',
      'TSX_DISABLE_CACHE',
      'TZ',
      'LANG',
      'LC_ALL',
      'AXIOM_RELEASE_SHA',
    ]);
    if (
      Object.entries(process.env).some(([key, value]) => value !== undefined && !allowed.has(key))
    )
      throw new Error();
    bytes = await readControllerFile(filename);
    const config = discoveryControllerConfiguration.parse(JSON.parse(bytes.toString('utf8')));
    await verifyAssessmentContainerRuntime(config.container);
    if (checkOnly) return undefined;
    const channel = new DiscoveryChannel(
      discoveryContainerFactory(config.container),
      async (input, proof, signal) => {
        const response = await fetch(config.brokerUrl, {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: { 'content-type': 'application/json', 'x-workload-svid': proof },
          body: JSON.stringify(input),
        });
        if (
          !response.ok ||
          response.headers.get('content-type')?.split(';')[0] !== 'application/json'
        ) {
          await response.body?.cancel();
          throw new Error();
        }
        // Bounded streaming: neither a broken backend nor a bearer error can become
        // an unbounded IPC allocation or a controller log.
        const reader = response.body?.getReader();
        if (!reader) throw new Error();
        let output = Buffer.alloc(0);
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            output = Buffer.concat([output, part.value]);
            if (output.length > 4096) throw new Error();
          }
        } finally {
          await reader.cancel();
        }
        return z
          .object({ data: z.object({ requestId: z.uuid(), discoveryRunId: z.uuid() }).strict() })
          .strict()
          .parse(JSON.parse(output.toString('utf8'))).data;
      },
    );
    return await startDiscoverySocket({
      ...config.socket,
      run: (input, signal) => channel.run(input, signal),
    });
  } catch {
    throw new Error('Local discovery controller refused');
  } finally {
    bytes?.fill(0);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const filename = process.argv[2];
    const check = process.argv[3] === '--check';
    if (!filename || process.argv.length !== (check ? 4 : 3)) throw new Error();
    const server = await startLocalDiscoveryController(filename, check);
    if (!server) {
      process.stdout.write('Local discovery controller prerequisites verified.\n');
      process.exit(0);
    }
    process.stdout.write('Local discovery controller listening.\n');
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.once(signal, () => void server.close().finally(() => process.exit(0)));
  } catch {
    process.stderr.write('Local discovery controller refused.\n');
    process.exitCode = 1;
  }
}
