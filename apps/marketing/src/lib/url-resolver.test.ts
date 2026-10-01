import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAppUrl } from './url-resolver';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function at(url: string) {
  vi.stubGlobal('window', { location: new URL(url) });
  return resolveAppUrl();
}

describe('Workbench URL isolation', () => {
  it.each([
    [
      'https://axiom-marketing-preprod-123.asia-south1.run.app',
      'https://axiom-web-preprod-123.asia-south1.run.app',
    ],
    [
      'https://axiom-marketing-staging-123.asia-south1.run.app',
      'https://axiom-web-staging-123.asia-south1.run.app',
    ],
    [
      'https://axiom-marketing-123.asia-south1.run.app',
      'https://axiom-web-123.asia-south1.run.app',
    ],
    ['https://axiomproof.ai', 'https://app.axiomproof.ai'],
    ['https://www.axiomminds.ai', 'https://app.axiomproof.ai'],
    ['https://staging.axiomproof.ai', 'https://app-staging.axiomproof.ai'],
  ])('maps %s to %s', (marketing, app) => {
    expect(at(marketing)).toBe(app);
  });

  it('maps an on-premises marketing port to the configured app port', () => {
    vi.stubEnv('WEB_PORT', '4001');
    expect(at('http://192.168.2.10:3000')).toBe('http://192.168.2.10:4001');
  });

  it('ignores localhost configuration on a remote host', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3001');
    expect(at('https://generic.example.invalid')).toBe('https://app.axiomproof.ai');
  });

  it('uses the configured remote target for Firebase and server rendering', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app-preview.example.invalid');
    expect(at('https://axiom-proof.web.app')).toBe('https://app-preview.example.invalid');
    vi.stubGlobal('window', undefined);
    expect(resolveAppUrl()).toBe('https://app-preview.example.invalid');
  });

  it('derives the server preprod target when no explicit app URL is supplied', () => {
    vi.stubGlobal('window', undefined);
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    vi.stubEnv('APP_URL', '');
    vi.stubEnv('ENVIRONMENT', 'preprod');
    vi.stubEnv('GCP_PROJECT_NUMBER', '456');
    vi.stubEnv('GCP_REGION', 'asia-south1');
    expect(resolveAppUrl()).toBe('https://axiom-web-preprod-456.asia-south1.run.app');
  });
});
