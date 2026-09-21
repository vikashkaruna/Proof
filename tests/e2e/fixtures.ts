import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { type PersonaKey, type PersonaState, personaByKey } from './personas';

const repoRoot = path.resolve(__dirname, '..', '..');

export const state: PersonaState = JSON.parse(
  readFileSync(path.join(repoRoot, '.axiom-runtime/personas/state.json'), 'utf8'),
);

export const account = (key: PersonaKey) => state.accounts[key];
export const persona = personaByKey;

/**
 * Sign in the way a person does: the real login form, a real password, a real
 * GoTrue session cookie. No injected token and no bypass — if this stops
 * working, the journeys that depend on it should fail rather than silently
 * fall back to some other identity.
 */
export async function signIn(page: Page, key: PersonaKey): Promise<void> {
  const who = account(key);
  await page.goto('/login');
  await page.fill('input[name="email"]', who.email);
  await page.fill('input[name="password"]', who.password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 }),
    page.click('button[type="submit"]'),
  ]);
}

/** Point the session at a seeded tenant. The cookie is a preference; membership still decides. */
export async function selectTenant(page: Page, which: 'a' | 'b'): Promise<void> {
  const tenant = which === 'a' ? state.tenantA : state.tenantB;
  await page.context().addCookies([
    {
      name: 'axiom_active_tenant',
      value: tenant.slug,
      domain: 'localhost',
      path: '/',
    },
  ]);
}

export const planUrl = (id: string) => `/plans/${id}`;
