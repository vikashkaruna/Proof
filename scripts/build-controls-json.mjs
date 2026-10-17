#!/usr/bin/env tsx
/**
 * Emit the Python runtime mirrors of the TypeScript control library.
 *
 * This runs the TS module under tsx, so we get the real source of
 * truth without a hand-rolled TS parser. The output is consumed by
 * the Python agent runtime's control library loader.
 *
 * Run from the repo root:
 *   pnpm tsx scripts/build-controls-json.mjs
 *     → writes every known version into services/agent-runtime/src/axiom/data/
 *       (the default version as controls.json, others as controls-<version>.json)
 *   pnpm tsx scripts/build-controls-json.mjs <outPath> [version]
 *     → writes one version (default: the default library version) to <outPath>;
 *       this is how `check-controls-drift.sh` regenerates to scratch files.
 *
 * The mirror shape lives in packages/control-library/src/runtime-mirror.ts.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const { buildRuntimeMirror, runtimeMirrorFileName } = await import(
  join(repoRoot, 'packages/control-library/src/runtime-mirror.ts')
);
const { DEFAULT_LIBRARY_VERSION, KNOWN_LIBRARY_VERSIONS } = await import(
  join(repoRoot, 'packages/control-library/src/library-versions.ts')
);

function write(version, outPath) {
  const out = buildRuntimeMirror(version);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf-8');
  console.log(`✓ Wrote ${out.controls.length} controls (v${version}) to ${outPath}`);
}

if (process.argv[2]) {
  write(process.argv[3] ?? DEFAULT_LIBRARY_VERSION, process.argv[2]);
} else {
  const dataDir = join(repoRoot, 'services/agent-runtime/src/axiom/data');
  for (const version of KNOWN_LIBRARY_VERSIONS) {
    write(version, join(dataDir, runtimeMirrorFileName(version)));
  }
}
