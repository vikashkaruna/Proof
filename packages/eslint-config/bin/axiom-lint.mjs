#!/usr/bin/env node
/**
 * Runs the ESLint pinned by @axiom/eslint-config against the caller's package.
 *
 * The apps cannot simply run `eslint` from their own node_modules: the repo is
 * on ESLint 10 and TypeScript 7, and the Next.js lint toolchain supports
 * neither yet (see index.mjs for the full explanation). This package installs
 * the versions that do work — ESLint 9 and TypeScript 6 — in its own isolated
 * dependency graph, and this shim invokes that copy.
 *
 * Arguments are forwarded, so `axiom-lint --fix` and friends behave normally.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

let eslintBin;
try {
  // Resolve the ESLint this package depends on, not whatever the app has.
  eslintBin = path.join(path.dirname(require.resolve('eslint/package.json')), 'bin', 'eslint.js');
} catch {
  console.error(
    '[axiom-lint] Could not resolve the pinned ESLint. Run `pnpm install` at the repo root.',
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const target = args.length > 0 ? args : ['.'];

// Flat config resolves plugins relative to the config file itself, which
// lives in this package — so no plugin-resolution flag is needed or accepted.
const result = spawnSync(process.execPath, [eslintBin, ...target], {
  stdio: 'inherit',
  cwd: process.cwd(),
});

process.exit(result.status ?? 1);
