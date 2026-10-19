import { requireLocalX509Material } from './workloads/local-x509-preflight.js';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { decodeJwt } from 'jose';
import { z } from 'zod';
import { controllerFilePath, readControllerFile } from './workloads/controller-files.js';
import {
  assessmentProducerConfiguration,
  composeAssessmentProducer,
} from './workloads/assessment-producer.js';
import { startAssessmentProducerSocket } from './workloads/assessment-producer-socket.js';

export const localProducerServiceConfiguration = z
  .object({
    producer: assessmentProducerConfiguration,
    socket: z
      .object({
        directory: controllerFilePath,
        socketGroup: z.number().int().nonnegative().max(2147483647),
      })
      .strict(),
    backendFile: controllerFilePath,
    agentWriterFile: controllerFilePath.optional(),
  })
  .strict();

const backendConfiguration = z
  .object({
    url: z.url().refine((s) => {
      const url = new URL(s);
      return (
        (url.protocol === 'https:' ||
          (url.protocol === 'http:' &&
            (['localhost', '127.0.0.1', 'host.docker.internal'].includes(url.hostname) ||
              /^[a-z0-9][a-z0-9_-]{0,62}$/.test(url.hostname)))) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    }),
    anonKey: z.string().min(32).max(4096),
    serviceKey: z.string().min(32).max(4096),
    humanWriterKey: z.string().min(32).max(4096),
  })
  .strict();

/** Dedicated producer UID receives its SVID from SPIRE. Credentials are loaded
 * from an operator-owned 0600 file, never container environment selectors.
 * Controller credentials and key unwrapping are deliberately absent. */
export async function prepareLocalProducer(args: string[], env: NodeJS.ProcessEnv) {
  let configBytes: Buffer | undefined;
  let backendBytes: Buffer | undefined;
  let agentBytes: Buffer | undefined;
  try {
    if (args.length !== 2 || !['--check', '--serve'].includes(args[0]!)) throw new Error();
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
      'PORT',
      'AXIOM_RELEASE_SHA',
      'NODE_EXTRA_CA_CERTS',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
    ]);
    if (Object.keys(env).some((key) => env[key] !== undefined && !allowed.has(key)))
      throw new Error();
    for (const key of ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'])
      if (env[key] !== undefined) controllerFilePath.parse(env[key]);
    configBytes = await readControllerFile(args[1]!);
    const config = localProducerServiceConfiguration.parse(
      JSON.parse(configBytes.toString('utf8')),
    );
    if (config.producer.tenants.some((tenant) => tenant.keys.provider !== 'local'))
      throw new Error();
    backendBytes = await readControllerFile(config.backendFile);
    const backend = backendConfiguration.parse(JSON.parse(backendBytes.toString('utf8')));
    for (const [key, role] of [
      [backend.anonKey, 'anon'],
      [backend.serviceKey, 'service_role'],
      [backend.humanWriterKey, 'human_action_writer'],
    ] as const) {
      const claims = decodeJwt(key);
      if (claims.role !== role || typeof claims.exp !== 'number' || claims.exp <= Date.now() / 1000)
        throw new Error();
    }
    const client = (key: string) =>
      createClient(backend.url, backend.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${key}` } },
      });
    const db = client(backend.serviceKey);
    const writer = client(backend.humanWriterKey);
    if (Boolean(config.agentWriterFile) !== config.producer.scheduledCoverageEnabled)
      throw new Error();
    let agent: ReturnType<typeof client> | undefined;
    if (config.agentWriterFile) {
      agentBytes = await readControllerFile(config.agentWriterFile);
      const key = agentBytes.toString('utf8').trim(),
        claims = decodeJwt(key);
      if (
        key.length > 4096 ||
        claims.role !== 'agent_ledger_writer' ||
        typeof claims.exp !== 'number' ||
        claims.exp <= Date.now() / 1000 ||
        key === backend.serviceKey ||
        key === backend.humanWriterKey
      )
        throw new Error();
      agent = client(key);
      const checked = await agent
        .rpc('scheduled_coverage_writer_check', {})
        .abortSignal(AbortSignal.timeout(5000));
      if (checked.error) throw new Error();
      z.object({
        schemaVersion: z.literal(1),
        authority: z.literal('explicit_owner_scope_required'),
        taskScopes: z.tuple([z.literal('control_library.read'), z.literal('findings.write')]),
      })
        .strict()
        .parse(checked.data);
    }
    const producer = await composeAssessmentProducer(config.producer, db, {
      writer: () => writer,
      ...(agent ? { agentWriter: () => agent! } : {}),
    });
    if (args[0] === '--check')
      for (const tenant of config.producer.tenants) {
        if (tenant.keys.provider !== 'local') throw new Error();
        await requireLocalX509Material(tenant.keys.workload, 'client');
      }
    return {
      mode: args[0] as '--check' | '--serve',
      coverage: producer.scheduledCoverage,
      serve: () => startAssessmentProducerSocket({ ...config.socket, producer }),
    };
  } catch {
    throw new Error('Local assessment producer startup refused');
  } finally {
    configBytes?.fill(0);
    backendBytes?.fill(0);
    agentBytes?.fill(0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const prepared = await prepareLocalProducer(process.argv.slice(2), process.env);
    if (prepared.mode === '--check')
      process.stdout.write('Local producer configuration and read-only checks passed.\n');
    else {
      const socket = await prepared.serve();
      const coverageAbort = new AbortController();
      if (prepared.coverage) void prepared.coverage.run(coverageAbort.signal);
      process.stdout.write('Local assessment producer listening on its private socket.\n');
      for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.once(signal, () => {
          coverageAbort.abort();
          void socket.close().finally(() => process.exit(0));
        });
    }
  } catch {
    process.stderr.write('Local assessment producer refused.\n');
    process.exitCode = 1;
  }
}
