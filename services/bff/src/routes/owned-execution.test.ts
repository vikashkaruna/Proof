import { expect, it, vi } from 'vitest';
import { ownedExecutionRoutes } from './owned-execution.js';
it('defaults unavailable even with browser or shared runtime token', async () => {
  const app = ownedExecutionRoutes();
  const response = await app.request('/run', {
    method: 'POST',
    headers: {
      authorization: 'Bearer browser',
      'x-internal-token': 'shared',
      'content-type': 'application/json',
    },
    body: '{}',
  });
  expect(response.status).toBe(503);
});
it.each([
  { 'content-type': 'application/json' },
  { 'content-type': 'text/plain', 'x-workload-svid': 'proof' },
])('refuses missing identity/wrong content before controller %#', async (headers) => {
  const run = vi.fn();
  const response = await ownedExecutionRoutes({ run }).request('/run', {
    method: 'POST',
    headers,
    body: '{}',
  });
  expect(response.status).toBe(403);
  expect(run).not.toHaveBeenCalled();
});
it('never accepts authority in query and sanitizes controller failures', async () => {
  const run = vi.fn(async () => {
    throw Error('private detail');
  });
  const app = ownedExecutionRoutes({ run });
  const options = {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-workload-svid': 'proof' },
    body: '{}',
  };
  expect((await app.request('/run?proof=private', options)).status).toBe(403);
  expect(run).not.toHaveBeenCalled();
  const response = await app.request('/run', options);
  expect(await response.text()).not.toContain('private detail');
  expect(response.status).toBe(403);
});
