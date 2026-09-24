import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { decodeJwt } from 'jose';
import type { SupabaseClient } from '@supabase/supabase-js';

export const controllerFilePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((s) => s === resolve(s) && !/[\r\n\0]/.test(s));
/** Read protected deployment files, never following a mutable symlink. Parent
 * directories/mounts must also be operator-controlled. No contents in errors. */
export async function readControllerFile(filename: string): Promise<Buffer> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    controllerFilePath.parse(filename);
    if ((await realpath(filename)) !== filename) throw new Error();
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > 131072 ||
      stat.size < 1 ||
      (stat.mode & 0o077) !== 0 ||
      ![0, process.getuid?.()].includes(stat.uid)
    )
      throw new Error();
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) throw new Error();
    return bytes.subarray(0, bytesRead);
  } catch {
    throw new Error('Controller deployment file refused');
  } finally {
    try {
      await file?.close();
    } catch {
      throw new Error('Controller deployment file refused');
    }
  }
}

// The Docker workload attestor can emit Config.Env as selectors. This service
// therefore accepts a deliberately minimal non-secret environment and loads
// its backend credential directly from a protected file, never into process.env.
const controllerEnvironment = new Set([
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
  'AXIOM_REGION',
  'SUPABASE_URL',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GCLOUD_PROJECT',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_ROLE_ARN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
  'AWS_SDK_LOAD_CONFIG',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
]);
const credentialFileEnvironment = [
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
];

export async function controllerBackendCredentials(
  filename: string,
  env: NodeJS.ProcessEnv,
  tenantId: string,
) {
  let bytes: Buffer | undefined;
  try {
    if (Object.keys(env).some((key) => env[key] !== undefined && !controllerEnvironment.has(key)))
      throw new Error();
    for (const key of credentialFileEnvironment)
      if (env[key] !== undefined) controllerFilePath.parse(env[key]);
    const backend = z
      .object({
        AXIOM_REGION: z.literal('ap-south-1'),
        SUPABASE_URL: z.url().refine((s) => {
          const u = new URL(s);
          return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash;
        }),
      })
      .parse(env);
    bytes = await readControllerFile(filename);
    const credential = z
      .object({
        schemaVersion: z.literal(1),
        apiKey: z.string().min(32).max(4096),
        accessToken: z.string().min(32).max(4096),
      })
      .strict()
      .parse(JSON.parse(bytes.toString('utf8')));
    // Shape checks reject broad keys before any network request. They are not
    // signature verification: PostgREST verifies the signed token, then the
    // read-only database check below proves its current registered tenant.
    if (decodeJwt(credential.apiKey).role !== 'anon') throw new Error();
    const claims = z
      .object({
        role: z.literal('axiom_assessment_controller'),
        sub: z.uuid(),
        tenant_id: z.literal(z.uuid().parse(tenantId).toLowerCase()),
        iat: z.number().int().nonnegative(),
        exp: z.number().int().positive(),
      })
      .parse(decodeJwt(credential.accessToken));
    const now = Math.floor(Date.now() / 1000);
    if (
      claims.iat > now ||
      claims.exp <= now ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > 3600
    )
      throw new Error();
    return {
      url: backend.SUPABASE_URL,
      apiKey: credential.apiKey,
      accessToken: credential.accessToken,
    };
  } catch {
    throw new Error('Controller backend credentials refused');
  } finally {
    bytes?.fill(0);
  }
}

/** Read-only startup attestation by the backend. Never creates credentials or
 * trusts the locally decoded tenant in place of database enforcement. */
export async function requireControllerBackend(db: SupabaseClient, tenantId: string) {
  try {
    const { data, error } = await db
      .rpc('current_assessment_controller_tenant', {}, { get: true })
      .abortSignal(AbortSignal.timeout(10000));
    if (error || data !== tenantId) throw new Error();
  } catch {
    throw new Error('Controller backend scope refused');
  }
}
