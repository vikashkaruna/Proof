import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Each file gets a fresh module registry. The middleware modules call
    // loadEnv() at module scope, so a test file must be able to set its own
    // process.env before importing them.
    isolate: true,
    pool: 'forks',
    include: ['src/**/*.test.ts'],
  },
});
