import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    // Each file gets a fresh module registry. The middleware modules call
    // loadEnv() at module scope, so a test file must be able to set its own
    // process.env before importing them.
    isolate: true,
    pool: 'forks',
    // Bound CPU-heavy MFA fixtures and local RPC tests on shared developer hosts.
    maxWorkers: 4,
    include: ['src/**/*.test.ts'],
  },
});
