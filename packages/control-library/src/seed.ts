/**
 * Control library seed — transforms the v0 controls into a Supabase-ready
 * payload for `bulk insert` into the `controls` table.
 */

import type { Control } from './types';
import {
  CONTROL_LIBRARY_COUNT,
  controls,
  LIBRARY_VERSION,
  LIBRARY_PUBLISHED_AT,
  LIBRARY_PUBLISHER,
  LIBRARY_CHANGELOG,
} from './controls';

/** Supabase `controls` row for one control at an explicit library version. */
export function controlSeedRow(c: Control, libraryVersion: string) {
  return {
    id: c.id,
    library_version: libraryVersion,
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
  };
}

/** Seed for the default (published, current) library. Byte-stable for 0.1.1. */
export function buildLibrarySeed() {
  return {
    version: LIBRARY_VERSION,
    publishedAt: LIBRARY_PUBLISHED_AT,
    publishedBy: LIBRARY_PUBLISHER,
    changeLog: LIBRARY_CHANGELOG,
    controls: controls.map((c) => controlSeedRow(c, LIBRARY_VERSION)),
  };
}

// Auto-validate on import so misconfigured libraries fail fast.
const validation = (() => {
  // Lazy import to keep validateLibrary side-effect-free
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const c of controls) {
    if (seen.has(c.id)) errors.push(`Duplicate control id: ${c.id}`);
    seen.add(c.id);
  }
  if (controls.length !== CONTROL_LIBRARY_COUNT) {
    errors.push(`Expected ${CONTROL_LIBRARY_COUNT} controls, found ${controls.length}`);
  }
  return errors;
})();

if (validation.length > 0) {
  // eslint-disable-next-line no-console
  console.error('Control library validation failed:', validation);
  throw new Error('Control library invariants violated');
}
