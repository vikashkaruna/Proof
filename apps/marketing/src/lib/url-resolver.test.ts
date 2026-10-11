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
    'https://stg.axiomproof.ai',
    'https://axiomproof.ai',
    'https://axiom-proof.web.app',
    'https://axiom-proof-preprod-marketing-123.asia-south1.run.app',
  ])('uses the configured platform URL on %s', (host) => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://platform.axiomproof.ai');
    expect(at(host)).toBe('https://platform.axiomproof.ai');
  });

  it('uses the server-side platform setting during SSR', () => {
    vi.stubGlobal('window', undefined);
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    vi.stubEnv('AXIOM_PROOF_PLATFORM_URL', 'https://platform.axiomproof.ai');
    expect(resolveAppUrl()).toBe('https://platform.axiomproof.ai');
  });

  it('keeps local development links local', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3001');
    expect(at('http://localhost:3000')).toBe('http://localhost:3001');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    expect(at('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3001');
  });

  it('refuses localhost or malformed settings on a remote host', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3001');
    expect(() => at('https://stg.axiomproof.ai')).toThrow('not configured');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://user:pass@platform.axiomproof.ai');
    expect(() => at('https://stg.axiomproof.ai')).toThrow('not configured');
  });

  it('does not permit a loopback platform target during strict server deployment', () => {
    vi.stubGlobal('window', undefined);
    vi.stubEnv('AXIOM_STRICT_PUBLIC_URLS', '1');
    vi.stubEnv('AXIOM_PROOF_PLATFORM_URL', 'http://localhost:3001');
    expect(() => resolveAppUrl()).toThrow('required');
  });

  it('never infers a Workbench from a Cloud Run or Firebase hostname', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    vi.stubEnv('AXIOM_PROOF_PLATFORM_URL', '');
    expect(() => at('https://axiom-proof.web.app')).toThrow('not configured');
    expect(() => at('https://axiom-proof-preprod-marketing-123.asia-south1.run.app')).toThrow(
      'not configured',
    );
  });
});
