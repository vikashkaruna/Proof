import {
  acceptanceTarget,
  personaStatePath,
  webOrigin,
  repoRoot,
  assertPersonaTarget,
} from './target';
import type { PersonaState } from './personas';
import { readFileSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';
import { HARNESS_MFA_KEY } from './personas';

/**
 * Browser journeys, run against REAL authentication.
 *
 * This configuration used to set `AXIOM_E2E_BYPASS_AUTH=true` and ship an
 * `axiom_e2e_bypass` cookie in `storageState`. Both were removed from the
 * application in W0.0 — the cookie was step 2 of a complete unauthenticated
 * founder-owner takeover chain (SEC-2), and the env var was replaced by the
 * single sanctioned switch `AXIOM_AUTH_MODE`. The harness kept configuring
 * them long after the app stopped reading them.
 *
 * It mattered for more than tidiness. Under that bypass every caller resolves
 * to ONE founder identity, so a persona journey written on it would have been
 * a founder wearing a viewer's name: it would have passed whatever the render
 * gating did, including nothing. That is why these journeys sign in as real
 * GoTrue accounts with real passwords, seeded by `scripts/seed-personas.ts`,
 * against `AXIOM_AUTH_MODE=strict`.
 */

function personaState(): PersonaState | null {
  try {
    return JSON.parse(readFileSync(personaStatePath, 'utf8'));
  } catch {
    // Reported by the global setup with an actionable message rather than a
    // stack trace from the config loader.
    return null;
  }
}

const state = personaState();
if (state) assertPersonaTarget(state);

const BFF_PORT = '4000';

/** Shared by both servers so the ring key and the Supabase target cannot drift. */
const commonEnv = {
  ENVIRONMENT: 'local',
  // The point of the whole harness. Never relax this to make a journey pass:
  // a journey that needs the bypass is not testing authorisation.
  AXIOM_AUTH_MODE: 'strict',
  SUPABASE_URL: state?.supabaseUrl ?? 'http://127.0.0.1:56321',
  SUPABASE_ANON_KEY: state?.anonKey ?? '',
};

const webEnv = {
  ...commonEnv,
  NODE_ENV: 'development',
  NEXT_PUBLIC_SUPABASE_URL: state?.supabaseUrl ?? 'http://127.0.0.1:56321',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: state?.anonKey ?? '',
  // Where the browser-to-BFF bridge forwards to. Without a BFF the approval
  // journey stops at "Could not start verification" and proves nothing.
  BFF_PUBLIC_URL: `http://localhost:${BFF_PORT}`,
};

const bffEnv = {
  ...commonEnv,
  // The seed wrote every TOTP secret under this key. The BFF has to hold the
  // same one or a step-up fails as `secret_unreadable` — which is exactly the
  // distinct 503 the key ring introduced, and would be a confusing way to
  // discover a harness misconfiguration.
  AXIOM_MFA_ENCRYPTION_KEY: HARNESS_MFA_KEY,
  SUPABASE_SERVICE_KEY: state?.serviceKey ?? '',
  NODE_ENV: 'development',
  BFF_PORT,
  APPROVAL_SIGNING_KEY: 'axiom-e2e-persona-harness-approval-signing-key',
  AGENT_RUNTIME_URL: 'http://unused-runtime.invalid',
  AGENT_RUNTIME_INTERNAL_TOKEN: 'axiom-e2e-persona-harness-runtime-token-32c',
  MODEL_GATEWAY_API_KEY: 'axiom-e2e-persona-harness-gateway-key-32chars',
  AXIOM_REGION: 'ap-south-1',
  LOG_LEVEL: 'error',
};

export default defineConfig({
  testDir: './tests',
  globalSetup: require.resolve('./global-setup.ts'),
  /**
   * Next compiles each route the first time it is requested, and several
   * workers hitting an uncompiled route at once pushed past the 30s default.
   * Every one of those failures passed when run alone, which is the signature
   * of a budget problem rather than a defect — so the budget moved, and the
   * journeys did not.
   */
  timeout: 120_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    channel: process.env.AXIOM_E2E_BROWSER_CHANNEL === 'chrome' ? 'chrome' : undefined,
    baseURL: webOrigin,
    // No storageState: each journey establishes its own session by signing in,
    // which is the thing being tested.
    trace: acceptanceTarget ? 'off' : 'on-first-retry',
    screenshot: acceptanceTarget ? 'off' : 'only-on-failure',
    video: acceptanceTarget ? 'off' : 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: acceptanceTarget
    ? undefined
    : [
        {
          command: 'pnpm --filter @axiom/web dev',
          port: 3001,
          cwd: repoRoot,
          env: webEnv,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
        {
          // The BFF. Every authorisation the product makes is decided here,
          // so an approval journey that does not reach it is only testing a
          // page.
          command: 'pnpm --filter @axiom/bff dev',
          port: Number(BFF_PORT),
          cwd: repoRoot,
          env: bffEnv,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
        {
          // The marketing site. The persona journeys do not touch it, but the
          // public-surface specs do, and dropping it from here turned four
          // dormant specs into ECONNREFUSED the moment the suite could run at
          // all.
          command: 'pnpm --filter @axiom/marketing dev',
          port: 3000,
          cwd: repoRoot,
          env: webEnv,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      ],
});
