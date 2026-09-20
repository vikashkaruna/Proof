import { describe, it, expect } from 'vitest';
import { loadEnv, resetEnvCache, resolveAuthMode, isAuthBypassEnabled, BRAND } from './index';

describe('loadEnv', () => {
  it('loads valid env', () => {
    resetEnvCache();
    const env = loadEnv({
      SUPABASE_URL: 'http://localhost:54321',
      SUPABASE_ANON_KEY: 'a'.repeat(40),
      SUPABASE_SERVICE_KEY: 'b'.repeat(40),
      NODE_ENV: 'test',
    });
    expect(env.NODE_ENV).toBe('test');
    expect(env.SUPABASE_URL).toBe('http://localhost:54321');
  });

  it('throws on invalid production configuration', () => {
    resetEnvCache();
    expect(() => loadEnv({ NODE_ENV: 'production' })).toThrow(/Invalid environment configuration/);
  });

  it('defaults NODE_ENV to development', () => {
    resetEnvCache();
    const env = loadEnv({
      SUPABASE_URL: 'http://localhost:54321',
      SUPABASE_ANON_KEY: 'a'.repeat(40),
      SUPABASE_SERVICE_KEY: 'b'.repeat(40),
    });
    expect(env.NODE_ENV).toBe('development');
  });

  it('fails closed when production service credentials are incomplete', () => {
    resetEnvCache();
    expect(() =>
      loadEnv({
        NODE_ENV: 'production',
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_ANON_KEY: 'a'.repeat(40),
        SUPABASE_SERVICE_KEY: 'b'.repeat(40),
      }),
    ).toThrow(/AGENT_RUNTIME_INTERNAL_TOKEN|APPROVAL_SIGNING_KEY/);
  });

  // W0.0 · SEC-13 row 9 — preprod and staging previously skipped ALL production
  // credential validation. They are deployed environments and are now held to
  // the identical ruleset; only their topology differs.
  it.each(['staging', 'preprod', 'production', 'onprem'] as const)(
    'enforces production credential validation in the hardened environment %s',
    (environment) => {
      resetEnvCache();
      expect(() => loadEnv({ NODE_ENV: 'production', ENVIRONMENT: environment })).toThrow(
        /SUPABASE_URL|SUPABASE_SERVICE_KEY/,
      );
    },
  );

  it.each(['development', 'local', 'test'] as const)(
    'exempts the non-deployed environment %s from production credential validation',
    (environment) => {
      resetEnvCache();
      const env = loadEnv({ NODE_ENV: 'production', ENVIRONMENT: environment });
      expect(env.ENVIRONMENT).toBe(environment);
    },
  );

  it('accepts a fully-credentialled hardened deployment', () => {
    resetEnvCache();
    const env = loadEnv({
      NODE_ENV: 'production',
      ENVIRONMENT: 'preprod',
      SUPABASE_URL: 'https://preprod.supabase.co',
      SUPABASE_ANON_KEY: 'a'.repeat(40),
      SUPABASE_SERVICE_KEY: 'b'.repeat(40),
      APPROVAL_SIGNING_KEY: 'k'.repeat(48),
      AGENT_RUNTIME_INTERNAL_TOKEN: 't'.repeat(32),
      AGENT_RUNTIME_URL: 'https://agent-runtime.preprod.internal',
      MODEL_GATEWAY_API_KEY: 'm'.repeat(32),
    });
    expect(env.ENVIRONMENT).toBe('preprod');
    expect(env.AXIOM_AUTH_MODE).toBe('strict');
  });

  it('resolves primary AXIOM_* storage variables and mirrors to legacy AWS_* aliases', () => {
    resetEnvCache();
    const env = loadEnv({
      AXIOM_REGION: 'asia-south1',
      AXIOM_EVIDENCE_BUCKET: 'custom-evidence-bucket',
      AXIOM_STORAGE_ENDPOINT: 'https://storage.googleapis.com',
      AXIOM_STORAGE_ACCESS_KEY_ID: 'GOOG12345',
      AXIOM_STORAGE_SECRET_ACCESS_KEY: 'secret12345',
      AXIOM_PROJECT_ID: 'axiom-proof-preprod',
    });

    expect(env.AXIOM_REGION).toBe('asia-south1');
    expect(env.AWS_REGION).toBe('asia-south1');
    expect(env.AXIOM_EVIDENCE_BUCKET).toBe('custom-evidence-bucket');
    expect(env.AWS_S3_EVIDENCE_BUCKET).toBe('custom-evidence-bucket');
    expect(env.AXIOM_STORAGE_ENDPOINT).toBe('https://storage.googleapis.com');
    expect(env.AWS_S3_ENDPOINT).toBe('https://storage.googleapis.com');
    expect(env.AXIOM_STORAGE_ACCESS_KEY_ID).toBe('GOOG12345');
    expect(env.AWS_ACCESS_KEY_ID).toBe('GOOG12345');
    expect(env.AXIOM_STORAGE_SECRET_ACCESS_KEY).toBe('secret12345');
    expect(env.AWS_SECRET_ACCESS_KEY).toBe('secret12345');
    expect(env.AXIOM_PROJECT_ID).toBe('axiom-proof-preprod');
    expect(env.GCP_PROJECT_ID).toBe('axiom-proof-preprod');
  });

  it('accepts legacy AWS_* variables and mirrors them to AXIOM_* variables', () => {
    resetEnvCache();
    const env = loadEnv({
      AWS_REGION: 'ap-south-1',
      AWS_S3_EVIDENCE_BUCKET: 'legacy-bucket',
      AWS_S3_ENDPOINT: 'https://storage.googleapis.com',
      AWS_ACCESS_KEY_ID: 'AWS123',
      AWS_SECRET_ACCESS_KEY: 'AWSSEC123',
      GCP_PROJECT_ID: 'legacy-gcp-project',
    });

    expect(env.AXIOM_REGION).toBe('ap-south-1');
    expect(env.AXIOM_EVIDENCE_BUCKET).toBe('legacy-bucket');
    expect(env.AXIOM_STORAGE_ENDPOINT).toBe('https://storage.googleapis.com');
    expect(env.AXIOM_STORAGE_ACCESS_KEY_ID).toBe('AWS123');
    expect(env.AXIOM_STORAGE_SECRET_ACCESS_KEY).toBe('AWSSEC123');
    expect(env.AXIOM_PROJECT_ID).toBe('legacy-gcp-project');
  });
});

describe('resolveAuthMode — W0.0 · SEC-1 · SEC-2 · SEC-13', () => {
  const base = {
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_ANON_KEY: 'a'.repeat(40),
    SUPABASE_SERVICE_KEY: 'b'.repeat(40),
  };

  it('defaults to strict when AXIOM_AUTH_MODE is unset', () => {
    resetEnvCache();
    expect(resolveAuthMode({ ...base })).toBe('strict');
    resetEnvCache();
    expect(isAuthBypassEnabled({ ...base })).toBe(false);
  });

  it('defaults to strict when ENVIRONMENT is unset entirely', () => {
    resetEnvCache();
    expect(resolveAuthMode({})).toBe('strict');
  });

  it.each(['local', 'test'] as const)('permits e2e-bypass in %s', (environment) => {
    resetEnvCache();
    expect(
      resolveAuthMode({ ...base, ENVIRONMENT: environment, AXIOM_AUTH_MODE: 'e2e-bypass' }),
    ).toBe('e2e-bypass');
  });

  // The core of W0.0: no deployed environment can reach the bypass, whatever
  // NODE_ENV says. The process refuses to start rather than degrading.
  it.each(['development', 'staging', 'preprod', 'production', 'onprem'] as const)(
    'refuses to boot with e2e-bypass in %s',
    (environment) => {
      resetEnvCache();
      expect(() =>
        loadEnv({ ...base, ENVIRONMENT: environment, AXIOM_AUTH_MODE: 'e2e-bypass' }),
      ).toThrow(/AXIOM_AUTH_MODE/);
    },
  );

  it('refuses to boot with e2e-bypass when ENVIRONMENT is unset', () => {
    resetEnvCache();
    expect(() => loadEnv({ ...base, AXIOM_AUTH_MODE: 'e2e-bypass' })).toThrow(
      /permitted only when ENVIRONMENT is/,
    );
  });

  // SEC-1: an unset NODE_ENV used to flip five separate security branches open.
  // The auth mode is now independent of NODE_ENV in both directions.
  const hardened = {
    SUPABASE_URL: 'https://deployed.supabase.co',
    SUPABASE_ANON_KEY: 'a'.repeat(40),
    SUPABASE_SERVICE_KEY: 'b'.repeat(40),
    APPROVAL_SIGNING_KEY: 'k'.repeat(48),
    AGENT_RUNTIME_INTERNAL_TOKEN: 't'.repeat(32),
    AGENT_RUNTIME_URL: 'https://agent-runtime.internal',
    MODEL_GATEWAY_API_KEY: 'm'.repeat(32),
  };

  it('is unaffected by an unset or non-production NODE_ENV', () => {
    resetEnvCache();
    expect(resolveAuthMode({ ...hardened, ENVIRONMENT: 'staging' })).toBe('strict');
    resetEnvCache();
    expect(resolveAuthMode({ ...hardened, ENVIRONMENT: 'preprod', NODE_ENV: 'development' })).toBe(
      'strict',
    );
  });

  // Inverse of the above: a hardened environment cannot buy the bypass by
  // lying about NODE_ENV either.
  it('refuses e2e-bypass in a hardened environment regardless of NODE_ENV', () => {
    resetEnvCache();
    expect(() =>
      loadEnv({
        ...hardened,
        ENVIRONMENT: 'staging',
        NODE_ENV: 'development',
        AXIOM_AUTH_MODE: 'e2e-bypass',
      }),
    ).toThrow(/AXIOM_AUTH_MODE/);
  });

  it('rejects an unrecognised auth mode rather than falling back', () => {
    resetEnvCache();
    expect(() => loadEnv({ ...base, AXIOM_AUTH_MODE: 'permissive' })).toThrow(
      /Invalid environment configuration/,
    );
  });
});

describe('BRAND', () => {
  it('has a stable name', () => {
    expect(BRAND.name).toBe('Axiom Proof');
  });
  it('has a stable company', () => {
    expect(BRAND.company).toBe('Axiom Minds Private Limited');
  });
  it('has correct product and company domains', () => {
    expect(BRAND.primaryDomain).toBe('axiomproof.ai');
    expect(BRAND.productDomain).toBe('app.axiomproof.ai');
    expect(BRAND.companyDomain).toBe('axiomminds.ai');
  });
});
