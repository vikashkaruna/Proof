#!/usr/bin/env tsx
/**
 * Emit controls.json from the TypeScript control library.
 *
 * This runs the TS module under tsx, so we get the real source of
 * truth without a hand-rolled TS parser. The output is consumed by
 * the Python agent runtime's control library loader.
 *
 * Run from the repo root:
 *   pnpm tsx scripts/build-controls-json.mjs
 *
 * Output: services/agent-runtime/src/axiom/data/controls.json, or the path
 * given as the first argument — which is how `check-controls-drift.sh`
 * regenerates to a scratch file and compares without touching the tree.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

// Use a dynamic import via tsx's TS transformer
const { controls, LIBRARY_VERSION } = await import(
  join(repoRoot, 'packages/control-library/src/controls.ts')
);

const out = {
  version: LIBRARY_VERSION,
  controls: controls.map((c) => ({
    id: c.id,
    library_version: LIBRARY_VERSION,
    title: c.title,
    obligation: c.obligation,
    domain: c.domain,
    severity: c.severity,
    citations: c.citations,
    evidence_required: c.evidenceRequired,
    assessment_questions: c.assessmentQuestions,
    scoring: c.scoring,
    remediation_patterns: c.remediationPatterns,
    tags: c.tags,
    sdf_only: c.sdfOnly,
    children_only: c.childrenOnly,
    introduced_in_version: c.introducedInVersion,
    revised_in_version: c.revisedInVersion ?? null,
    notes: c.notes ?? null,
  })),
};

const outPath =
  process.argv[2] ?? join(repoRoot, 'services/agent-runtime/src/axiom/data/controls.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf-8');

console.log(`✓ Wrote ${out.controls.length} controls to ${outPath}`);
