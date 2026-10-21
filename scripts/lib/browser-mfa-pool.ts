import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

/** Explicit fixture optimization authority, never product authentication. */
export function browserMfaPoolEnabled(
  target: { topology: string; deploymentId: string; syntheticFixtures: boolean } | null,
  environment: { requested?: string; ci?: string; github?: string },
): boolean {
  if (environment.requested === undefined) return false;
  if (
    environment.requested !== 'isolated-w0' ||
    target?.topology !== 'local-docker' ||
    target.syntheticFixtures !== true ||
    !['http-preprod', 'http-production'].includes(target.deploymentId) ||
    environment.ci !== 'true' ||
    environment.github !== 'true'
  )
    throw new Error('Isolated browser MFA pool authority refused');
  return true;
}

const role = z.enum(['owner', 'admin', 'founder', 'axiom_analyst', 'approver', 'viewer']);
const bindingSchema = z
  .object({
    deploymentId: z.string().min(1),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    tenantId: z.guid(),
    bffUrl: z.url(),
    webUrl: z.url(),
    marketingUrl: z.url(),
    supabaseUrl: z.url(),
  })
  .strict();
export type MfaPoolBinding = z.infer<typeof bindingSchema>;
const identitySchema = z
  .object({
    role,
    internal: z.boolean(),
    profileCase: z.enum(['ordinary', 'long-account']).default('ordinary'),
  })
  .strict();
export type MfaPoolIdentity = z.input<typeof identitySchema>;
const accountSchema = identitySchema
  .extend({
    id: z.guid(),
    email: z.email(),
    password: z.string().min(1),
    totpSecret: z.string().regex(/^[A-Z2-7]{32}$/),
    consumedCounter: z.number().int().nonnegative().safe(),
  })
  .strict();
export type MfaPoolAccount = z.infer<typeof accountSchema>;
const manifestSchema = z
  .object({
    version: z.literal(1),
    binding: bindingSchema,
    createdAt: z.number().int().nonnegative().safe(),
    readyAfter: z.number().int().nonnegative().safe(),
    accounts: z.array(accountSchema).min(1).max(128),
  })
  .strict()
  .refine((value) => new Set(value.accounts.map((a) => a.id)).size === value.accounts.length)
  .refine(
    (value) =>
      new Set(value.accounts.map((a) => a.email.toLowerCase())).size === value.accounts.length,
  )
  .refine(
    (value) => new Set(value.accounts.map((a) => a.totpSecret)).size === value.accounts.length,
  )
  .refine(
    (value) =>
      value.readyAfter ===
      (Math.max(...value.accounts.map((a) => a.consumedCounter)) + 1) * 30_000 + 500,
  );
/** Exact catalogue demand: 24 owner helper sites plus the second format and
 * mandatory-owner case; 10 founder sites plus helper calls/loops and matrix;
 * 16 admin sites plus matrix; approval helper has three invocations; analyst
 * staff onboarding fixture is internal. Exhaustion never provisions fallback. */
export const BROWSER_MFA_POOL_DEMAND = Object.freeze([
  { role: 'owner', internal: false, count: 26 },
  { role: 'admin', internal: false, count: 16 },
  { role: 'admin', internal: false, profileCase: 'long-account', count: 1 },
  { role: 'founder', internal: true, count: 17 },
  { role: 'axiom_analyst', internal: true, count: 4 },
  { role: 'approver', internal: false, count: 9 },
] as const);

/** Additional memberships are expected only after live global designation was verified. */
export function mfaPoolMembershipReadPath(
  account: Pick<MfaPoolAccount, 'id' | 'role' | 'internal'>,
  binding: Pick<MfaPoolBinding, 'tenantId'>,
  livePlatformFounder: unknown = false,
): string {
  const actor = z.guid().parse(account.id);
  const tenant = z.guid().parse(binding.tenantId);
  const globalFounder = account.role === 'founder' && account.internal;
  if (globalFounder && livePlatformFounder !== true)
    throw new Error('MFA pool live global founder authority refused');
  return `tenant_users?user_id=eq.${actor}${globalFounder ? `&tenant_id=eq.${tenant}` : ''}&select=user_id,tenant_id,role`;
}

/** Independent actual PostgREST readback, not authority inferred from the file. */
export function verifyMfaPoolAccountRows(
  account: MfaPoolAccount,
  binding: MfaPoolBinding,
  rows: { profile: unknown; memberships: unknown; factors: unknown },
): boolean {
  const profile = z
    .array(z.object({ id: z.guid(), is_axiom_internal: z.boolean(), email: z.email() }).strict())
    .length(1)
    .safeParse(rows.profile);
  const memberships = z
    .array(z.object({ user_id: z.guid(), tenant_id: z.guid(), role: z.string() }).strict())
    .length(1)
    .safeParse(rows.memberships);
  const factors = z
    .array(
      z
        .object({ user_id: z.guid(), factor_type: z.literal('totp'), status: z.literal('active') })
        .strict(),
    )
    .length(1)
    .safeParse(rows.factors);
  return (
    profile.success &&
    profile.data[0]!.id === account.id &&
    profile.data[0]!.email === account.email &&
    profile.data[0]!.is_axiom_internal === account.internal &&
    (account.profileCase !== 'long-account' ||
      /^journey-long-organization-operator-layout-verification-[a-f0-9]{8}@example\.invalid$/.test(
        account.email,
      )) &&
    memberships.success &&
    memberships.data[0]!.user_id === account.id &&
    memberships.data[0]!.tenant_id === binding.tenantId &&
    memberships.data[0]!.role === account.role &&
    factors.success &&
    factors.data[0]!.user_id === account.id
  );
}

async function privateDirectory(path: string) {
  for (let p = path; p !== dirname(p); p = dirname(p)) {
    const value = await lstat(p);
    if (!value.isDirectory() || value.isSymbolicLink()) throw new Error('MFA pool path refused');
  }
  const value = await lstat(path);
  if (value.uid !== process.getuid?.() || (value.mode & 0o777) !== 0o700)
    throw new Error('MFA pool directory refused');
}
async function readPrivate(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const value = await file.stat();
    if (
      !value.isFile() ||
      value.nlink !== 1 ||
      value.uid !== process.getuid?.() ||
      (value.mode & 0o777) !== 0o600 ||
      value.size > 128 * 1024
    )
      throw new Error('MFA pool file refused');
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}
async function writeOnce(path: string, value: unknown) {
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(JSON.stringify(value));
  } finally {
    await file.close();
  }
}
function parseManifest(text: string) {
  try {
    const decoded: unknown = JSON.parse(text);
    if (JSON.stringify(decoded) !== text) throw new Error('encoding');
    return manifestSchema.parse(decoded);
  } catch {
    throw new Error('MFA pool manifest refused');
  }
}

type Clock = { now: () => number; wait: (ms: number) => Promise<void> };
const realClock: Clock = { now: Date.now, wait: delay };

export async function prepareBrowserMfaPool(input: {
  directory: string;
  binding: MfaPoolBinding;
  provision: (identity: MfaPoolIdentity, index: number) => Promise<MfaPoolAccount>;
  demand?: readonly (MfaPoolIdentity & { count: number })[];
  clock?: Clock;
}) {
  const binding = bindingSchema.parse(input.binding);
  await privateDirectory(dirname(input.directory));
  // An existing/stale pool must never be overwritten or reused.
  await mkdir(input.directory, { mode: 0o700 });
  await privateDirectory(input.directory);
  const clock = input.clock ?? realClock;
  const createdAt = clock.now();
  const demand = input.demand ?? BROWSER_MFA_POOL_DEMAND;
  const jobs = demand.flatMap((value) => {
    const identity = identitySchema.parse({
      role: value.role,
      internal: value.internal,
      profileCase: 'profileCase' in value ? value.profileCase : 'ordinary',
    });
    if (!Number.isSafeInteger(value.count) || value.count < 1 || value.count > 128)
      throw new Error('MFA pool demand refused');
    return Array.from({ length: value.count }, () => identity);
  });
  if (!jobs.length || jobs.length > 128) throw new Error('MFA pool demand refused');
  const accounts: MfaPoolAccount[] = [];
  let next = 0;
  let failed = false;
  async function lane() {
    for (;;) {
      if (failed) return;
      const index = next++;
      if (index >= jobs.length) return;
      const expected = jobs[index]!;
      try {
        const account = accountSchema.parse(await input.provision(expected, index));
        if (
          account.role !== expected.role ||
          account.internal !== expected.internal ||
          account.profileCase !== expected.profileCase ||
          account.consumedCounter > Math.floor(clock.now() / 30_000)
        )
          throw new Error('MFA pool provision binding refused');
        accounts.push(account);
      } catch {
        failed = true;
        throw new Error('MFA pool provision refused');
      }
    }
  }
  // Both lanes finish before publication, including when one refuses. No
  // unawaited provisioning can continue after a failed global setup.
  const results = await Promise.allSettled([lane(), lane()]);
  if (results.some((value) => value.status === 'rejected'))
    throw new Error('MFA pool preparation refused');
  const readyAfter = (Math.max(...accounts.map((a) => a.consumedCounter)) + 1) * 30_000 + 500;
  while (clock.now() < readyAfter) await clock.wait(readyAfter - clock.now());
  const manifest = manifestSchema.parse({ version: 1, binding, createdAt, readyAfter, accounts });
  await writeOnce(join(input.directory, 'manifest.json'), manifest);
}

export async function leaseBrowserMfaAccount(input: {
  directory: string;
  binding: MfaPoolBinding;
  identity: MfaPoolIdentity;
  verify: (account: MfaPoolAccount) => Promise<boolean>;
  now?: () => number;
}): Promise<MfaPoolAccount> {
  await privateDirectory(input.directory);
  const binding = bindingSchema.parse(input.binding);
  const identity = identitySchema.parse(input.identity);
  const manifest = parseManifest(await readPrivate(join(input.directory, 'manifest.json')));
  const now = (input.now ?? Date.now)();
  if (
    !Number.isSafeInteger(now) ||
    now < manifest.readyAfter ||
    now < manifest.createdAt ||
    now - manifest.createdAt > 10 * 60_000 ||
    JSON.stringify(manifest.binding) !== JSON.stringify(binding)
  )
    throw new Error('MFA pool target or readiness refused');
  for (const account of manifest.accounts.filter(
    (a) =>
      a.role === identity.role &&
      a.internal === identity.internal &&
      a.profileCase === identity.profileCase,
  )) {
    const path = join(input.directory, `${account.id}.lease`);
    try {
      // mkdir is the atomic single-use claim. A visible empty directory is
      // already a complete burned lease, unlike a partially written JSON file.
      await mkdir(path, { mode: 0o700 });
    } catch (cause) {
      if (!(cause instanceof Error) || !('code' in cause) || cause.code !== 'EEXIST') throw cause;
      await privateDirectory(path);
      continue;
    }
    await privateDirectory(path);
    // Never reclaim/reuse a burned identity, even on readback failure.
    let verified = false;
    try {
      verified = (await input.verify(account)) === true;
    } catch {
      /* No private adapter detail escapes. */
    }
    if (!verified) throw new Error('MFA pool live account refused');
    return account;
  }
  throw new Error('MFA pool exhausted');
}

/** Activation also retains recovery/history rows; only the live TOTP is the
 * authenticator witness. Keep exact actor/type/status projection at the API. */
export function mfaPoolFactorReadPath(id: string): string {
  const actor = z.guid().parse(id);
  return `user_mfa_factors?user_id=eq.${actor}&factor_type=eq.totp&status=eq.active&select=user_id,factor_type,status`;
}
