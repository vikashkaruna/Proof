import { z } from 'zod';

/**
 * Centralised runtime configuration. Loaded once at process start and
 * frozen — every service reads from this, never from `process.env`
 * directly. Validation fails fast at boot.
 */

/**
 * Environments in which `AXIOM_AUTH_MODE=e2e-bypass` may be honoured. Everything
 * else runs `strict`. Deliberately a closed set — see W0.0.
 */
const AUTH_BYPASS_ENVIRONMENTS = new Set<string>(['local', 'test']);

/**
 * Deployed environments. These differ from one another in TOPOLOGY only
 * (cluster, URLs, GCP project, bucket names, replica count) and share one
 * identical security ruleset, including full production credential validation.
 */
const HARDENED_ENVIRONMENTS = new Set<string>(['staging', 'preprod', 'production', 'onprem']);

/**
 * Recognises secrets that were never meant to leave a developer's machine.
 *
 * `.env.staging.example` shipped `APPROVAL_SIGNING_KEY=dev-signing-secret-key-…`
 * committed to the repository. That key is the HMAC behind the approval-token
 * gate — the one mechanism standing between a generated plan and execution
 * against a client estate — so a published value means forgeable approvals.
 * The length checks on these fields passed happily, because length was never
 * the problem.
 *
 * Mint real values with `node scripts/mint-supabase-keys.mjs`.
 */
const PLACEHOLDER_SECRET_PATTERN =
  /^(dev-|test-|changeme|placeholder|secret$|password$)|placeholder|changeme|your-|xxx|<[^>]+>/i;

function isPlaceholderSecret(value: string | undefined): boolean {
  if (!value) return false;
  return PLACEHOLDER_SECRET_PATTERN.test(value);
}

const EnvFields = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
  ENVIRONMENT: z
    .enum(['development', 'local', 'test', 'staging', 'preprod', 'production', 'onprem'])
    .optional(),

  /**
   * The security ruleset the process runs under. This is the ONLY switch that
   * may relax authentication, tenant resolution or idempotency, and it is
   * refused at boot outside `local`/`test` (see the superRefine below).
   *
   * Per W0.0: environment identity determines TOPOLOGY only — never security
   * posture. `staging`, `preprod`, `production` and `onprem` all run `strict`.
   */
  AXIOM_AUTH_MODE: z.enum(['strict', 'e2e-bypass']).default('strict'),
  AXIOM_RELEASE_SHA: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
  ),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Supabase
  SUPABASE_URL: z.string().url().default('http://127.0.0.1:55321'),
  SUPABASE_ANON_KEY: z
    .string()
    .min(20)
    .default(
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
    ),
  SUPABASE_SERVICE_KEY: z
    .string()
    .min(20)
    .default(
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU',
    ),
  SUPABASE_DB_URL: z.string().url().optional(),

  // Cloud-Agnostic Storage & Evidence Vault (GCS / AWS S3 / MinIO / On-Prem)
  AXIOM_REGION: z.string().default('ap-south-1'),
  AXIOM_EVIDENCE_BUCKET: z.string().default('axiom-proof-evidence'),
  AXIOM_STORAGE_ENDPOINT: z.string().url().optional(), // for GCS, MinIO, Ceph, etc.
  AXIOM_STORAGE_ACCESS_KEY_ID: z.string().optional(),
  AXIOM_STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
  AXIOM_PROJECT_ID: z.string().optional(),
  AXIOM_PROJECT_NUMBER: z.string().optional(),

  // Legacy / Backward Compatibility Aliases (AWS & GCP)
  AWS_REGION: z.string().default('ap-south-1'),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_S3_EVIDENCE_BUCKET: z.string().default('axiom-proof-evidence'),
  AWS_S3_ENDPOINT: z.string().url().optional(),
  GCP_REGION: z.string().optional(),
  GCP_PROJECT_ID: z.string().optional(),
  GCP_PROJECT_NUMBER: z.string().optional(),

  // Temporal
  TEMPORAL_ADDRESS: z.string().default('ap-south-1.aws.api.temporal.io:7233'),
  TEMPORAL_NAMESPACE: z.string().default('axiom-proof'),
  TEMPORAL_API_KEY: z.string().optional(),
  TEMPORAL_TLS: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),

  // Model gateway
  MODEL_GATEWAY_URL: z.string().url().default('http://model-gateway.axiom-proof:8000'),
  MODEL_GATEWAY_API_KEY: z.string().optional(),

  // BFF → agent-runtime service-to-service authentication
  AGENT_RUNTIME_URL: z.string().url().optional(),
  AGENT_RUNTIME_INTERNAL_TOKEN: z.string().optional(),

  // BFF
  BFF_PORT: z
    .string()
    .default('4000')
    .transform((v) => Number(v)),
  BFF_PUBLIC_URL: z.string().url().optional(),
  BFF_CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:3001'),

  // MFA (W1). Separate from the approval signing key on purpose: these
  // protect different things, and compromising one should not hand over the
  // other. This decrypts TOTP secrets, so holding it means being able to
  // mint valid codes for every enrolled user.
  AXIOM_MFA_ENCRYPTION_KEY: z.string().min(32).optional(),

  /**
   * Keys being retired, comma separated, newest first. They decrypt but
   * never encrypt: a secret sealed under one of these is rewritten under
   * `AXIOM_MFA_ENCRYPTION_KEY` the next time its owner verifies, so a
   * rotation finishes at the pace people log in rather than in one pass
   * that decrypts every TOTP secret into a single process.
   *
   * Remove a key here only once nothing is sealed under it. Doing it early
   * does not degrade service, it locks those users out — which is why the
   * service reports an unopenable secret as its own fault rather than as a
   * wrong code.
   */
  AXIOM_MFA_ENCRYPTION_KEYS_PREVIOUS: z.string().optional(),

  /**
   * How long a satisfied login MFA vouches for a session, in hours
   * (W1 · SEC-8). Decided with the founder at 12: one code per working
   * day, and a session stolen in the evening stops being usable overnight
   * without the factor.
   *
   * It is deliberately independent of the Supabase session lifetime.
   * Supabase sessions refresh indefinitely by default, so tying MFA to the
   * session would mean "once per device, roughly forever".
   */
  AXIOM_MFA_SESSION_TTL_HOURS: z.coerce
    .number()
    .int()
    .positive()
    .max(24 * 30)
    .default(12),

  /**
   * How many trusted proxies sit in front of the BFF (W1 · R-08).
   *
   * `x-forwarded-for` is appended to by each hop, so the rightmost entries
   * are the ones written by infrastructure we control and everything to
   * their left is, ultimately, whatever the caller sent. The real client
   * address is therefore `parts[parts.length - 1 - hops]`.
   *
   * This is topology, not posture — the W0.0 rule — so it varies by
   * environment while the behaviour it feeds does not:
   *
   *   Cloud Run behind Google's load balancer   1
   *   nginx ingress with one proxy in front      1  (add one per extra hop)
   *   plain Compose, no proxy                    0
   *
   * The default is 0, which DISABLES address-derived budgets rather than
   * trusting the last entry. With no proxy in front, `x-forwarded-for` is
   * pure caller input: budgeting on it would let an attacker pick a
   * victim's key and exhaust it, which is precisely the attack the
   * per-session budget exists to prevent. An unset value must therefore
   * mean "no address", never "trust whatever arrived".
   */
  AXIOM_TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(8).default(0),

  // Approval token signing
  APPROVAL_SIGNING_KEY: z.string().min(32).optional(), // per-tenant in prod
  APPROVAL_TOKEN_TTL_MINUTES: z
    .string()
    .default('60')
    .transform((v) => Number(v)),

  // Redis / Upstash Cache
  UPSTASH_REDIS_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),

  // Observability
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  SENTRY_DSN: z.string().url().optional(),

  // Email Delivery (Resend)
  RESEND_API_KEY: z.string().optional(),
  AXIOM_FROM_EMAIL: z.string().default('Axiom Proof <platform@axiomproof.ai>'),
  RESEND_FROM_EMAIL: z.string().default('Axiom Proof <platform@axiomproof.ai>'),
  AXIOM_SALES_EMAIL: z.string().email().default('sales@axiomproof.ai'),
  AXIOM_FOUNDER_EMAIL: z.string().email().default('founder@axiomminds.ai'),
  CONTACT_RECIPIENT_EMAIL: z.string().email().default('hello@axiomminds.ai'),

  // Feature flags
  FEATURE_DRY_RUN_ENGINE: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  FEATURE_EXECUTION_ENGINE: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  FEATURE_LIVE_CONNECTORS: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  FEATURE_KILL_SWITCH: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
});

const WebEnvSchema = EnvFields.pick({
  AXIOM_RELEASE_SHA: true,
  NODE_ENV: true,
  ENVIRONMENT: true,
  AXIOM_AUTH_MODE: true,
  SUPABASE_URL: true,
  SUPABASE_ANON_KEY: true,
  AXIOM_REGION: true,
  AWS_REGION: true,
}).superRefine(validatePublicEnvironment);

export type WebEnv = z.infer<typeof WebEnvSchema>;

function validatePublicEnvironment(env: WebEnv, ctx: z.RefinementCtx): void {
  // ---------------------------------------------------------------------
  // W0.0 — the governing principle: the security ruleset never varies by
  // environment. `e2e-bypass` is the single switch that relaxes auth, and it
  // is refused at boot anywhere but `local`/`test`. The process exits with a
  // clear error rather than degrading. This check runs unconditionally,
  // before any environment-shaped early return.
  // ---------------------------------------------------------------------
  if (
    env.AXIOM_AUTH_MODE === 'e2e-bypass' &&
    !AUTH_BYPASS_ENVIRONMENTS.has(env.ENVIRONMENT ?? '')
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AXIOM_AUTH_MODE'],
      message:
        `AXIOM_AUTH_MODE='e2e-bypass' is permitted only when ENVIRONMENT is ` +
        `${[...AUTH_BYPASS_ENVIRONMENTS].join(' or ')} (got ` +
        `${env.ENVIRONMENT ? `'${env.ENVIRONMENT}'` : 'unset'}). ` +
        `Refusing to start: authentication must not be relaxed in a deployed environment.`,
    });
  }

  // Production-strength credential validation applies to every hardened
  // deployment — staging, preprod, production and onprem — not just
  // production. Prior to W0.0 this returned early for staging/preprod, which
  // is the same fail-open family as SEC-1: a deployed environment silently
  // accepted demo Supabase keys and a missing approval signing key.
  // `development`, `local` and `test` remain exempt; they are not deployed.
  const isHardenedDeployment = env.ENVIRONMENT
    ? HARDENED_ENVIRONMENTS.has(env.ENVIRONMENT)
    : env.NODE_ENV === 'production';
  if (!isHardenedDeployment) return;

  if (
    !env.SUPABASE_URL ||
    env.SUPABASE_URL.includes('localhost') ||
    env.SUPABASE_URL.includes('127.0.0.1')
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SUPABASE_URL'],
      message: 'Valid production SUPABASE_URL is required',
    });
  }
  if (
    isPlaceholderSecret(env.SUPABASE_ANON_KEY) ||
    env.SUPABASE_ANON_KEY.startsWith(
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1v',
    )
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SUPABASE_ANON_KEY'],
      message: 'A real deployment anon key is required; demo and placeholder keys are refused.',
    });
  }
  const effectiveRegion = env.AXIOM_REGION || env.AWS_REGION;
  if (effectiveRegion !== 'ap-south-1' && effectiveRegion !== 'asia-south1') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AXIOM_REGION'],
      message: 'Production data-plane services must run in Mumbai (ap-south-1 or asia-south1)',
    });
  }
}

const EnvSchema = EnvFields.superRefine((env, ctx) => {
  validatePublicEnvironment(env, ctx);
  const hardened = env.ENVIRONMENT
    ? HARDENED_ENVIRONMENTS.has(env.ENVIRONMENT)
    : env.NODE_ENV === 'production';
  if (!hardened) return;
  // Backend validation never trusts ambient Next.js or package-name hints.
  if (
    !env.SUPABASE_SERVICE_KEY ||
    isPlaceholderSecret(env.SUPABASE_SERVICE_KEY) ||
    env.SUPABASE_SERVICE_KEY.startsWith(
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1v',
    )
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SUPABASE_SERVICE_KEY'],
      message: 'Valid production SUPABASE_SERVICE_KEY is required',
    });
  }
  if (!env.APPROVAL_SIGNING_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['APPROVAL_SIGNING_KEY'],
      message: 'Required in production; do not use a development signing fallback',
    });
  } else if (isPlaceholderSecret(env.APPROVAL_SIGNING_KEY)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['APPROVAL_SIGNING_KEY'],
      message:
        'Looks like a committed development placeholder. This key signs approval ' +
        'tokens — a known value means forgeable approvals. Mint one with ' +
        '`node scripts/mint-supabase-keys.mjs`.',
    });
  }
  if (!env.AGENT_RUNTIME_INTERNAL_TOKEN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AGENT_RUNTIME_INTERNAL_TOKEN'],
      message: 'Required in production for BFF-to-agent authentication',
    });
  } else if (isPlaceholderSecret(env.AGENT_RUNTIME_INTERNAL_TOKEN)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AGENT_RUNTIME_INTERNAL_TOKEN'],
      message:
        'Looks like a committed development placeholder. Mint one with ' +
        '`node scripts/mint-supabase-keys.mjs`.',
    });
  }
  if (!env.AGENT_RUNTIME_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AGENT_RUNTIME_URL'],
      message: 'Required in production for BFF-to-agent routing',
    });
  }
  if (!env.MODEL_GATEWAY_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['MODEL_GATEWAY_API_KEY'],
      message: 'Required in production for model-gateway authentication',
    });
  } else if (isPlaceholderSecret(env.MODEL_GATEWAY_API_KEY)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['MODEL_GATEWAY_API_KEY'],
      message:
        'Looks like a committed development placeholder. Mint one with ' +
        '`node scripts/mint-supabase-keys.mjs`.',
    });
  }

  if (
    env.AXIOM_MFA_ENCRYPTION_KEY &&
    [
      env.APPROVAL_SIGNING_KEY,
      env.AGENT_RUNTIME_INTERNAL_TOKEN,
      env.MODEL_GATEWAY_API_KEY,
    ].includes(env.AXIOM_MFA_ENCRYPTION_KEY)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AXIOM_MFA_ENCRYPTION_KEY'],
      message: 'MFA encryption needs a distinct key, not a reused signing or service credential.',
    });
  }
  if (!env.AXIOM_MFA_ENCRYPTION_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AXIOM_MFA_ENCRYPTION_KEY'],
      message:
        'Required in a deployed environment. TOTP secrets cannot be stored in the clear: ' +
        'anyone reading the table could mint codes for every enrolled user, which turns ' +
        'two-factor authentication back into one.',
    });
  } else if (isPlaceholderSecret(env.AXIOM_MFA_ENCRYPTION_KEY)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AXIOM_MFA_ENCRYPTION_KEY'],
      message:
        'Looks like a committed development placeholder. Mint one with ' +
        '`node scripts/mint-supabase-keys.mjs`.',
    });
  }

  // The retiring keys are held to the same standard as the primary. A
  // weak or reused key still opens every secret written under it, and the
  // ring keeps it live for as long as it is listed.
  const previous = parseMfaPreviousKeys(env.AXIOM_MFA_ENCRYPTION_KEYS_PREVIOUS);
  const seen = new Set<string>();
  for (const key of previous) {
    const fail = (message: string) =>
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AXIOM_MFA_ENCRYPTION_KEYS_PREVIOUS'],
        message,
      });
    if (key.length < 32) {
      fail('Every retiring MFA key must be at least 32 characters, like the primary.');
    }
    if (isPlaceholderSecret(key)) {
      fail('A retiring MFA key looks like a committed development placeholder.');
    }
    if (key === env.AXIOM_MFA_ENCRYPTION_KEY) {
      fail(
        'A retiring MFA key repeats the primary. Listing it does nothing and hides whether ' +
          'a rotation has actually started.',
      );
    }
    if (
      [
        env.APPROVAL_SIGNING_KEY,
        env.AGENT_RUNTIME_INTERNAL_TOKEN,
        env.MODEL_GATEWAY_API_KEY,
      ].includes(key)
    ) {
      fail('A retiring MFA key reuses a signing or service credential.');
    }
    if (seen.has(key)) {
      fail('A retiring MFA key is listed twice.');
    }
    seen.add(key);
  }
});

/**
 * Split `AXIOM_MFA_ENCRYPTION_KEYS_PREVIOUS` into a list. Blank entries are
 * dropped so a trailing comma, which is how a list usually ends up when the
 * last key is removed, does not become an empty key on the ring.
 */
export function parseMfaPreviousKeys(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;
let cachedWeb: WebEnv | null = null;

function normalizeEnv(source: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const norm: Record<string, unknown> = { ...source };

  const region = norm.AXIOM_REGION || norm.AWS_REGION || norm.GCP_REGION || 'ap-south-1';
  norm.AXIOM_REGION = region;
  norm.AWS_REGION = region;

  const bucket =
    norm.AXIOM_EVIDENCE_BUCKET ||
    norm.AWS_S3_EVIDENCE_BUCKET ||
    norm.S3_EVIDENCE_BUCKET ||
    'axiom-proof-evidence';
  norm.AXIOM_EVIDENCE_BUCKET = bucket;
  norm.AWS_S3_EVIDENCE_BUCKET = bucket;

  const endpoint = norm.AXIOM_STORAGE_ENDPOINT || norm.AWS_S3_ENDPOINT || norm.S3_ENDPOINT;
  if (endpoint !== undefined && endpoint !== '') {
    norm.AXIOM_STORAGE_ENDPOINT = endpoint;
    norm.AWS_S3_ENDPOINT = endpoint;
  }

  const accessKey =
    norm.AXIOM_STORAGE_ACCESS_KEY_ID || norm.AXIOM_ACCESS_KEY_ID || norm.AWS_ACCESS_KEY_ID;
  if (accessKey !== undefined && accessKey !== '') {
    norm.AXIOM_STORAGE_ACCESS_KEY_ID = accessKey;
    norm.AWS_ACCESS_KEY_ID = accessKey;
  }

  const secretKey =
    norm.AXIOM_STORAGE_SECRET_ACCESS_KEY ||
    norm.AXIOM_SECRET_ACCESS_KEY ||
    norm.AWS_SECRET_ACCESS_KEY;
  if (secretKey !== undefined && secretKey !== '') {
    norm.AXIOM_STORAGE_SECRET_ACCESS_KEY = secretKey;
    norm.AWS_SECRET_ACCESS_KEY = secretKey;
  }

  const projectId = norm.AXIOM_PROJECT_ID || norm.GCP_PROJECT_ID;
  if (projectId !== undefined && projectId !== '') {
    norm.AXIOM_PROJECT_ID = projectId;
    norm.GCP_PROJECT_ID = projectId;
  }

  const projectNumber = norm.AXIOM_PROJECT_NUMBER || norm.GCP_PROJECT_NUMBER;
  if (projectNumber !== undefined && projectNumber !== '') {
    norm.AXIOM_PROJECT_NUMBER = projectNumber;
    norm.GCP_PROJECT_NUMBER = projectNumber;
  }

  const fromEmail =
    norm.AXIOM_FROM_EMAIL || norm.RESEND_FROM_EMAIL || 'Axiom Proof <platform@axiomproof.ai>';
  norm.AXIOM_FROM_EMAIL = fromEmail;
  norm.RESEND_FROM_EMAIL = fromEmail;

  if (!norm.AXIOM_SALES_EMAIL && norm.SALES_EMAIL) {
    norm.AXIOM_SALES_EMAIL = norm.SALES_EMAIL;
  }
  if (!norm.AXIOM_FOUNDER_EMAIL && norm.FOUNDER_EMAIL) {
    norm.AXIOM_FOUNDER_EMAIL = norm.FOUNDER_EMAIL;
  }

  return norm;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const normalized = normalizeEnv(source);
  const parsed = EnvSchema.safeParse(normalized);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = Object.freeze(parsed.data);
  return cached;
}

/** User-scoped SSR configuration: excludes all backend write/signing credentials. */
export function loadWebEnv(source: NodeJS.ProcessEnv = process.env): WebEnv {
  if (cachedWeb) return cachedWeb;
  const parsed = WebEnvSchema.safeParse(normalizeEnv(source));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cachedWeb = Object.freeze(parsed.data);
  return cachedWeb;
}

export function isWebAuthBypassEnabled(source: NodeJS.ProcessEnv = process.env): boolean {
  return loadWebEnv(source).AXIOM_AUTH_MODE === 'e2e-bypass';
}

export function resetEnvCache(): void {
  cached = null;
  cachedWeb = null;
}

/** The security ruleset a process runs under. See W0.0. */
export type AuthMode = Env['AXIOM_AUTH_MODE'];

/**
 * The single, authoritative answer to "may this process relax authentication?".
 *
 * Backend auth, tenant-resolution and idempotency decisions use this loader.
 * SSR uses `isWebAuthBypassEnabled`, validated by the same security rules. No caller may consult `ENVIRONMENT` or `NODE_ENV` to
 * make a security decision — `scripts/check-env-security-gate.sh` fails CI on
 * any attempt to reintroduce that pattern.
 *
 * Defaults to `strict`. `e2e-bypass` cannot be reached outside `local`/`test`
 * because `loadEnv()` refuses to parse that combination, so a misconfigured
 * deployment fails at boot rather than serving requests with auth disabled.
 */
export function resolveAuthMode(source: NodeJS.ProcessEnv = process.env): AuthMode {
  return loadEnv(source).AXIOM_AUTH_MODE;
}

/**
 * Convenience predicate for the one question call sites actually ask. Returns
 * `false` in every deployed environment, always.
 */
export function isAuthBypassEnabled(source: NodeJS.ProcessEnv = process.env): boolean {
  return resolveAuthMode(source) === 'e2e-bypass';
}

/** Brand constants — the single source of truth. */
export const BRAND = {
  name: 'Axiom Proof',
  fullName: 'Axiom Proof — by Axiom Minds',
  tagline: 'Agents do the work. You approve. The proof is automatic.',
  company: 'Axiom Minds Private Limited',
  website: 'https://axiomminds.ai',
  primaryDomain: 'axiomproof.ai',
  productDomain: 'app.axiomproof.ai',
  companyDomain: 'axiomminds.ai',
  contactEmail: 'hello@axiomminds.ai',
  salesEmail: 'sales@axiomproof.ai',
  founderEmail: 'founder@axiomminds.ai',
  platformEmail: 'platform@axiomproof.ai',
  privacyEmail: 'privacy@axiomminds.ai',
  copyright: `© ${new Date().getFullYear()} Axiom Minds Private Limited. All rights reserved.`,
  jurisdiction: 'India',
  dataResidencyRegion: 'ap-south-1',
} as const;
