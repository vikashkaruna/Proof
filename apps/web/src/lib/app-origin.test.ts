import { afterEach, expect, it, vi } from 'vitest';
import { appOrigin } from './app-origin';

afterEach(() => vi.unstubAllEnvs());

it('uses the configured http(s) origin, dropping any path', () => {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.axiomproof.ai/some/path');
  expect(appOrigin('http://0.0.0.0:3001')).toBe('https://app.axiomproof.ai');
});
it('falls back to the given origin when unset or not http(s)', () => {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
  expect(appOrigin('http://localhost:3001')).toBe('http://localhost:3001');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'javascript:alert(1)');
  expect(appOrigin('http://localhost:3001')).toBe('http://localhost:3001');
});
