import { describe, expect, it } from 'vitest';
import { controls } from './controls';
import {
  BFSI_CONTROL_MAPPINGS,
  BFSI_FRAMEWORK_CONTROLS,
  BFSI_FRAMEWORKS,
  BFSI_SECTOR_PACK,
  MappingProvenanceSchema,
  MappingStrengthSchema,
  OverlayRegulatorSchema,
  SectorPackSectorSchema,
  validateSectorPacks,
} from './sector-packs';

describe('BFSI sector pack (W7.3/W7.4 · M4.2/M4.8)', () => {
  it('passes its own reference validation', () => {
    expect(validateSectorPacks()).toEqual([]);
  });

  it('maps only onto controls that exist in the library', () => {
    const known = new Set(controls.map((c) => c.id));
    for (const m of BFSI_CONTROL_MAPPINGS) {
      expect(known.has(m.controlId), m.controlId).toBe(true);
    }
  });

  it('resolves every mapping to a framework control under the same framework', () => {
    const keys = new Set(BFSI_FRAMEWORK_CONTROLS.map((fc) => `${fc.frameworkCode}::${fc.ref}`));
    for (const m of BFSI_CONTROL_MAPPINGS) {
      expect(keys.has(`${m.frameworkCode}::${m.ref}`), `${m.frameworkCode}::${m.ref}`).toBe(true);
    }
  });

  it('uses only the plan-named overlay regulators (M4.2)', () => {
    for (const f of BFSI_FRAMEWORKS) {
      expect(OverlayRegulatorSchema.safeParse(f.regulator).success, f.code).toBe(true);
    }
  });

  it('labels every mapping honestly and caps the strength below equivalence', () => {
    expect(BFSI_CONTROL_MAPPINGS.length).toBeGreaterThan(0);
    for (const m of BFSI_CONTROL_MAPPINGS) {
      expect(MappingProvenanceSchema.safeParse(m.provenance).success, m.controlId).toBe(true);
      // Nothing in the reference pack can honestly claim equivalence, and
      // nothing may claim vendor verification without client tenants.
      expect(m.provenance === 'reference' || m.provenance === 'mapped', m.controlId).toBe(true);
      expect(MappingStrengthSchema.safeParse(m.mappingStrength).success, m.controlId).toBe(true);
      expect(m.mappingStrength === 'equivalent', m.controlId).toBe(false);
      expect(m.note.length, m.controlId).toBeGreaterThan(20);
    }
  });

  it('keeps the pack coherent: subset drawn from mapped controls, frameworks declared', () => {
    const mapped = new Set(BFSI_CONTROL_MAPPINGS.map((m) => m.controlId));
    const frameworks = new Set(BFSI_FRAMEWORKS.map((f) => f.code));
    expect(BFSI_SECTOR_PACK.sector).toBe('BFSI');
    expect(SectorPackSectorSchema.safeParse(BFSI_SECTOR_PACK.sector).success).toBe(true);
    for (const id of BFSI_SECTOR_PACK.controlIds) {
      expect(mapped.has(id), id).toBe(true);
    }
    for (const code of BFSI_SECTOR_PACK.frameworkCodes) {
      expect(frameworks.has(code), code).toBe(true);
    }
    // Every framework the pack declares is actually used by a mapping.
    const used = new Set(BFSI_CONTROL_MAPPINGS.map((m) => m.frameworkCode));
    for (const code of BFSI_SECTOR_PACK.frameworkCodes) {
      expect(used.has(code), code).toBe(true);
    }
  });

  it('reuses the library evidence vocabulary for sector evidence requirements', () => {
    const evidenceTypes = new Set([
      'document',
      'config',
      'screenshot',
      'log',
      'attestation',
      'interview',
      'inventory',
      'report',
    ]);
    for (const e of BFSI_SECTOR_PACK.evidenceRequirements) {
      expect(evidenceTypes.has(e.evidenceType), e.requirement).toBe(true);
    }
    const remediation = new Set([
      'policy',
      'consent',
      'config',
      'data-deletion',
      'data-masking',
      'data-portability',
      'dpo-appointment',
      'dpa-execution',
      'breach-process',
      'training',
      'discovery',
      'vendor-risk',
      'review',
      'reporting',
    ]);
    for (const p of BFSI_SECTOR_PACK.remediationPatterns) {
      expect(remediation.has(p), p).toBe(true);
    }
  });

  it('does not offer vendor-verified as a provenance value anywhere in the pack data', () => {
    // The honest vocabulary has exactly two values; vendor-verified is
    // deliberately absent from the schema (it requires client tenants).
    expect(MappingProvenanceSchema.options).toEqual(['reference', 'mapped']);
    for (const m of BFSI_CONTROL_MAPPINGS) {
      expect(['reference', 'mapped']).toContain(m.provenance);
    }
    expect(BFSI_SECTOR_PACK.provenance).toBe('reference');
  });
});
