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

const EnvSchema = z
  .object({
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
  })
  .superRefine((env, ctx) => {
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

    // In production, distinguish frontend web/marketing applications from backend data-plane services.
    // Frontend apps NEVER hold approval signing keys or agent runtime tokens (Principle of Least Privilege).
    const isFrontendApp = Boolean(
      process.env.APP_NAME === 'marketing' ||
      process.env.APP_NAME === 'web' ||
      process.env.npm_package_name === '@axiom/marketing' ||
      process.env.npm_package_name === '@axiom/web' ||
      process.env.NEXT_RUNTIME !== undefined ||
      process.env.NEXT_PHASE !== undefined,
    );

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
      !env.SUPABASE_SERVICE_KEY ||
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
    const effectiveRegion = env.AXIOM_REGION || env.AWS_REGION;
    if (effectiveRegion !== 'ap-south-1' && effectiveRegion !== 'asia-south1') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AXIOM_REGION'],
        message: 'Production data-plane services must run in Mumbai (ap-south-1 or asia-south1)',
      });
    }

    if (!isFrontendApp) {
      if (!env.APPROVAL_SIGNING_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['APPROVAL_SIGNING_KEY'],
          message: 'Required in production; do not use a development signing fallback',
        });
      }
      if (!env.AGENT_RUNTIME_INTERNAL_TOKEN) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AGENT_RUNTIME_INTERNAL_TOKEN'],
          message: 'Required in production for BFF-to-agent authentication',
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
      }
    }
  });

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

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

export function resetEnvCache(): void {
  cached = null;
}

/** The security ruleset a process runs under. See W0.0. */
export type AuthMode = Env['AXIOM_AUTH_MODE'];

/**
 * The single, authoritative answer to "may this process relax authentication?".
 *
 * Every auth, tenant-resolution and idempotency decision in the codebase reads
 * this and nothing else. No caller may consult `ENVIRONMENT` or `NODE_ENV` to
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
