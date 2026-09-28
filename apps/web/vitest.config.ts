import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'node',
    testTimeout: 20000,
    hookTimeout: 20000,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Playwright specs live in tests/e2e and are driven by `pnpm test:e2e`.
    exclude: ['**/node_modules/**', 'tests/e2e/**', '**/dist/**'],
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
});
