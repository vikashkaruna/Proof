import { requireLocalX509Material } from './workloads/local-x509-preflight.js';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  controllerFilePath,
  readControllerFile,
  controllerBackendCredentials,
  requireControllerBackend,
} from './workloads/controller-files.js';
import {
  composeLocalAssessmentController,
  localControllerConfiguration,
} from './workloads/assessment-vm.js';
import { startAssessmentControllerSocket } from './workloads/assessment-socket.js';

export const localControllerServiceConfiguration = z
  .object({
    controller: localControllerConfiguration,
    socket: z
      .object({
        directory: controllerFilePath,
        socketGroup: z.number().int().min(0).max(2147483647),
      })
      .strict(),
    backendServiceKeyFile: controllerFilePath,
  })
  .strict();

/** Local co-located assessment controller (D1: Unix-socket scheduler auth,
 * D2: operator-managed custody). No TCP listener and no cloud scheduler: the
 * private socket's OS permissions authenticate the co-located scheduler, and
 * the backend credential is the same least-privilege controller role the VM
 * entrypoint uses (plain HTTP only to this machine or its container network). */
export async function prepareLocalController(args: string[], env: NodeJS.ProcessEnv) {
  try {
    if (args.length !== 2 || !['--check', '--serve'].includes(args[0]!)) throw new Error();
    const config = localControllerServiceConfiguration.parse(
      JSON.parse((await readControllerFile(args[1]!)).toString('utf8')),
    );
    const backend = await controllerBackendCredentials(
      config.backendServiceKeyFile,
      env,
      config.controller.tenantId,
      { localHttp: true },
    );
    const db = createClient(backend.url, backend.apiKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${backend.accessToken}` } },
    });
    await requireControllerBackend(db, config.controller.tenantId);
    const components = await composeLocalAssessmentController(config.controller, db);
    if (args[0] === '--check')
      await requireLocalX509Material(config.controller.keys.workload, 'client');
    return {
      mode: args[0] as '--check' | '--serve',
      serve: () =>
        startAssessmentControllerSocket({
          directory: config.socket.directory,
          socketGroup: config.socket.socketGroup,
          controller: components.controller,
          scheduling: components.scheduling,
          monitoring: components.monitoring,
        }),
    };
  } catch {
    throw new Error('Local assessment controller startup refused');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const prepared = await prepareLocalController(process.argv.slice(2), process.env);
    if (prepared.mode === '--check') {
      process.stdout.write('Local controller configuration and read-only checks passed.\n');
    } else {
      const socket = await prepared.serve();
      process.stdout.write('Local assessment controller listening on its private socket.\n');
      for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.once(signal, () => void socket.close().finally(() => process.exit(0)));
    }
  } catch {
    process.stderr.write('Local assessment controller refused.\n');
    process.exitCode = 1;
  }
}
