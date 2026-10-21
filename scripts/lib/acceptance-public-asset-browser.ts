/** Private rendezvous for ONE owned normal-Auth browser/controller fixture.
 * No HTTP control endpoint, tokens, workload credentials or target SQL. */
import {
  lstatSync,
  readdirSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync,
  linkSync,
  unlinkSync,
} from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { loadParityFixture } from './parity-fixture-target-core.js';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { parseCatalogueJson } from '../../packages/control-library/src/index.js';
import { AssessmentRequestSchema } from '../../packages/types/src/assessment-request.js';

/** Preserve only the trusted interpreter toolchain paths, never ambient credentials. */
export function registeredRuntimeToolchainEnvironment(environment: NodeJS.ProcessEnv) {
  return {
    ...(environment.PATH === undefined ? {} : { PATH: environment.PATH }),
    ...(environment.LD_LIBRARY_PATH === undefined
      ? {}
      : { LD_LIBRARY_PATH: environment.LD_LIBRARY_PATH }),
  };
}

const uuid = z.uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const registeredBrowserConfigSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('owned-demo-registered-website-browser'),
    nonce: z.string().regex(/^[a-f0-9]{32}$/),
    codeSha: z.string().regex(/^[a-f0-9]{40}$/),
    databaseId: z.string().regex(/^[a-f0-9]{64}$/),
    projectId: z.string().regex(/^axiom-[a-z0-9-]{1,64}$/),
    apiOrigin: z.literal('http://127.0.0.1:56321'),
    bffOrigin: z.literal('http://127.0.0.1:4400'),
    tenantId: uuid,
    tenantSlug: z.string().regex(/^worker-[a-f0-9-]{36}$/),
    actorId: uuid,
    estateId: uuid,
    systemId: uuid,
    engagementId: uuid,
    isDemo: z.literal(true),
    publicUrl: z.literal('https://fixture.axiomproof.ai/'),
    email: z.email().endsWith('@example.invalid'),
    password: z.string().min(32).max(256),
    loginSecret: z.string().regex(/^[A-Z2-7]{16,128}$/),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.tenantSlug !== `worker-${value.tenantId}`)
      ctx.addIssue({ code: 'custom', message: 'fixture tenant mismatch' });
  });
export type RegisteredBrowserConfig = z.infer<typeof registeredBrowserConfigSchema>;
/** Pure fixture configuration boundary; server-only metadata must not leak. */
export function createRegisteredBrowserConfig(
  base: Record<string, unknown>,
  scope: Record<string, unknown>,
) {
  const selected = z
    .object({ estateId: uuid, systemId: uuid, engagementId: uuid })
    .safeParse(scope);
  if (!selected.success) throw new Error('registered browser scope refused');
  return registeredBrowserConfigSchema.parse({
    ...base,
    estateId: selected.data.estateId,
    systemId: selected.data.systemId,
    engagementId: selected.data.engagementId,
  });
}
export const registeredBrowserSubmissionSchema = z
  .object({
    version: z.literal(1),
    nonce: z.string().regex(/^[a-f0-9]{32}$/),
    tenantId: uuid,
    actorId: uuid,
    engagementId: uuid,
    checkId: uuid,
    bindingId: uuid,
    drishtiObservationId: uuid,
    vibhaagObservationId: uuid,
    targetId: uuid,
    associationId: uuid,
    associationSha256: digest,
    targetSha256: digest,
    reviewId: uuid,
    reviewRequestSha256: digest,
    reviewSnapshotSha256: digest,
    jobId: uuid,
    runId: uuid,
    requestText: z.string().min(1).max(32_768),
    requestSha256: digest,
    observedStatus: z.literal(202),
  })
  .strict();
export type RegisteredBrowserSubmission = z.infer<typeof registeredBrowserSubmissionSchema>;

export function registeredBrowserRequested(environment: NodeJS.ProcessEnv = process.env) {
  const value = environment.AXIOM_REGISTERED_WEBSITE_BROWSER;
  if (value !== undefined && value !== 'true') throw new Error('registered browser mode refused');
  if (value === 'true' && environment.AXIOM_PUBLIC_CONTROL_REPORT_ACCEPTANCE !== 'true')
    throw new Error('registered browser requires report fixture');
  return value === 'true';
}
export function registeredBrowserDirectory(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (!registeredBrowserRequested(environment)) throw new Error('registered browser not selected');
  const selected = environment.AXIOM_REGISTERED_WEBSITE_BROWSER_DIRECTORY;
  if (!selected || !isAbsolute(selected)) throw new Error('registered browser directory refused');
  const nested = relative(join(realpathSync(root), '.axiom-runtime'), selected);
  if (!nested || nested.startsWith('..') || isAbsolute(nested))
    throw new Error('registered browser directory refused');
  return selected;
}
function secureDirectory(directory: string) {
  const metadata = lstatSync(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    realpathSync(directory) !== directory
  )
    throw new Error('registered browser private directory refused');
}
export function writeRegisteredBrowserFile(
  directory: string,
  name: 'config' | 'submission',
  value: unknown,
) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  secureDirectory(directory);
  const parsed =
    name === 'config'
      ? registeredBrowserConfigSchema.safeParse(value)
      : registeredBrowserSubmissionSchema.safeParse(value);
  if (!parsed.success) throw new Error('registered browser file refused');
  // The final name must never expose a partially written JSON record. A hard
  // link publishes the closed file atomically and refuses an existing target.
  const temporary = join(directory, `.${name}-${randomUUID()}.private.json`);
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(descriptor, JSON.stringify(parsed.data));
    } finally {
      closeSync(descriptor);
    }
    secureDirectory(directory);
    linkSync(temporary, join(directory, `${name}.private.json`));
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
}
export function readRegisteredBrowserFile(
  directory: string,
  name: 'config',
): RegisteredBrowserConfig;
export function readRegisteredBrowserFile(
  directory: string,
  name: 'submission',
): RegisteredBrowserSubmission;
export function readRegisteredBrowserFile(directory: string, name: 'config' | 'submission') {
  secureDirectory(directory);
  const path = join(directory, `${name}.private.json`);
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.size > 65_536
  )
    throw new Error('registered browser file refused');
  try {
    const raw: unknown = parseCatalogueJson(readFileSync(path, 'utf8'), 65_536);
    const parsed =
      name === 'config'
        ? registeredBrowserConfigSchema.safeParse(raw)
        : registeredBrowserSubmissionSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
  } catch {
    /* Never expose credentials or malformed input. */
  }
  throw new Error('registered browser file refused');
}
export function validateRegisteredSubmission(config: RegisteredBrowserConfig, input: unknown) {
  const parsed = registeredBrowserSubmissionSchema.safeParse(input);
  if (!parsed.success) throw new Error('registered browser submission refused');
  const value = parsed.data;
  for (const field of ['nonce', 'tenantId', 'actorId', 'engagementId'] as const)
    if (value[field] !== config[field])
      throw new Error('registered browser submission scope refused');
  if (createHash('sha256').update(value.requestText, 'utf8').digest('hex') !== value.requestSha256)
    throw new Error('registered browser request digest refused');
  let request: unknown;
  try {
    request = parseCatalogueJson(value.requestText, 32_768);
  } catch {
    throw new Error('registered browser request refused');
  }
  const expected = AssessmentRequestSchema.safeParse(request);
  if (
    !expected.success ||
    !expected.data.reviewRef ||
    expected.data.operationKey !== value.jobId ||
    expected.data.engagementId !== config.engagementId ||
    expected.data.reviewRef.reviewId !== value.reviewId ||
    expected.data.reviewRef.requestSha256 !== value.reviewRequestSha256 ||
    expected.data.reviewRef.snapshotSha256 !== value.reviewSnapshotSha256
  )
    throw new Error('registered browser request binding refused');
  return value;
}
/** One absolute caller-owned deadline. No retries of mutations or fresh time windows. */
export async function waitForRegisteredSubmission(
  directory: string,
  config: RegisteredBrowserConfig,
  options: { deadline: number; signal: AbortSignal; browserAlive: () => boolean },
) {
  while (Date.now() < options.deadline && !options.signal.aborted && options.browserAlive()) {
    try {
      return validateRegisteredSubmission(
        config,
        readRegisteredBrowserFile(directory, 'submission'),
      );
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    await delay(Math.min(100, Math.max(0, options.deadline - Date.now())), undefined, {
      signal: options.signal,
    });
  }
  throw new Error('registered browser submission unavailable before original deadline');
}

export function readOwnedRegisteredBrowser(root: string) {
  const directory = registeredBrowserDirectory(root);
  const config = readRegisteredBrowserFile(directory, 'config');
  const fixture = loadParityFixture(root);
  if (
    config.codeSha !==
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() ||
    fixture.projectId !== config.projectId ||
    fixture.databaseId !== config.databaseId ||
    fixture.apiOrigin !== config.apiOrigin
  )
    throw new Error('registered browser owned source refused');
  return { directory, config };
}
export async function verifyRegisteredBrowserServer(config: RegisteredBrowserConfig) {
  const response = await fetch(config.bffOrigin + '/health', {
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok || response.headers.get('x-axiom-owned-fixture') !== config.nonce)
    throw new Error('registered browser live backend refused');
}

/** Only the opt-in same-backend fixture wraps Playwright's detached groups. */
export function prepareRegisteredBrowserLaunchers(
  root: string,
  directory: string,
  config: RegisteredBrowserConfig,
) {
  secureDirectory(directory);
  if (
    config.codeSha !==
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  )
    throw new Error('registered launcher source refused');
  const requireFromWeb = createRequire(join(root, 'apps/web/package.json'));
  const requireFromTests = createRequire(join(root, 'tests/e2e/package.json'));
  const playwright = requireFromTests('@playwright/test') as {
    chromium: { executablePath: () => string };
  };
  const python = realpathSync(
    execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8',
    }).trim(),
  );
  const digestFile = (path: string) => {
    const digest = createHash('sha256'),
      buffer = Buffer.alloc(1024 * 1024),
      descriptor = openSync(path, 'r');
    try {
      let bytes: number;
      while ((bytes = readSync(descriptor, buffer, 0, buffer.length, null)) > 0)
        digest.update(buffer.subarray(0, bytes));
    } finally {
      closeSync(descriptor);
    }
    return { path, sha256: digest.digest('hex') };
  };
  const launchConfig = {
    version: 1,
    nonce: config.nonce,
    codeSha: config.codeSha,
    root: realpathSync(root),
    node: digestFile(realpathSync(process.execPath)),
    python: digestFile(python),
    next: digestFile(realpathSync(requireFromWeb.resolve('next/dist/bin/next'))),
    chromium: digestFile(realpathSync(playwright.chromium.executablePath())),
  };
  writeFileSync(join(directory, 'launch-config.private.json'), JSON.stringify(launchConfig), {
    flag: 'wx',
    mode: 0o600,
  });
  const quote = (v: string) => "'" + v.replaceAll("'", "'\"'\"'") + "'";
  for (const kind of ['next', 'chromium']) {
    const command = [
      python,
      join(root, 'scripts/test-workload-identity.py'),
      '--owned-browser-launch',
      kind,
      directory,
      config.nonce,
      config.codeSha,
    ]
      .map(quote)
      .join(' ');
    writeFileSync(join(directory, kind + '-launcher'), '#!/bin/sh\nexec ' + command + ' "$@"\n', {
      flag: 'wx',
      mode: 0o700,
    });
  }
}
export function registeredBrowserLaunchPaths(directory: string) {
  secureDirectory(directory);
  for (const kind of ['next', 'chromium']) {
    const path = join(directory, kind + '-launcher'),
      info = lstatSync(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (info.mode & 0o777) !== 0o700 ||
      realpathSync(path) !== path
    )
      throw new Error('registered launcher refused');
  }
  const quote = (v: string) => "'" + v.replaceAll("'", "'\"'\"'") + "'";
  return {
    nextCommand: 'exec ' + quote(join(directory, 'next-launcher')),
    chromiumExecutable: join(directory, 'chromium-launcher'),
  };
}
export function cleanupRegisteredBrowserGroups(
  root: string,
  directory: string,
  config: RegisteredBrowserConfig,
) {
  secureDirectory(directory);
  try {
    lstatSync(join(directory, 'launch-config.private.json'));
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT' &&
      !readdirSync(directory).some((name) => name.startsWith('group-'))
    )
      return { registeredGroups: 0, signalledGroups: 0 };
    throw new Error('registered launch registry unavailable');
  }
  const result = execFileSync(
    'python3',
    [
      join(root, 'scripts/test-workload-identity.py'),
      '--cleanup-owned-browser-groups',
      directory,
      config.nonce,
      config.codeSha,
    ],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 },
  );
  const parsed = z
    .object({
      registeredGroups: z.number().int().min(0).max(16),
      signalledGroups: z.number().int().min(0).max(16),
    })
    .strict()
    .safeParse(JSON.parse(result));
  if (!parsed.success) throw new Error('registered group cleanup unconfirmed');
  return parsed.data;
}
