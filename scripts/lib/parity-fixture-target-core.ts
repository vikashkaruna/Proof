/** Engineering-owned local fixture authority. Never select a retained/foreign
 * Supabase project merely because its container name or API port matches. */
import childProcess from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { z } from 'zod';

export interface ParityFixtureSelection {
  root: string;
  stateDirectory: string;
  configPath: string;
  statusPath: string;
  projectId: string;
  databaseContainer: string;
  apiContainer: string;
}
export function selectParityFixture(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
): ParityFixtureSelection {
  root = resolve(root);
  const projectId = environment.AXIOM_PARITY_PROJECT_ID ?? 'axiom-w0-parity';
  if (!/^axiom-[a-z0-9-]{1,64}$/.test(projectId)) throw new Error('Fixture project refused');
  const stateDirectory = resolve(
    root,
    environment.AXIOM_PARITY_STATE_DIR ?? '.axiom-runtime/parity',
  );
  const selected = relative(join(root, '.axiom-runtime'), stateDirectory);
  if (!selected || selected.startsWith('..') || isAbsolute(selected))
    throw new Error('Fixture state refused');
  return Object.freeze({
    root,
    stateDirectory,
    configPath: join(stateDirectory, 'supabase/config.toml'),
    statusPath: join(stateDirectory, 'status.json'),
    projectId,
    databaseContainer: `supabase_db_${projectId}`,
    apiContainer: `supabase_kong_${projectId}`,
  });
}
export interface ParityFixtureEvidence {
  resolvedRoot: string;
  resolvedStateDirectory: string;
  resolvedConfigPath: string;
  resolvedStatusPath: string;
  config: string;
  status: Record<string, string>;
  databaseId: string;
  databaseLabels: Record<string, string>;
  apiLabels: Record<string, string>;
  databasePorts: Record<string, Array<{ HostIp: string; HostPort: string }> | null>;
  apiPorts: Record<string, Array<{ HostIp: string; HostPort: string }> | null>;
}
export function validateParityFixtureEvidence(
  selection: ParityFixtureSelection,
  evidence: ParityFixtureEvidence,
) {
  if (
    evidence.resolvedRoot !== selection.root ||
    evidence.resolvedStateDirectory !== selection.stateDirectory ||
    evidence.resolvedConfigPath !== selection.configPath ||
    evidence.resolvedStatusPath !== selection.statusPath
  )
    throw new Error('Fixture canonical paths refused');
  const projects = [...evidence.config.matchAll(/^\s*project_id\s*=\s*"([^"]+)"\s*$/gm)];
  if (projects.length !== 1 || projects[0]![1] !== selection.projectId)
    throw new Error('Fixture configuration refused');
  let api: URL;
  try {
    api = new URL(evidence.status.API_URL!);
  } catch {
    throw new Error('Fixture API refused');
  }
  if (
    /[?#@]/.test(evidence.status.API_URL!) ||
    api.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(api.hostname) ||
    api.port !== '56321' ||
    api.pathname !== '/' ||
    api.username ||
    api.password ||
    api.search ||
    api.hash
  )
    throw new Error('Fixture API refused');
  if (!/^[a-f0-9]{64}$/.test(evidence.databaseId))
    throw new Error('Fixture Docker identity refused');
  for (const labels of [evidence.databaseLabels, evidence.apiLabels]) {
    if (
      labels['com.supabase.cli.project'] !== selection.projectId ||
      labels['com.supabase.cli.workdir'] !== selection.stateDirectory
    )
      throw new Error('Fixture Docker ownership refused');
  }
  for (const [ports, port, hostPort] of [
    [evidence.databasePorts, '5432/tcp', '56322'],
    [evidence.apiPorts, '8000/tcp', '56321'],
  ] as const) {
    const bindings = ports[port];
    if (
      !bindings?.length ||
      !bindings.every(
        (binding) =>
          binding.HostPort === hostPort && ['127.0.0.1', '0.0.0.0', '::'].includes(binding.HostIp),
      )
    )
      throw new Error('Fixture Docker ports refused');
  }
  return Object.freeze({
    ...selection,
    databaseId: evidence.databaseId,
    status: evidence.status,
    apiOrigin: api.origin,
  });
}
export function loadParityFixture(
  root = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
) {
  const selection = selectParityFixture(realpathSync(root), environment);
  const canonical = {
    resolvedRoot: realpathSync(selection.root),
    resolvedStateDirectory: realpathSync(selection.stateDirectory),
    resolvedConfigPath: realpathSync(selection.configPath),
    resolvedStatusPath: realpathSync(selection.statusPath),
  };
  if (
    canonical.resolvedRoot !== selection.root ||
    canonical.resolvedStateDirectory !== selection.stateDirectory ||
    canonical.resolvedConfigPath !== selection.configPath ||
    canonical.resolvedStatusPath !== selection.statusPath
  )
    throw new Error('Fixture canonical paths refused');

  const inspect = (container: string) =>
    JSON.parse(
      childProcess.execFileSync(
        'docker',
        [
          'inspect',
          '--format',
          '{"id":{{json .Id}},"labels":{{json .Config.Labels}},"ports":{{json .NetworkSettings.Ports}}}',
          container,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 },
      ),
    );
  const database = inspect(selection.databaseContainer),
    api = inspect(selection.apiContainer);
  const status = z
    .record(z.string(), z.string())
    .parse(JSON.parse(readFileSync(selection.statusPath, 'utf8')));
  return validateParityFixtureEvidence(selection, {
    ...canonical,
    config: readFileSync(selection.configPath, 'utf8'),
    status,
    databaseId: database.id,
    databaseLabels: database.labels,
    apiLabels: api.labels,
    databasePorts: database.ports,
    apiPorts: api.ports,
  });
}
/** Revalidate filesystem/config/API and actual Docker ownership before EVERY
 * administrative SQL invocation, including cleanup/revocation. SQL is stdin;
 * credentials, statements and raw stderr never appear in diagnostics. */
export function guardedParitySql(
  statement: string,
  role: 'postgres' | 'supabase_admin' = 'supabase_admin',
  root = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
) {
  const selected = loadParityFixture(root, environment);
  return childProcess.execFileSync(
    'docker',
    [
      'exec',
      '-i',
      selected.databaseId,
      'psql',
      '-X',
      '-U',
      role,
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-Atq',
    ],
    { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 },
  );
}
