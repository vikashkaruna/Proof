/**
 * The Python agent-runtime mirror of a control library version.
 *
 * `scripts/build-controls-json.mjs` writes these objects with
 * `JSON.stringify(mirror, null, 2)`; `scripts/check-controls-drift.sh` and the
 * package tests compare the committed files byte for byte.
 *
 * Published 0.1.1 keeps its historical file name and exact shape
 * (`controls.json`, including the sector-pack overlay). Other versions are
 * written to `controls-<version>.json` and carry no sector-pack overlay: the
 * reviewed mapping contexts are bound to 0.1.1 and must not be re-labelled.
 */
import { controlSeedRow } from './seed';
import { resolveControlLibrary } from './library-versions';
import { LIBRARY_VERSION as LEGACY_MIRROR_VERSION } from './controls';
import {
  ALL_CONTROL_MAPPINGS,
  ALL_FRAMEWORK_CONTROLS,
  ALL_FRAMEWORKS,
  ALL_MAPPING_CONTEXTS,
  ALL_SECTOR_PACKS,
  LEGACY_MAPPING_SCOPE,
  MAPPING_CONTEXT_PUBLICATION_VERSION,
} from './sector-packs';
import { LEGAL_REVIEW_0_2_0, OFFICIAL_SOURCES_0_2_0 } from './versions/v0_2_0/legal-registry';

export function runtimeMirrorFileName(version: string): string {
  resolveControlLibrary(version);
  return version === LEGACY_MIRROR_VERSION ? 'controls.json' : `controls-${version}.json`;
}

function sectorPacks(libraryVersion: string) {
  return {
    frameworks: ALL_FRAMEWORKS.map((f) => ({
      code: f.code,
      regulator: f.regulator,
      title: f.title,
      description: f.description,
      source_url: f.sourceUrl,
      verified_on: f.verifiedOn,
      verified_by: f.verifiedBy,
      notes: f.notes ?? null,
    })),
    framework_controls: ALL_FRAMEWORK_CONTROLS.map((fc) => ({
      framework_code: fc.frameworkCode,
      ref: fc.ref,
      heading: fc.heading,
    })),
    legacy_mapping_scope: LEGACY_MAPPING_SCOPE,
    // Source metadata only: no database publication/receipt is asserted by this mirror.
    mapping_context_publication: {
      origin: 'reviewed_source_reference',
      publicationVersion: MAPPING_CONTEXT_PUBLICATION_VERSION,
      libraryVersion,
      contexts: ALL_MAPPING_CONTEXTS,
    },
    control_mappings: ALL_CONTROL_MAPPINGS.map((m) => ({
      framework_code: m.frameworkCode,
      ref: m.ref,
      control_id: m.controlId,
      mapping_strength: m.mappingStrength,
      provenance: m.provenance,
      note: m.note,
    })),
    packs: ALL_SECTOR_PACKS.map((p) => ({
      code: p.code,
      name: p.name,
      sector: p.sector,
      description: p.description,
      framework_codes: p.frameworkCodes,
      control_ids: p.controlIds,
      evidence_requirements: p.evidenceRequirements,
      remediation_patterns: p.remediationPatterns,
      provenance: p.provenance,
      basis: p.basis,
    })),
  };
}

export function buildRuntimeMirror(version: string): Record<string, unknown> {
  const lib = resolveControlLibrary(version);
  const controls = lib.controls.map((c) => controlSeedRow(c, lib.version));
  if (version === LEGACY_MIRROR_VERSION)
    return { version: lib.version, controls, sector_packs: sectorPacks(lib.version) };
  return {
    version: lib.version,
    controls,
    legal: {
      status: lib.status,
      baseline: lib.baseline,
      published_at: lib.publishedAt,
      published_by: lib.publishedBy,
      default_effective_from: lib.defaultEffectiveFrom,
      review: LEGAL_REVIEW_0_2_0,
      official_sources: OFFICIAL_SOURCES_0_2_0,
      commencement: (lib.commencement ?? []).map((c) => ({
        control_id: c.controlId,
        effective_from: c.effectiveFrom,
        provisions: c.provisions.map((p) => ({
          instrument: p.instrument,
          reference: p.reference,
          group: p.group,
          commences_on: p.commencesOn,
        })),
      })),
      records: lib.legalRecords.map((r) => ({
        control_id: r.controlId,
        legal_basis: r.legalBasis,
        conditional_questions: r.conditionalQuestions.map((q) => ({
          question_id: q.questionId,
          condition: q.condition,
        })),
        primary_sources: r.primarySources.map((s) => ({
          source: s.source,
          pdf_page: s.pdfPageOneBased,
          paragraph: s.paragraph,
        })),
        corrects_finding: r.correctsFinding,
        statutory_penalty_inference: r.statutoryPenaltyInference,
      })),
    },
  };
}
