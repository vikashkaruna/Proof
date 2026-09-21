import path from 'node:path';
import { readFileSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

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

const repoRoot = path.resolve(__dirname, '..', '..');
const PERSONA_STATE = path.join(repoRoot, '.axiom-runtime/personas/state.json');

function personaState(): { supabaseUrl: string; anonKey: string; serviceKey: string } | null {
  try {
    return JSON.parse(readFileSync(PERSONA_STATE, 'utf8'));
  } catch {
    // Reported by the global setup with an actionable message rather than a
    // stack trace from the config loader.
    return null;
  }
}

const state = personaState();

const webEnv = {
  NODE_ENV: 'development',
  ENVIRONMENT: 'local',
  // The point of the whole harness. Never relax this to make a journey pass:
  // a journey that needs the bypass is not testing authorisation.
  AXIOM_AUTH_MODE: 'strict',
  NEXT_PUBLIC_SUPABASE_URL: state?.supabaseUrl ?? 'http://127.0.0.1:56321',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: state?.anonKey ?? '',
  SUPABASE_URL: state?.supabaseUrl ?? 'http://127.0.0.1:56321',
  SUPABASE_ANON_KEY: state?.anonKey ?? '',
  SUPABASE_SERVICE_KEY: state?.serviceKey ?? '',
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
  timeout: 90_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3001',
    // No storageState: each journey establishes its own session by signing in,
    // which is the thing being tested.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.PLAYWRIGHT_BASE_URL
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
      ],
});
