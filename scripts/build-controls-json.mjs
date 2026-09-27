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

// W7.3/W7.4 — the multi-regulator overlay and sector packs travel with the
// library so the runtime mirror carries the same cross-walks the portal
// publishes. Everything is reference-provenance data from the TypeScript
// source of truth.
const { BFSI_FRAMEWORKS, BFSI_FRAMEWORK_CONTROLS, BFSI_CONTROL_MAPPINGS, BFSI_SECTOR_PACK } =
  await import(join(repoRoot, 'packages/control-library/src/sector-packs.ts'));

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
  // W7.3/W7.4 multi-regulator overlay + sector packs. The runtime scores
  // DPDPA controls; this section lets it report cross-framework coverage
  // and pack membership without a second mirror to keep in step.
  sector_packs: {
    frameworks: BFSI_FRAMEWORKS.map((f) => ({
      code: f.code,
      regulator: f.regulator,
      title: f.title,
      description: f.description,
      source_url: f.sourceUrl,
      verified_on: f.verifiedOn,
      verified_by: f.verifiedBy,
      notes: f.notes ?? null,
    })),
    framework_controls: BFSI_FRAMEWORK_CONTROLS.map((fc) => ({
      framework_code: fc.frameworkCode,
      ref: fc.ref,
      heading: fc.heading,
    })),
    control_mappings: BFSI_CONTROL_MAPPINGS.map((m) => ({
      framework_code: m.frameworkCode,
      ref: m.ref,
      control_id: m.controlId,
      mapping_strength: m.mappingStrength,
      provenance: m.provenance,
      note: m.note,
    })),
    packs: [
      {
        code: BFSI_SECTOR_PACK.code,
        name: BFSI_SECTOR_PACK.name,
        sector: BFSI_SECTOR_PACK.sector,
        description: BFSI_SECTOR_PACK.description,
        framework_codes: BFSI_SECTOR_PACK.frameworkCodes,
        control_ids: BFSI_SECTOR_PACK.controlIds,
        evidence_requirements: BFSI_SECTOR_PACK.evidenceRequirements,
        remediation_patterns: BFSI_SECTOR_PACK.remediationPatterns,
        provenance: BFSI_SECTOR_PACK.provenance,
        basis: BFSI_SECTOR_PACK.basis,
      },
    ],
  },
};

const outPath =
  process.argv[2] ?? join(repoRoot, 'services/agent-runtime/src/axiom/data/controls.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf-8');

console.log(`✓ Wrote ${out.controls.length} controls to ${outPath}`);
