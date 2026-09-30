import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { offlineLicenseGate } from './offline-license.js';

vi.mock('@axiom/config', () => ({
  verifyOfflineLicense: vi.fn((token: string) => ({ valid: token === 'valid' })),
}));

function appFor(environment: string, token?: string) {
  const app = new Hono();
  app.use('*', offlineLicenseGate(environment, token));
  app.get('/health', (c) => c.text('healthy'));
  app.get('/ready', (c) => c.text('ready'));
  app.get('/v1/system/license', (c) => c.text('license status'));
  app.post('/internal/workload-tools/execute', (c) => c.text('executed'));
  return app;
}

describe('on-prem runtime license gate', () => {
  it('fails closed for all work after an absent or expired license, while exposing diagnostics', async () => {
    const app = appFor('onprem', 'expired');
    expect((await app.request('/health')).status).toBe(200);
    expect((await app.request('/ready')).status).toBe(503);
    expect((await app.request('/v1/system/license')).status).toBe(200);
    expect((await app.request('/internal/workload-tools/execute', { method: 'POST' })).status).toBe(
      403,
    );
    expect(
      (await appFor('onprem').request('/internal/workload-tools/execute', { method: 'POST' }))
        .status,
    ).toBe(403);
  });

  it('permits work only with a valid on-prem license and does not affect cloud routes', async () => {
    expect(
      (
        await appFor('onprem', 'valid').request('/internal/workload-tools/execute', {
          method: 'POST',
        })
      ).status,
    ).toBe(200);
    expect(
      (await appFor('production').request('/internal/workload-tools/execute', { method: 'POST' }))
        .status,
    ).toBe(200);
  });
});
