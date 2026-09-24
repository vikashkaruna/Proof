import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Privileged test configuration. Never import this module into an application bundle. */
export interface AcceptanceTarget {
  schemaVersion: 1;
  deploymentId: string;
  environment: 'staging' | 'preprod' | 'production' | 'onprem';
  topology: 'local-docker' | 'remote';
  syntheticFixtures: true;
  bffUrl: string;
  webUrl: string;
  marketingUrl: string;
  supabaseUrl: string;
  anonKey: string;
  publishableKey: string;
  serviceKey: string;
  expectedRevision: string;
}
const environments = ['staging', 'preprod', 'production', 'onprem'];
const originKeys = ['bffUrl', 'webUrl', 'marketingUrl', 'supabaseUrl'] as const;
const keys = [
  'schemaVersion',
  'deploymentId',
  'environment',
  'topology',
  'syntheticFixtures',
  ...originKeys,
  'anonKey',
  'publishableKey',
  'serviceKey',
  'expectedRevision',
];
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function validateAcceptanceTarget(value: unknown): AcceptanceTarget {
  requireValue(
    value && typeof value === 'object' && !Array.isArray(value),
    'Acceptance target must be an object',
  );
  const v = value as Record<string, unknown>;
  requireValue(
    Object.keys(v).every((k) => keys.includes(k)),
    'Acceptance target has unknown fields',
  );
  requireValue(
    v.schemaVersion === 1 && v.syntheticFixtures === true,
    'Acceptance target requires schemaVersion 1 and explicit syntheticFixtures=true',
  );
  requireValue(
    typeof v.deploymentId === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(v.deploymentId),
    'Invalid acceptance deployment ID',
  );
  requireValue(
    typeof v.environment === 'string' && environments.includes(v.environment),
    'Invalid acceptance environment',
  );
  requireValue(
    v.topology === 'local-docker' || v.topology === 'remote',
    'Invalid acceptance topology',
  );
  requireValue(
    typeof v.expectedRevision === 'string' && /^[a-f0-9]{40}$/.test(v.expectedRevision),
    'Acceptance target requires an exact revision',
  );
  for (const field of originKeys) {
    requireValue(typeof v[field] === 'string', `Missing ${field}`);
    let url: URL;
    try {
      url = new URL(v[field]);
    } catch {
      throw new Error(`Invalid ${field}`);
    }
    requireValue(
      !url.username && !url.password && !url.search && !url.hash && url.pathname === '/',
      'Acceptance endpoints must be origins without credentials, paths or queries',
    );
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    requireValue(
      v.topology === 'remote'
        ? url.protocol === 'https:' && !local
        : url.protocol === 'http:' && local,
      'Remote acceptance requires HTTPS; local Docker acceptance requires loopback HTTP',
    );
    v[field] = url.origin;
  }
  for (const field of ['anonKey', 'publishableKey', 'serviceKey'])
    requireValue(
      typeof v[field] === 'string' && (v[field] as string).length >= 20,
      `Missing ${field}`,
    );
  return v as unknown as AcceptanceTarget;
}
export function loadAcceptanceTarget(
  file = process.env.AXIOM_ACCEPTANCE_TARGET,
): AcceptanceTarget | null {
  if (!file) return null;
  const location = resolve(file);
  // Check and read through one descriptor so the file cannot be swapped between them.
  const fd = openSync(location, 'r');
  let value: unknown;
  try {
    const mode = fstatSync(fd).mode;
    requireValue(
      process.platform === 'win32' || (mode & 0o077) === 0,
      'Acceptance target credentials require a private file (chmod 600)',
    );
    try {
      value = JSON.parse(readFileSync(fd, 'utf8'));
    } catch {
      throw new Error('Cannot parse acceptance target file');
    }
  } finally {
    closeSync(fd);
  }
  return validateAcceptanceTarget(value);
}
/** Bind fixtures/results to the selected deployment; never reuse the local persona file. */
export function acceptanceStatePath(target: AcceptanceTarget | null, root = process.cwd()): string {
  return resolve(
    root,
    target
      ? `.axiom-runtime/acceptance/${target.deploymentId}/personas.json`
      : '.axiom-runtime/personas/state.json',
  );
}
export async function verifyAcceptanceTarget(
  target: AcceptanceTarget,
  checkMarketing = true,
): Promise<void> {
  const response = await fetch(`${target.bffUrl}/health`, {
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  requireValue(response.status === 200, 'Acceptance BFF health failed');
  const health = (await response.json()) as Record<string, unknown>;
  requireValue(
    health.environment === target.environment &&
      health.authMode === 'strict' &&
      health.revision === target.expectedRevision,
    'Acceptance BFF identity/configuration does not match the target',
  );
  const refusal = await fetch(`${target.bffUrl}/v1/engagements`, {
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  requireValue(refusal.status === 401, 'Acceptance BFF did not refuse unauthenticated access');
  const reportConfig = await fetch(`${target.bffUrl}/public/gap-scan/config`, {
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  requireValue(reportConfig.status === 200, 'Acceptance report configuration unavailable');
  requireValue(
    ((await reportConfig.json()) as Record<string, unknown>).emailDeliveryEnabled === false,
    'Acceptance report journeys require disabled external email delivery',
  );
  if (checkMarketing) {
    for (const origin of [target.webUrl, target.marketingUrl]) {
      const response = await fetch(`${origin}/api/health`, {
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      requireValue(response.status === 200, 'Acceptance SSR health failed');
      const identity = (await response.json()) as Record<string, unknown>;
      requireValue(
        identity.environment === target.environment &&
          identity.authMode === 'strict' &&
          identity.revision === target.expectedRevision,
        'Acceptance SSR identity/configuration does not match the target',
      );
    }

    const marketing = await fetch(`${target.marketingUrl}/api/contact`, {
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    requireValue(marketing.status === 200, 'Acceptance marketing health failed');
    const status = (await marketing.json()) as Record<string, unknown>;
    requireValue(
      status.emailConfigured === false,
      'Acceptance contact journey requires disabled external email delivery',
    );
  }
}
