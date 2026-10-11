import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createMarketingApp } from './marketing-app.js';

function configuration() {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ role: 'service_role', exp: Math.floor(Date.now() / 1000) + 600 }),
  ).toString('base64url');
  const input = `${header}.${payload}`;
  const signature = createHmac('sha256', 'synthetic-marketing-config-test-only')
    .update(input)
    .digest('base64url');
  return {
    ENVIRONMENT: 'preprod',
    NODE_ENV: 'production',
    AXIOM_AUTH_MODE: 'strict',
    AXIOM_RELEASE_SHA: 'a'.repeat(40),
    SUPABASE_URL: 'https://axiom-proof-preprod-gateway-abc-el.a.run.app',
    SUPABASE_SERVICE_KEY: `${input}.${signature}`,
    AXIOM_PROOF_MARKETING_URL: 'https://stg.axiomproof.ai',
    AXIOM_CONTACT_EMAIL_MODE: 'disabled',
    AXIOM_REPORT_EMAIL_MODE: 'disabled',
    GCP_PROJECT_ID: 'axiom-proof',
    GCP_REGION: 'asia-south1',
    AXIOM_IDLE_PROJECT_ID: 'axiom-proof',
    AXIOM_IDLE_CONTROLLER_URL: 'https://axiom-proof-preprod-idle-abc-el.a.run.app',
    AXIOM_IDLE_CONTROLLER_AUDIENCE: 'https://axiom-proof-preprod-idle-abc-el.a.run.app',
  };
}

describe('marketing acceptance backend boundary', () => {
  it('reports its exact profile and source without contacting the database', async () => {
    const response = await createMarketingApp(configuration()).request('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'healthy',
      profile: 'marketing',
      releaseSha: 'a'.repeat(40),
    });
  });
  it('does not expose product execution, agent or administration routes', async () => {
    const app = createMarketingApp(configuration());
    for (const path of [
      '/v1/agents/invoke',
      '/v1/actions/execute',
      '/v1/tenants',
      '/v1/approvals',
    ]) {
      expect((await app.request(path, { method: 'POST' })).status).toBe(404);
    }
  });
  it('retains the public contact configuration route', async () => {
    const response = await createMarketingApp(configuration()).request('/public/contact/config');
    expect(response.status).toBe(200);
  });
  it('refuses DB-bound public requests before any SQL call when identity metadata is unavailable', async () => {
    const transport = vi.fn(async (_input: Parameters<typeof fetch>[0]) => {
      throw new Error('metadata unavailable');
    });
    vi.stubGlobal('fetch', transport);
    try {
      const response = await createMarketingApp(configuration()).request('/public/contact', {
        method: 'POST',
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ saved: false });
      expect(response.headers.get('retry-after')).toBe('5');
      expect(transport).toHaveBeenCalledTimes(1);
      expect(String(transport.mock.calls[0]?.[0])).toContain('metadata.google.internal');
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('refuses auth bypass, insecure storage and another environment', () => {
    for (const change of [
      { AXIOM_AUTH_MODE: 'e2e-bypass' },
      { SUPABASE_URL: 'http://localhost:57121' },
      { ENVIRONMENT: 'production' },
      { AXIOM_IDLE_PROJECT_ID: 'another-project' },
      { AXIOM_IDLE_CONTROLLER_URL: 'https://attacker.invalid' },
    ]) {
      expect(() => createMarketingApp({ ...configuration(), ...change })).toThrow(
        /Invalid marketing/,
      );
    }
  });
  it('refuses malformed credentials without including their values in errors', () => {
    const secret = 'sensitive-invalid-value-must-not-appear'.repeat(2);
    expect(() => createMarketingApp({ ...configuration(), SUPABASE_SERVICE_KEY: secret })).toThrow(
      'Invalid marketing configuration: SUPABASE_SERVICE_KEY',
    );
    try {
      createMarketingApp({ ...configuration(), SUPABASE_SERVICE_KEY: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
  it('refuses delivery without explicit credentials and recipient', () => {
    expect(() =>
      createMarketingApp({ ...configuration(), AXIOM_CONTACT_EMAIL_MODE: 'delivery' }),
    ).toThrow('Invalid marketing delivery configuration');
  });
});
