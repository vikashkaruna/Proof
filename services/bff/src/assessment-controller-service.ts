import { pathToFileURL } from 'node:url';
import { X509Certificate } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  controllerFilePath,
  readControllerFile,
  controllerBackendCredentials,
} from './workloads/controller-files.js';
import {
  composeVmAssessmentController,
  vmControllerConfiguration,
} from './workloads/assessment-vm.js';
import { createRemoteAssessmentServer } from './workloads/assessment-remote.js';

export const controllerServiceConfiguration = z
  .object({
    controller: vmControllerConfiguration,
    listen: z
      .object({
        host: z.enum(['127.0.0.1', '0.0.0.0']),
        port: z.number().int().min(1024).max(65535),
      })
      .strict(),
    tls: z.object({ keyFile: controllerFilePath, certFile: controllerFilePath }).strict(),
    backendServiceKeyFile: controllerFilePath,
  })
  .strict();

export async function prepareControllerService(args: string[], env: NodeJS.ProcessEnv) {
  try {
    if (args.length !== 2 || !['--check', '--serve'].includes(args[0]!)) throw new Error();
    const config = controllerServiceConfiguration.parse(
      JSON.parse((await readControllerFile(args[1]!)).toString('utf8')),
    );
    // This entrypoint has no development credential/transport fallback. Local
    // integration supplies its real fixture DB client to the same composition.
    const backend = await controllerBackendCredentials(config.backendServiceKeyFile, env);
    const key = await readControllerFile(config.tls.keyFile);
    const cert = await readControllerFile(config.tls.certFile);
    const certificate = new X509Certificate(cert);
    const now = Date.now();
    if (
      !certificate.checkHost(new URL(config.controller.scheduler.audience).hostname) ||
      now < Date.parse(certificate.validFrom) ||
      now >= Date.parse(certificate.validTo)
    )
      throw new Error();
    const db = createClient(backend.url, backend.serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // HTTPS construction verifies the key/certificate pair before any listener.
    const components = await composeVmAssessmentController(config.controller, db);
    const server = createRemoteAssessmentServer({ ...components, tls: { key, cert } });
    return { server, listen: config.listen, mode: args[0] };
  } catch {
    throw new Error('VM assessment controller startup refused');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const prepared = await prepareControllerService(process.argv.slice(2), process.env);
    if (prepared.mode === '--check') {
      process.stdout.write('Controller configuration and read-only startup checks passed.\n', () =>
        process.exit(0),
      );
    } else {
      await new Promise<void>((done, reject) => {
        prepared.server.once('error', reject);
        prepared.server.listen(prepared.listen.port, prepared.listen.host, () => {
          prepared.server.off('error', reject);
          done();
        });
      });
      prepared.server.on('error', () => {
        process.stderr.write('Private assessment controller stopped.\n', () => process.exit(1));
      });
      process.stdout.write('Private assessment controller listening.\n');
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        // No launch retry. A forced exit can leave committed DB work; recover
        // independently from durable receipts after the next controlled start.
        const timer = setTimeout(() => {
          prepared.server.closeAllConnections();
          process.exit(1);
        }, 85000);
        prepared.server.close(() => {
          clearTimeout(timer);
          process.exit(0);
        });
        prepared.server.closeIdleConnections();
      };
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
    }
  } catch {
    process.stderr.write('VM assessment controller startup refused.\n', () => process.exit(1));
  }
}
