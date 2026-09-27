import { z } from 'zod';
import { controls } from './controls';

/**
 * Axiom Proof — Sector packs and multi-regulator mappings (W7.3/W7.4)
 *
 * M4.2 (multi-regulator control reuse): the DPDPA control set gains
 * cross-walks onto the regulators the plan names — RBI, SEBI, IRDAI and
 * CERT-In — so one sealed evidence artifact can satisfy N controls across M
 * frameworks.
 *
 * M4.8 (sectoral packs): a pack is a control subset + overlay mappings +
 * sector-specific evidence requirements + remediation patterns. Pack #1 is
 * BFSI (operator decision recorded 2026-09-26: pack order is BFSI →
 * Healthcare → Tech/E-commerce; this module delivers BFSI only).
 *
 * PROVENANCE — read this before you promote a mapping:
 *
 * Every mapping below carries `provenance: 'reference'`. That is the honest
 * label under this library's conventions (the connector descriptors use the
 * same vocabulary): the mapping was derived from the regulator's public
 * materials, NOT verified against a client engagement and NOT verified
 * clause-by-clause against the regulator's printed text. 'vendor-verified'
 * is deliberately absent from the schema — it requires client tenants, and
 * nothing in the platform can honestly assert it yet (a recorded leftover
 * from the W4.7 descriptor work).
 *
 * `mapping_strength` follows M4.2 exactly:
 *   equivalent — the two requirements test the same thing (requires
 *                regulator-side verification; no BFSI mapping claims it yet)
 *   partial    — genuine overlap with material differences in scope or clock
 *   indicative — a starting point for a human reviewer, not a claim
 *
 * Until a framework's refs are re-verified against the regulator's printed
 * text, framework control refs here are TOPICAL slugs, not printed
 * citations — inventing paragraph numbers would be a CTL-1-class error.
 */

/** M4.2 mapping strength. */
export const MappingStrengthSchema = z.enum(['equivalent', 'partial', 'indicative']);
export type MappingStrength = z.infer<typeof MappingStrengthSchema>;

/**
 * Honest provenance vocabulary. 'vendor-verified' is deliberately excluded
 * until client tenants exist; see the module header.
 */
export const MappingProvenanceSchema = z.enum(['reference', 'mapped']);
export type MappingProvenance = z.infer<typeof MappingProvenanceSchema>;

/** The overlay regulators the plan names for multi-regulator reuse (M4.2). */
export const OverlayRegulatorSchema = z.enum(['RBI', 'SEBI', 'IRDAI', 'CERT-In']);
export type OverlayRegulator = z.infer<typeof OverlayRegulatorSchema>;

/** Pack sectors named by the plan (M4.8) and the 2026-09-26 operator decision. */
export const SectorPackSectorSchema = z.enum(['BFSI', 'Healthcare', 'Tech/E-commerce']);
export type SectorPackSector = z.infer<typeof SectorPackSectorSchema>;

export interface SectorPackFramework {
  /** Stable short code, e.g. 'RBI-MD-ITG'. */
  code: string;
  regulator: OverlayRegulator;
  title: string;
  description: string;
  sourceUrl: string;
  /** When a human last checked this RECORD against the regulator's publication. */
  verifiedOn: string;
  verifiedBy: string;
  notes?: string;
}

export interface SectorPackFrameworkControl {
  frameworkCode: string;
  /** Topical slug, not a printed citation — see the module header. */
  ref: string;
  heading: string;
}

export interface SectorPackMapping {
  frameworkCode: string;
  /** Resolves to a SectorPackFrameworkControl under the same framework. */
  ref: string;
  /** An existing DPDPA control id — validated against the library below. */
  controlId: string;
  mappingStrength: MappingStrength;
  provenance: MappingProvenance;
  /** Why this mapping exists, and what it does NOT claim. */
  note: string;
}

export interface SectorPackEvidenceRequirement {
  requirement: string;
  evidenceType: 'document' | 'config' | 'screenshot' | 'log' | 'attestation' | 'report';
}

export interface SectorPack {
  code: string;
  name: string;
  sector: SectorPackSector;
  description: string;
  frameworkCodes: string[];
  /** The DPDPA control subset, every id drawn from the mapped set. */
  controlIds: string[];
  evidenceRequirements: SectorPackEvidenceRequirement[];
  /** Remediation patterns reuse the library's existing vocabulary. */
  remediationPatterns: string[];
  provenance: MappingProvenance;
  /** What the pack asserts about its own basis. */
  basis: string;
}

/**
 * The BFSI overlay frameworks. Records are reference-grade: each names the
 * regulator's own domain as its source, and the notes state what is still
 * unverified. Nothing here is asserted as a printed citation.
 */
export const BFSI_FRAMEWORKS: readonly SectorPackFramework[] = [
  {
    code: 'RBI-MD-ITG',
    regulator: 'RBI',
    title:
      'Master Direction on Information Technology Governance, Risk, Controls and Assurance Practices',
    description:
      "RBI direction to supervised entities on board-level IT governance, information security controls, IS audit and resilience. The BFSI sector's broadest baseline IT/data regime.",
    sourceUrl: 'https://www.rbi.org.in',
    verifiedOn: '2026-09-26',
    verifiedBy: 'Axiom Minds · Founder',
    notes:
      'Reference record. Chapter-level topical refs only; paragraph-level mapping and verbatim verification against the printed Master Direction are pending.',
  },
  {
    code: 'RBI-NBFC-AA',
    regulator: 'RBI',
    title:
      'Master Direction on Non-Banking Financial Company – Account Aggregator (consent-artefact regime)',
    description:
      'The Account Aggregator regime\'s consent-artefact model: explicit, purpose-bound, revocable consent before financial information is fetched or shared. The plan\'s named "RBI / Account Aggregator overlay" for pack #1.',
    sourceUrl: 'https://www.rbi.org.in',
    verifiedOn: '2026-09-26',
    verifiedBy: 'Axiom Minds · Founder',
    notes:
      'Reference record. The consent-artefact obligations are topical refs; the printed Direction and its amendments must be re-verified before any equivalence claim.',
  },
  {
    code: 'RBI-PAYMENT-DATA',
    regulator: 'RBI',
    title: 'Directive on Storage of Payment System Data',
    description:
      "Payment system data must be stored only in India; any processing abroad is time-bound with erasure obligations. Strictly stricter than the DPDPA's cross-border blacklist model.",
    sourceUrl: 'https://www.rbi.org.in',
    verifiedOn: '2026-09-26',
    verifiedBy: 'Axiom Minds · Founder',
    notes: 'Reference record; paragraph-level verification pending.',
  },
  {
    code: 'SEBI-CYBER-RESILIENCE',
    regulator: 'SEBI',
    title: 'SEBI Cybersecurity and Cyber Resilience Framework for regulated entities',
    description:
      'Baseline cyber-security controls, monitoring, VAPT and time-bound incident reporting for SEBI-regulated market intermediaries.',
    sourceUrl: 'https://www.sebi.gov.in',
    verifiedOn: '2026-09-26',
    verifiedBy: 'Axiom Minds · Founder',
    notes: 'Reference record; circular-level citation and clause verification pending.',
  },
  {
    code: 'IRDAI-CYBER-SECURITY',
    regulator: 'IRDAI',
    title: 'IRDAI Information and Cyber Security Guidelines',
    description:
      'Information-security baseline, access and audit-logging, and outsourcing oversight for insurers carrying policyholder data.',
    sourceUrl: 'https://irdai.gov.in',
    verifiedOn: '2026-09-26',
    verifiedBy: 'Axiom Minds · Founder',
    notes:
      'Reference record; the guideline edition in force for a given insurer must be confirmed during engagement, not assumed.',
  },
  {
    code: 'CERT-IN-DIRECTIONS-2022',
    regulator: 'CERT-In',
    title: 'Directions under section 70B(6) of the Information Technology Act, 2000',
    description:
      'Six-hour incident reporting to CERT-In and a rolling 180-day in-India log retention for all ICT systems — cross-sector, but unavoidable in BFSI.',
    sourceUrl: 'https://www.cert-in.org.in',
    verifiedOn: '2026-09-26',
    verifiedBy: 'Axiom Minds · Founder',
    notes:
      'Reference record; the Directions are public and clause refs are slugs pending verification.',
  },
];

/** The BFSI framework controls — topical slugs, deliberately NOT fake citations. */
export const BFSI_FRAMEWORK_CONTROLS: readonly SectorPackFrameworkControl[] = [
  // RBI-MD-ITG
  {
    frameworkCode: 'RBI-MD-ITG',
    ref: 'it-governance-oversight',
    heading: 'Board-approved IT governance and risk-management oversight',
  },
  {
    frameworkCode: 'RBI-MD-ITG',
    ref: 'it-infosec-controls',
    heading: 'Information security controls protecting financial-sector systems and data',
  },
  {
    frameworkCode: 'RBI-MD-ITG',
    ref: 'is-audit',
    heading: 'Periodic independent information systems audit',
  },
  // RBI-NBFC-AA
  {
    frameworkCode: 'RBI-NBFC-AA',
    ref: 'consent-artefact',
    heading:
      'Explicit, purpose-bound, revocable consent artefact before financial information is fetched or shared',
  },
  {
    frameworkCode: 'RBI-NBFC-AA',
    ref: 'aa-data-minimisation',
    heading:
      'Need-based collection; no storage of financial information beyond the consented purpose',
  },
  {
    frameworkCode: 'RBI-NBFC-AA',
    ref: 'aa-grievance',
    heading: 'Grievance redressal and data-access obligations for AA ecosystem participants',
  },
  // RBI-PAYMENT-DATA
  {
    frameworkCode: 'RBI-PAYMENT-DATA',
    ref: 'domestic-storage',
    heading: 'End-to-end payment system data stored only in India',
  },
  {
    frameworkCode: 'RBI-PAYMENT-DATA',
    ref: 'foreign-processing-restrictions',
    heading: 'Processing abroad, where permitted, is time-bound with erasure obligations',
  },
  // SEBI-CYBER-RESILIENCE
  {
    frameworkCode: 'SEBI-CYBER-RESILIENCE',
    ref: 'cyber-resilience-baseline',
    heading: 'Baseline cyber-security controls with defined governance and board oversight',
  },
  {
    frameworkCode: 'SEBI-CYBER-RESILIENCE',
    ref: 'monitoring-logging-vapt',
    heading: 'Continuous monitoring, audit logging and periodic VAPT of market-facing systems',
  },
  {
    frameworkCode: 'SEBI-CYBER-RESILIENCE',
    ref: 'incident-reporting-sebi',
    heading: 'Time-bound reporting of cyber incidents to SEBI and CERT-In',
  },
  // IRDAI-CYBER-SECURITY
  {
    frameworkCode: 'IRDAI-CYBER-SECURITY',
    ref: 'ics-baseline',
    heading: 'Information security baseline for systems holding policyholder data',
  },
  {
    frameworkCode: 'IRDAI-CYBER-SECURITY',
    ref: 'ics-access-logs',
    heading: 'Access control, privileged access management and audit logging',
  },
  {
    frameworkCode: 'IRDAI-CYBER-SECURITY',
    ref: 'ics-vendor-outsourcing',
    heading: 'Oversight of outsourced and cloud arrangements processing policyholder data',
  },
  // CERT-IN-DIRECTIONS-2022
  {
    frameworkCode: 'CERT-IN-DIRECTIONS-2022',
    ref: 'six-hour-incident-report',
    heading: 'Report specified cyber incidents to CERT-In within six hours of noticing',
  },
  {
    frameworkCode: 'CERT-IN-DIRECTIONS-2022',
    ref: 'logs-180-days-india',
    heading: 'Retain ICT system logs for a rolling 180 days, within India',
  },
];

/**
 * The BFSI cross-walks. Every mapping is `provenance: 'reference'` and at
 * most `partial` — none claims equivalence, because none has been verified
 * clause-by-clause against the regulator's printed text. The notes say what
 * each mapping does NOT claim.
 */
export const BFSI_CONTROL_MAPPINGS: readonly SectorPackMapping[] = [
  {
    frameworkCode: 'RBI-MD-ITG',
    ref: 'it-governance-oversight',
    controlId: 'DPDPA-GOV-001',
    mappingStrength: 'partial',
    provenance: 'reference',
    note: 'Both regimes demand board-level accountability — the MD for IT risk, DPDPA s.8 for personal-data fiduciary accountability. Overlap is real but the scopes differ; not an equivalence claim.',
  },
  {
    frameworkCode: 'RBI-MD-ITG',
    ref: 'it-infosec-controls',
    controlId: 'DPDPA-SEC-001',
    mappingStrength: 'partial',
    provenance: 'reference',
    note: 'The MD\'s baseline information-security controls satisfy much of DPDPA s.8(5) "reasonable security" for a supervised entity, but the MD adds regulator-specific duties DPDPA does not.',
  },
  {
    frameworkCode: 'RBI-MD-ITG',
    ref: 'is-audit',
    controlId: 'DPDPA-AUD-001',
    mappingStrength: 'indicative',
    provenance: 'reference',
    note: 'An IS audit evidences continuous compliance practice; the DPDPA control wants a timestamped evidence history. A starting point for the coverage map, not a claim.',
  },
  {
    frameworkCode: 'RBI-NBFC-AA',
    ref: 'consent-artefact',
    controlId: 'DPDPA-CNS-001',
    mappingStrength: 'partial',
    provenance: 'reference',
    note: 'The AA consent artefact is domain-specific and stricter in shape (structured, signed, revocable) than generic DPDPA consent; satisfying AA does not exhaust s.6, and vice versa.',
  },
  {
    frameworkCode: 'RBI-NBFC-AA',
    ref: 'consent-artefact',
    controlId: 'DPDPA-CNS-002',
    mappingStrength: 'indicative',
    provenance: 'reference',
    note: "The artefact's purpose declaration parallels the DPDPA notice's itemised purposes; the mapping needs engagement-level confirmation.",
  },
  {
    frameworkCode: 'RBI-NBFC-AA',
    ref: 'aa-data-minimisation',
    controlId: 'DPDPA-RTN-002',
    mappingStrength: 'indicative',
    provenance: 'reference',
    note: 'No-storage-beyond-the-consented-purpose parallels erasure on purpose-end. Directionally aligned; the clocks and scope differ.',
  },
  {
    frameworkCode: 'RBI-NBFC-AA',
    ref: 'aa-grievance',
    controlId: 'DPDPA-DAT-003',
    mappingStrength: 'indicative',
    provenance: 'reference',
    note: 'AA grievance duties overlap the DPDPA grievance-redressal mechanism for fiduciaries in the AA ecosystem.',
  },
  {
    frameworkCode: 'RBI-PAYMENT-DATA',
    ref: 'domestic-storage',
    controlId: 'DPDPA-XBR-001',
    mappingStrength: 'partial',
    provenance: 'reference',
    note: 'Both restrict cross-border flows, but the RBI directive localises payment data outright — strictly stricter than the DPDPA blacklist model. The overlap is real; the obligations are not the same.',
  },
  {
    frameworkCode: 'RBI-PAYMENT-DATA',
    ref: 'foreign-processing-restrictions',
    controlId: 'DPDPA-XBR-002',
    mappingStrength: 'indicative',
    provenance: 'reference',
    note: 'Documenting the legal basis for a transfer parallels documenting the time-bound foreign-processing window; the mapping informs the coverage map only.',
  },
  {
    frameworkCode: 'SEBI-CYBER-RESILIENCE',
    ref: 'cyber-resilience-baseline',
    controlId: 'DPDPA-SEC-001',
    mappingStrength: 'partial',
    provenance: 'reference',
    note: 'Baseline cyber controls overlap "reasonable security safeguards" for SEBI-regulated entities; the framework adds market-integrity duties outside DPDPA scope.',
  },
  {
    frameworkCode: 'SEBI-CYBER-RESILIENCE',
    ref: 'monitoring-logging-vapt',
    controlId: 'DPDPA-SEC-003',
    mappingStrength: 'partial',
    provenance: 'reference',
    note: 'Framework monitoring/logging duties satisfy much of the DPDPA audit-log control for market-facing systems; scope and retention specifics differ.',
  },
  {
    frameworkCode: 'SEBI-CYBER-RESILIENCE',
    ref: 'monitoring-logging-vapt',
    controlId: 'DPDPA-SEC-004',
    mappingStrength: 'indicative',
    provenance: 'reference',
    note: 'Periodic VAPT appears in both; cadence and scoping must be confirmed per engagement before any stronger label.',
  },
  {
    frameworkCode: 'SEBI-CYBER-RESILIENCE',
    ref: 'incident-reporting-sebi',
    controlId: 'DPDPA-BRCH-001',
    mappingStrength: 'partial',
    provenance: 'reference',
    note: 'Both are time-bound breach/incident intimation duties with DIFFERENT recipients and clocks (SEBI/CERT-In vs the Data Protection Board). One report does not substitute for the other.',
  },
  {
    frameworkCode: 'IRDAI-CYBER-SECURITY',
    ref: 'ics-baseline',
    controlId: 'DPDPA-SEC-001',
    mappingStrength: 'partial',
    provenance: 'reference',
    note: 'The insurer information-security baseline overlaps reasonable security for policyholder data; the guideline edition in force must be confirmed per engagement.',
  },
  {
    frameworkCode: 'IRDAI-CYBER-SECURITY',
    ref: 'ics-access-logs',
    controlId: 'DPDPA-SEC-002',
    mappingStrength: 'indicative',
    provenance: 'reference',
    note: 'Privileged access management overlaps DPDPA least-privilege access; the mapping informs, it does not equate.',
  },
  {
    frameworkCode: 'IRDAI-CYBER-SECURITY',
    ref: 'ics-vendor-outsourcing',
    controlId: 'DPDPA-GOV-003',
    mappingStrength: 'indicative',
    provenance: 'reference',
    note: 'Outsourcing oversight overlaps the DPDPA processor-agreement control; the DPA remains a distinct statutory requirement.',
  },
  {
    frameworkCode: 'CERT-IN-DIRECTIONS-2022',
    ref: 'six-hour-incident-report',
    controlId: 'DPDPA-BRCH-001',
    mappingStrength: 'partial',
    provenance: 'reference',
    note: 'The 6-hour CERT-In clock is stricter than and separate from the DPB intimation duty — different authority, different trigger. Never present one as satisfying the other.',
  },
  {
    frameworkCode: 'CERT-IN-DIRECTIONS-2022',
    ref: 'logs-180-days-india',
    controlId: 'DPDPA-SEC-003',
    mappingStrength: 'partial',
    provenance: 'reference',
    note: 'The Directions mandate a rolling 180-day in-India log retention that exceeds what the DPDPA audit-log control alone requires.',
  },
  {
    frameworkCode: 'CERT-IN-DIRECTIONS-2022',
    ref: 'logs-180-days-india',
    controlId: 'DPDPA-RTN-001',
    mappingStrength: 'indicative',
    provenance: 'reference',
    note: 'Log-retention schedules must be reconciled so the CERT-In minimum and DPDPA erasure duties do not collide in the retention register.',
  },
];

/**
 * Sector pack #1: BFSI (operator decision recorded 2026-09-26).
 * The control subset is exactly the union of the mapped DPDPA controls.
 */
export const BFSI_SECTOR_PACK: SectorPack = {
  code: 'BFSI-1',
  name: 'BFSI sector pack #1 — banking, financial services and insurance',
  sector: 'BFSI',
  description:
    'Overlay of the plan-named financial-sector regulators (RBI, SEBI, IRDAI) plus CERT-In onto the DPDPA control set, per M4.2/M4.8. Pack #1 per the operator decision of 2026-09-26 (pack order BFSI → Healthcare → Tech/E-commerce).',
  frameworkCodes: [
    'RBI-MD-ITG',
    'RBI-NBFC-AA',
    'RBI-PAYMENT-DATA',
    'SEBI-CYBER-RESILIENCE',
    'IRDAI-CYBER-SECURITY',
    'CERT-IN-DIRECTIONS-2022',
  ],
  controlIds: [...new Set(BFSI_CONTROL_MAPPINGS.map((m) => m.controlId))].sort(),
  evidenceRequirements: [
    {
      requirement:
        'Regulator-grade IS audit or CERT-In-empanelled auditor summary covering the assessment window',
      evidenceType: 'report',
    },
    {
      requirement:
        'Board or audit-committee minutes evidencing IT and privacy governance oversight',
      evidenceType: 'document',
    },
    {
      requirement: 'Sample consent artefacts (AA ecosystem) reconciled against the consent ledger',
      evidenceType: 'document',
    },
    {
      requirement:
        'Incident register showing regulator intimation timelines (CERT-In 6-hour clock; DPB intimation) kept distinct',
      evidenceType: 'log',
    },
  ],
  remediationPatterns: ['policy', 'config', 'vendor-risk', 'breach-process', 'review', 'reporting'],
  provenance: 'reference',
  basis:
    "Reference pack: derived from the regulators' public materials, with topical framework-control slugs and mapping strengths capped at partial. No mapping claims equivalence, and nothing is vendor-verified — that requires client tenants.",
};

// ─── Validation ─────────────────────────────────────────────────────────

const CONTROL_IDS = new Set(controls.map((c) => c.id));

const FRAMEWORK_CODES = new Set(BFSI_FRAMEWORKS.map((f) => f.code));

const FRAMEWORK_CONTROL_KEYS = new Set(
  BFSI_FRAMEWORK_CONTROLS.map((fc) => `${fc.frameworkCode}::${fc.ref}`),
);

/**
 * Validates the BFSI pack's internal references against the control library.
 * Returns the list of violations; an empty list means the pack is coherent.
 */
export function validateSectorPacks(): string[] {
  const errors: string[] = [];

  for (const f of BFSI_FRAMEWORKS) {
    const parsed = OverlayRegulatorSchema.safeParse(f.regulator);
    if (!parsed.success) errors.push(`Framework ${f.code}: unknown regulator ${f.regulator}`);
    if (!f.sourceUrl.startsWith('https://')) {
      errors.push(`Framework ${f.code}: sourceUrl must be https`);
    }
  }

  for (const fc of BFSI_FRAMEWORK_CONTROLS) {
    if (!FRAMEWORK_CODES.has(fc.frameworkCode)) {
      errors.push(`Framework control ${fc.frameworkCode}::${fc.ref}: unknown framework`);
    }
  }

  for (const m of BFSI_CONTROL_MAPPINGS) {
    if (!MappingStrengthSchema.safeParse(m.mappingStrength).success) {
      errors.push(`Mapping ${m.controlId}<-${m.frameworkCode}::${m.ref}: invalid strength`);
    }
    if (!MappingProvenanceSchema.safeParse(m.provenance).success) {
      errors.push(`Mapping ${m.controlId}<-${m.frameworkCode}::${m.ref}: invalid provenance`);
    }
    // An equivalence claim is a verified claim: a mapping derived from the
    // regulator's public text alone may be partial or indicative, never
    // equivalent. Mirrors the record_control_mapping gate in migration 0070.
    if (m.mappingStrength === 'equivalent' && m.provenance === 'reference') {
      errors.push(
        `Mapping ${m.controlId}<-${m.frameworkCode}::${m.ref}: equivalent requires verified provenance`,
      );
    }
    if (!CONTROL_IDS.has(m.controlId)) {
      errors.push(`Mapping ${m.controlId}<-${m.frameworkCode}::${m.ref}: unknown control id`);
    }
    const key = `${m.frameworkCode}::${m.ref}`;
    if (!FRAMEWORK_CONTROL_KEYS.has(key)) {
      errors.push(`Mapping ${m.controlId}<-${key}: unknown framework control`);
    }
  }

  for (const id of BFSI_SECTOR_PACK.controlIds) {
    if (!CONTROL_IDS.has(id)) {
      errors.push(`Pack ${BFSI_SECTOR_PACK.code}: control ${id} is not in the library`);
    }
  }
  for (const code of BFSI_SECTOR_PACK.frameworkCodes) {
    if (!FRAMEWORK_CODES.has(code)) {
      errors.push(`Pack ${BFSI_SECTOR_PACK.code}: unknown framework ${code}`);
    }
  }
  const mappedControls = new Set(BFSI_CONTROL_MAPPINGS.map((m) => m.controlId));
  for (const id of BFSI_SECTOR_PACK.controlIds) {
    if (!mappedControls.has(id)) {
      errors.push(`Pack ${BFSI_SECTOR_PACK.code}: control ${id} has no overlay mapping`);
    }
  }

  return errors;
}

// Fail fast on import, matching seed.ts's auto-validation convention.
const packValidation = validateSectorPacks();
if (packValidation.length > 0) {
  // eslint-disable-next-line no-console
  console.error('Sector pack validation failed:', packValidation);
  throw new Error('Sector pack invariants violated');
}
