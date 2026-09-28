import { describe, expect, it } from 'vitest';
import { controls } from './controls';
import {
  ALL_CONTROL_MAPPINGS,
  ALL_FRAMEWORK_CONTROLS,
  ALL_FRAMEWORKS,
  ALL_SECTOR_PACKS,
  BFSI_CONTROL_MAPPINGS,
  BFSI_FRAMEWORK_CONTROLS,
  BFSI_FRAMEWORKS,
  BFSI_SECTOR_PACK,
  HEALTHCARE_CONTROL_MAPPINGS,
  HEALTHCARE_FRAMEWORK_CONTROLS,
  HEALTHCARE_FRAMEWORKS,
  HEALTHCARE_SECTOR_PACK,
  MappingProvenanceSchema,
  MappingStrengthSchema,
  OverlayRegulatorSchema,
  SectorPackSectorSchema,
  TECH_CONTROL_MAPPINGS,
  TECH_FRAMEWORK_CONTROLS,
  TECH_FRAMEWORKS,
  TECH_SECTOR_PACK,
  validateSectorPacks,
} from './sector-packs';

describe('Sector packs & multi-regulator frameworks (W7.3/W7.4 · M4.2/M4.8)', () => {
  it('passes its own reference validation across all packs', () => {
    expect(validateSectorPacks()).toEqual([]);
  });

  it('delivers all three planned sector packs', () => {
    expect(ALL_SECTOR_PACKS.map((p) => p.code)).toEqual([
      'BFSI-1',
      'IN-HEALTHCARE-2024',
      'IN-TECH-2024',
    ]);
    expect(ALL_SECTOR_PACKS.map((p) => p.sector)).toEqual([
      'BFSI',
      'Healthcare',
      'Tech/E-commerce',
    ]);
  });

  it('maps only onto controls that exist in the library', () => {
    const known = new Set(controls.map((c) => c.id));
    for (const m of ALL_CONTROL_MAPPINGS) {
      expect(known.has(m.controlId), m.controlId).toBe(true);
    }
  });

  it('resolves every mapping to a framework control under the same framework', () => {
    const keys = new Set(ALL_FRAMEWORK_CONTROLS.map((fc) => `${fc.frameworkCode}::${fc.ref}`));
    for (const m of ALL_CONTROL_MAPPINGS) {
      expect(keys.has(`${m.frameworkCode}::${m.ref}`), `${m.frameworkCode}::${m.ref}`).toBe(true);
    }
  });

  it('uses only the plan-named overlay regulators (M4.2)', () => {
    for (const f of ALL_FRAMEWORKS) {
      expect(OverlayRegulatorSchema.safeParse(f.regulator).success, f.code).toBe(true);
    }
  });

  it('labels every mapping honestly and caps the strength below equivalence', () => {
    expect(ALL_CONTROL_MAPPINGS.length).toBeGreaterThan(0);
    for (const m of ALL_CONTROL_MAPPINGS) {
      expect(MappingProvenanceSchema.safeParse(m.provenance).success, m.controlId).toBe(true);
      expect(m.provenance === 'reference' || m.provenance === 'mapped', m.controlId).toBe(true);
      expect(MappingStrengthSchema.safeParse(m.mappingStrength).success, m.controlId).toBe(true);
      expect(m.mappingStrength === 'equivalent', m.controlId).toBe(false);
      expect(m.note.length, m.controlId).toBeGreaterThan(20);
    }
  });

  it('keeps all packs coherent: subset drawn from mapped controls, frameworks declared', () => {
    const allFrameworkCodes = new Set(ALL_FRAMEWORKS.map((f) => f.code));

    for (const pack of ALL_SECTOR_PACKS) {
      expect(SectorPackSectorSchema.safeParse(pack.sector).success).toBe(true);
      for (const code of pack.frameworkCodes) {
        expect(allFrameworkCodes.has(code), code).toBe(true);
      }
      const packMappings = ALL_CONTROL_MAPPINGS.filter((m) =>
        pack.frameworkCodes.includes(m.frameworkCode),
      );
      const mappedControls = new Set(packMappings.map((m) => m.controlId));
      for (const id of pack.controlIds) {
        expect(mappedControls.has(id), `${pack.code} missing mapping for ${id}`).toBe(true);
      }
      // Every framework declared in pack has at least one mapping
      const usedFrameworks = new Set(packMappings.map((m) => m.frameworkCode));
      for (const code of pack.frameworkCodes) {
        expect(usedFrameworks.has(code), `${pack.code} framework ${code} unused`).toBe(true);
      }
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
    for (const pack of ALL_SECTOR_PACKS) {
      for (const e of pack.evidenceRequirements) {
        expect(evidenceTypes.has(e.evidenceType), e.requirement).toBe(true);
      }
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
    for (const pack of ALL_SECTOR_PACKS) {
      for (const p of pack.remediationPatterns) {
        expect(remediation.has(p), p).toBe(true);
      }
    }
  });

  it('does not offer vendor-verified as a provenance value anywhere in the pack data', () => {
    expect(MappingProvenanceSchema.options).toEqual(['reference', 'mapped']);
    for (const m of ALL_CONTROL_MAPPINGS) {
      expect(['reference', 'mapped']).toContain(m.provenance);
    }
    for (const pack of ALL_SECTOR_PACKS) {
      expect(pack.provenance).toBe('reference');
    }
  });
});
