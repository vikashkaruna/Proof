import { z } from 'zod';
import { controls } from './controls';

/**
 * Axiom Proof — Sector packs and multi-regulator mappings (W7.3/W7.4)
 *
 * M4.2 (multi-regulator control reuse): the DPDPA control set gains
 * cross-walks onto the regulators the plan names — RBI, SEBI, IRDAI and
 * CERT-In, plus Healthcare (NHA, MoHFW) and Tech/E-commerce (MeitY, CCPA) —
 * so one sealed evidence artifact can satisfy N controls across M frameworks.
 *
 * M4.8 (sectoral packs): a pack is a control subset + overlay mappings +
 * sector-specific evidence requirements + remediation patterns.
 * Pack order per operator decision (2026-09-26):
 *   1. BFSI (BFSI-1)
 *   2. Healthcare (IN-HEALTHCARE-2024)
 *   3. Tech/E-commerce (IN-TECH-2024)
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
 *                regulator-side verification; no reference mapping claims it)
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

/** The overlay regulators named for multi-regulator reuse (M4.2, W7.3/W7.4). */
export const OverlayRegulatorSchema = z.enum([
  'RBI',
  'SEBI',
  'IRDAI',
  'CERT-In',
  'NHA',
  'MoHFW',
  'MeitY',
  'CCPA',
]);
export type OverlayRegulator = z.infer<typeof OverlayRegulatorSchema>;

/** Pack sectors named by the plan (M4.8) and the 2026-09-26 operator decision. */
export const SectorPackSectorSchema = z.enum(['BFSI', 'Healthcare', 'Tech/E-commerce']);
export type SectorPackSector = z.infer<typeof SectorPackSectorSchema>;

export interface SectorPackFramework {
  /** Stable short code, e.g. 'RBI-MD-ITG', 'NHA-ABDM-HDMP'. */
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
  evidenceType:
    | 'document'
    | 'config'
    | 'screenshot'
    | 'log'
    | 'attestation'
    | 'interview'
    | 'inventory'
    | 'report';
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

// ─────────────────────────────────────────────────────────────────────────────
// 1. BFSI FRAMEWORKS & CONTROLS (Pack #1 · BFSI-1)
// ─────────────────────────────────────────────────────────────────────────────

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
      'Six-hour incident reporting to CERT-In and a rolling 180-day in-India log retention for all ICT systems — cross-sector baseline.',
    sourceUrl: 'https://www.cert-in.org.in',
    verifiedOn: '2026-09-26',
    verifiedBy: 'Axiom Minds · Founder',
    notes:
      'Reference record; the Directions are public and clause refs are slugs pending verification.',
  },
];

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

export const BFSI_CONTROL_MAPPINGS: readonly SectorPackMapping[] = [
  {
    frameworkCode: 'RBI-MD-ITG',
    ref: 'it-governance-oversight',
    controlId: 'DPDPA-GOV-001',
    mappingStrength: 'partial',
    provenance: 'reference',
    note: 'Both regimes demand board-level accountability — the MD for IT risk, DPDPA s.8 for personal-data fiduciary accountability. Overlap is real but scopes differ; not an equivalence claim.',
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

// ─────────────────────────────────────────────────────────────────────────────
// 2. HEALTHCARE FRAMEWORKS & CONTROLS (Pack #2 · IN-HEALTHCARE-2024)
// ─────────────────────────────────────────────────────────────────────────────

export const HEALTHCARE_FRAMEWORKS: readonly SectorPackFramework[] = [
  {
    code: 'NHA-ABDM-HDMP',
    regulator: 'NHA',
    title: 'Ayushman Bharat Digital Mission — Health Data Management Policy',
    description:
      'National Health Authority policy governing the processing of digital health records, electronic consent management frameworks, and patient data rights across the ABDM ecosystem.',
    sourceUrl: 'https://abdm.gov.in',
    verifiedOn: '2026-09-27',
    verifiedBy: 'Axiom Minds · Founder',
    notes:
      'Reference record. Covers ABDM consent manager integration, data minimisation, and patient data rights. Paragraph-level citations pending formal audit.',
  },
  {
    code: 'MOHFW-EHR-STANDARDS',
    regulator: 'MoHFW',
    title: 'Electronic Health Record (EHR) Standards for India',
    description:
      'Ministry of Health and Family Welfare guidelines establishing technical and security baselines for electronic clinical data, role-based access control, cryptographic protection, and audit logs.',
    sourceUrl: 'https://main.mohfw.gov.in',
    verifiedOn: '2026-09-27',
    verifiedBy: 'Axiom Minds · Founder',
    notes:
      'Reference record; clinical IT system security baseline. Specific guideline edition must be confirmed per clinical establishment engagement.',
  },
];

export const HEALTHCARE_FRAMEWORK_CONTROLS: readonly SectorPackFrameworkControl[] = [
  // NHA-ABDM-HDMP
  {
    frameworkCode: 'NHA-ABDM-HDMP',
    ref: 'abdm-consent-manager',
    heading: 'Granular, informed electronic consent collected via registered consent managers',
  },
  {
    frameworkCode: 'NHA-ABDM-HDMP',
    ref: 'abdm-data-minimisation',
    heading:
      'Health data collection limited strictly to specified healthcare or diagnostic purpose',
  },
  {
    frameworkCode: 'NHA-ABDM-HDMP',
    ref: 'abdm-patient-rights',
    heading:
      'Patient rights to access, summary of processing, rectification and consent withdrawal',
  },
  {
    frameworkCode: 'NHA-ABDM-HDMP',
    ref: 'abdm-anonymisation-research',
    heading: 'Mandatory anonymisation and de-identification standards for health research data',
  },
  // MOHFW-EHR-STANDARDS
  {
    frameworkCode: 'MOHFW-EHR-STANDARDS',
    ref: 'ehr-access-control',
    heading:
      'Strict role-based access control and multi-factor authentication for clinical systems',
  },
  {
    frameworkCode: 'MOHFW-EHR-STANDARDS',
    ref: 'ehr-audit-logging',
    heading: 'Tamper-evident access and alteration logging for protected health information',
  },
  {
    frameworkCode: 'MOHFW-EHR-STANDARDS',
    ref: 'ehr-storage-encryption',
    heading: 'Cryptographic protection for clinical and diagnostic data at rest and in transit',
  },
  {
    frameworkCode: 'MOHFW-EHR-STANDARDS',
    ref: 'ehr-retention-disposal',
    heading: 'Defined retention registers and secure cryptographic disposal of health records',
  },
];

export const HEALTHCARE_CONTROL_MAPPINGS: readonly SectorPackMapping[] = [
  {
    frameworkCode: 'NHA-ABDM-HDMP',
    ref: 'abdm-consent-manager',
    controlId: 'DPDPA-CNS-001',
    mappingStrength: 'partial',
    provenance: 'reference',
    note: 'ABDM electronic consent manager architecture provides structured patient consent; overlaps DPDPA s.6 consent mechanism with healthcare-specific artifacts.',
  },
  {
    frameworkCode: 'NHA-ABDM-HDMP',
    ref: 'abdm-consent-manager',
    controlId: 'DPDPA-CNS-002',
    mappingStrength: 'indicative',
    provenance: 'reference',
    note: 'ABDM purpose specification parallels DPDPA s.5 itemised notice for health data collection.',
  },
  {
    frameworkCode: 'NHA-ABDM-HDMP',
    ref: 'abdm-data-minimisation',
    controlId: 'DPDPA-RTN-002',
    mappingStrength: 'indicative',
    provenance: 'reference',
    note: 'Purpose limitation in health data parallels DPDPA purpose completion erasure; clinical retention rules must be reconciled.',
  },
  {
    frameworkCode: 'NHA-ABDM-HDMP',
    ref: 'abdm-patient-rights',
    controlId: 'DPDPA-DAT-001',
    mappingStrength: 'partial',
    provenance: 'reference',
    note: 'Patient rights under ABDM overlap DPDPA s.11 right to information about processed health data.',
  },
  {
    frameworkCode: 'NHA-ABDM-HDMP',
    ref: 'abdm-patient-rights',
    controlId: 'DPDPA-DAT-002',
    mappingStrength: 'indicative',
    provenance: 'reference',
    note: 'Clinical correction and rectification rights inform DPDPA s.12 correction/erasure implementation.',
  },
  {
    frameworkCode: 'NHA-ABDM-HDMP',
    ref: 'abdm-patient-rights',
    controlId: 'DPDPA-DAT-003',
    mappingStrength: 'indicative',
    provenance: 'reference',
    note: 'ABDM patient grievance redressal parallels DPDPA s.13 grievance redressal officer mechanism.',
  },
  {
    frameworkCode: 'NHA-ABDM-HDMP',
    ref: 'abdm-anonymisation-research',
    controlId: 'DPDPA-DPF-001',
    mappingStrength: 'indicative',
    provenance: 'reference',
    note: 'Anonymisation standards for medical research inform privacy-by-design architecture under DPDPA s.8(4).',
  },
  {
    frameworkCode: 'MOHFW-EHR-STANDARDS',
    ref: 'ehr-access-control',
    controlId: 'DPDPA-SEC-002',
    mappingStrength: 'partial',
    provenance: 'reference',
    note: 'EHR role-based access control and clinical least privilege satisfy core aspects of DPDPA s.8(5) access controls.',
  },
  {
    frameworkCode: 'MOHFW-EHR-STANDARDS',
    ref: 'ehr-audit-logging',
    controlId: 'DPDPA-SEC-003',
    mappingStrength: 'partial',
    provenance: 'reference',
    note: 'Audit logging for EHR modifications directly supports DPDPA s.8(5) audit log maintenance and tamper protection.',
  },
  {
    frameworkCode: 'MOHFW-EHR-STANDARDS',
    ref: 'ehr-storage-encryption',
    controlId: 'DPDPA-SEC-001',
    mappingStrength: 'partial',
    provenance: 'reference',
    note: 'EHR cryptographic standards for data at rest and in transit align with DPDPA reasonable security safeguards.',
  },
  {
    frameworkCode: 'MOHFW-EHR-STANDARDS',
    ref: 'ehr-retention-disposal',
    controlId: 'DPDPA-RTN-001',
    mappingStrength: 'indicative',
    provenance: 'reference',
    note: 'Clinical retention periods under EHR standards must be codified alongside DPDPA retention schedules.',
  },
  {
    frameworkCode: 'CERT-IN-DIRECTIONS-2022',
    ref: 'six-hour-incident-report',
    controlId: 'DPDPA-BRCH-001',
    mappingStrength: 'partial',
    provenance: 'reference',
    note: 'CERT-In 6-hour reporting clock applies to healthcare critical systems; distinct statutory duty from DPB breach intimation.',
  },
  {
    frameworkCode: 'CERT-IN-DIRECTIONS-2022',
    ref: 'logs-180-days-india',
    controlId: 'DPDPA-SEC-003',
    mappingStrength: 'partial',
    provenance: 'reference',
    note: 'CERT-In 180-day in-India logging mandate applies to hospital networks and patient portal infrastructure.',
  },
];

export const HEALTHCARE_SECTOR_PACK: SectorPack = {
  code: 'IN-HEALTHCARE-2024',
  name: 'Healthcare sector pack #2 — ABDM, EHR and health data protection',
  sector: 'Healthcare',
  description:
    'Overlay of National Health Authority (NHA) ABDM Health Data Management Policy, MoHFW Electronic Health Record Standards, and CERT-In Directions onto the DPDPA control set (M4.2/M4.8). Pack #2 per operator decision of 2026-09-26.',
  frameworkCodes: ['NHA-ABDM-HDMP', 'MOHFW-EHR-STANDARDS', 'CERT-IN-DIRECTIONS-2022'],
  controlIds: [...new Set(HEALTHCARE_CONTROL_MAPPINGS.map((m) => m.controlId))].sort(),
  evidenceRequirements: [
    {
      requirement:
        'Clinical information system access audit reports showing role-based access control and MFA enforcement',
      evidenceType: 'report',
    },
    {
      requirement: 'ABDM ecosystem registration and consent manager integration certificate / logs',
      evidenceType: 'attestation',
    },
    {
      requirement:
        'Data protection and patient privacy policy approved by hospital board / clinical director',
      evidenceType: 'document',
    },
    {
      requirement: 'Health data encryption configuration and key management policies',
      evidenceType: 'config',
    },
    {
      requirement: 'Incident register tracking clinical breach intimations to CERT-In and DPB',
      evidenceType: 'log',
    },
  ],
  remediationPatterns: [
    'policy',
    'consent',
    'config',
    'data-masking',
    'dpo-appointment',
    'breach-process',
    'review',
    'reporting',
  ],
  provenance: 'reference',
  basis:
    'Reference pack: derived from NHA ABDM Health Data Management Policy, MoHFW EHR Standards (2016), and CERT-In Directions (2022). Mapping strengths capped at partial; no equivalence claim without clinical environment verification.',
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. TECH / E-COMMERCE FRAMEWORKS & CONTROLS (Pack #3 · IN-TECH-2024)
// ─────────────────────────────────────────────────────────────────────────────

export const TECH_FRAMEWORKS: readonly SectorPackFramework[] = [
  {
    code: 'MEITY-INTERMEDIARY-2021',
    regulator: 'MeitY',
    title:
      'Information Technology (Intermediary Guidelines and Digital Media Ethics Code) Rules, 2021',
    description:
      'MeitY rules governing due diligence, user privacy notices, resident grievance officers, and data preservation for online platforms, social media, and digital intermediaries.',
    sourceUrl: 'https://www.meity.gov.in',
    verifiedOn: '2026-09-27',
    verifiedBy: 'Axiom Minds · Founder',
    notes:
      'Reference record. Due diligence, grievance officer timelines, and lawful disclosure data preservation. Circular verification pending.',
  },
  {
    code: 'CCPA-ECOMMERCE-2020',
    regulator: 'CCPA',
    title: 'Consumer Protection (E-Commerce) Rules, 2020',
    description:
      'Rules under the Consumer Protection Act for marketplace and inventory e-commerce entities on explicit opt-in consent, grievance redressal, and seller data transparency.',
    sourceUrl: 'https://consumeraffairs.nic.in',
    verifiedOn: '2026-09-27',
    verifiedBy: 'Axiom Minds · Founder',
    notes:
      'Reference record; prohibition of pre-ticked consent boxes and mandatory grievance tracking.',
  },
  {
    code: 'MEITY-SPDI-2011',
    regulator: 'MeitY',
    title:
      'Information Technology (Reasonable Security Practices and Sensitive Personal Data) Rules, 2011',
    description:
      'Baseline SPDI rules on privacy policy publication, purpose disclosure, third-party disclosure consent, and ISO/IEC 27001 or equivalent security practice standards.',
    sourceUrl: 'https://www.meity.gov.in',
    verifiedOn: '2026-09-27',
    verifiedBy: 'Axiom Minds · Founder',
    notes:
      'Reference record; historical SPDI baseline continuing to inform reasonable security practice.',
  },
];

export const TECH_FRAMEWORK_CONTROLS: readonly SectorPackFrameworkControl[] = [
  // MEITY-INTERMEDIARY-2021
  {
    frameworkCode: 'MEITY-INTERMEDIARY-2021',
    ref: 'intermediary-privacy-notice',
    heading:
      'Prominently publish terms of use, privacy policy and user agreement detailing information collection',
  },
  {
    frameworkCode: 'MEITY-INTERMEDIARY-2021',
    ref: 'intermediary-grievance-officer',
    heading:
      'Appoint resident Grievance Officer; acknowledge complaints within 24h and resolve within 15 days',
  },
  {
    frameworkCode: 'MEITY-INTERMEDIARY-2021',
    ref: 'intermediary-data-retention',
    heading:
      'Preserve user registration information and access logs for 180 days after account deletion/cancellation',
  },
  {
    frameworkCode: 'MEITY-INTERMEDIARY-2021',
    ref: 'intermediary-takedown-reporting',
    heading: 'Time-bound compliance and reporting for lawful agency requests and court orders',
  },
  // CCPA-ECOMMERCE-2020
  {
    frameworkCode: 'CCPA-ECOMMERCE-2020',
    ref: 'ecommerce-explicit-consent',
    heading:
      'Explicit opt-in consent for purchase terms and data capture; pre-ticked checkboxes strictly prohibited',
  },
  {
    frameworkCode: 'CCPA-ECOMMERCE-2020',
    ref: 'ecommerce-grievance-mechanism',
    heading:
      'Consumer grievance redressal mechanism with unique ticket tracking and time-bound resolution',
  },
  {
    frameworkCode: 'CCPA-ECOMMERCE-2020',
    ref: 'ecommerce-seller-transparency',
    heading:
      'Disclosures regarding seller identity, data sharing, and cross-border vendor arrangements',
  },
  // MEITY-SPDI-2011
  {
    frameworkCode: 'MEITY-SPDI-2011',
    ref: 'spdi-privacy-policy',
    heading:
      'Comprehensive documented privacy policy for collection, handling and storage of personal information',
  },
  {
    frameworkCode: 'MEITY-SPDI-2011',
    ref: 'spdi-security-practices',
    heading:
      'Implementation of reasonable security practices and procedures (ISO/IEC 27001 or equivalent standard)',
  },
  {
    frameworkCode: 'MEITY-SPDI-2011',
    ref: 'spdi-disclosure-third-party',
    heading:
      'Prior permission requirement before disclosing sensitive personal data to third parties',
  },
];

export const TECH_CONTROL_MAPPINGS: readonly SectorPackMapping[] = [
  {
    frameworkCode: 'MEITY-INTERMEDIARY-2021',
    ref: 'intermediary-privacy-notice',
    controlId: 'DPDPA-CNS-002',
    mappingStrength: 'partial',
    provenance: 'reference',
    note: 'Intermediary privacy notice requirements overlap DPDPA s.5 itemised notice obligations for digital platforms.',
  },
  {
    frameworkCode: 'MEITY-INTERMEDIARY-2021',
    ref: 'intermediary-grievance-officer',
    controlId: 'DPDPA-DAT-003',
    mappingStrength: 'partial',
    provenance: 'reference',
    note: 'Resident grievance officer requirement under Intermediary Rules satisfies core organizational duties of DPDPA s.13.',
  },
  {
    frameworkCode: 'MEITY-INTERMEDIARY-2021',
    ref: 'intermediary-data-retention',
    controlId: 'DPDPA-RTN-001',
    mappingStrength: 'indicative',
    provenance: 'reference',
    note: '180-day post-deletion retention duty must be harmonized with DPDPA s.8(7) purpose-completion erasure in retention register.',
  },
  {
    frameworkCode: 'MEITY-INTERMEDIARY-2021',
    ref: 'intermediary-takedown-reporting',
    controlId: 'DPDPA-GOV-001',
    mappingStrength: 'indicative',
    provenance: 'reference',
    note: 'Legal compliance and disclosure workflows overlap broader DPDPA data fiduciary governance structure.',
  },
  {
    frameworkCode: 'CCPA-ECOMMERCE-2020',
    ref: 'ecommerce-explicit-consent',
    controlId: 'DPDPA-CNS-001',
    mappingStrength: 'partial',
    provenance: 'reference',
    note: 'Prohibition of pre-ticked consent checkboxes directly aligns with DPDPA s.6 affirmative, clear consent requirements.',
  },
  {
    frameworkCode: 'CCPA-ECOMMERCE-2020',
    ref: 'ecommerce-grievance-mechanism',
    controlId: 'DPDPA-DAT-003',
    mappingStrength: 'indicative',
    provenance: 'reference',
    note: 'E-commerce consumer grievance ticket tracking overlaps DPDPA grievance redressal mechanism.',
  },
  {
    frameworkCode: 'CCPA-ECOMMERCE-2020',
    ref: 'ecommerce-seller-transparency',
    controlId: 'DPDPA-GOV-003',
    mappingStrength: 'indicative',
    provenance: 'reference',
    note: 'Marketplace seller and vendor data sharing oversight parallels DPDPA processor agreement controls.',
  },
  {
    frameworkCode: 'MEITY-SPDI-2011',
    ref: 'spdi-privacy-policy',
    controlId: 'DPDPA-GOV-001',
    mappingStrength: 'indicative',
    provenance: 'reference',
    note: 'SPDI privacy policy mandate overlaps DPDPA general accountability and policy governance.',
  },
  {
    frameworkCode: 'MEITY-SPDI-2011',
    ref: 'spdi-security-practices',
    controlId: 'DPDPA-SEC-001',
    mappingStrength: 'partial',
    provenance: 'reference',
    note: 'SPDI reasonable security practices standard (ISO 27001) aligns with DPDPA s.8(5) reasonable security safeguards.',
  },
  {
    frameworkCode: 'MEITY-SPDI-2011',
    ref: 'spdi-disclosure-third-party',
    controlId: 'DPDPA-CNS-003',
    mappingStrength: 'partial',
    provenance: 'reference',
    note: 'SPDI prior permission for third-party disclosure overlaps DPDPA specified purpose consent limitation.',
  },
  {
    frameworkCode: 'CERT-IN-DIRECTIONS-2022',
    ref: 'six-hour-incident-report',
    controlId: 'DPDPA-BRCH-001',
    mappingStrength: 'partial',
    provenance: 'reference',
    note: 'CERT-In 6-hour incident report applies to tech intermediaries and cloud services; distinct statutory recipient from DPB.',
  },
  {
    frameworkCode: 'CERT-IN-DIRECTIONS-2022',
    ref: 'logs-180-days-india',
    controlId: 'DPDPA-SEC-003',
    mappingStrength: 'partial',
    provenance: 'reference',
    note: 'CERT-In 180-day log maintenance in India applies to web apps, cloud servers and API gateways.',
  },
];

export const TECH_SECTOR_PACK: SectorPack = {
  code: 'IN-TECH-2024',
  name: 'Tech and E-commerce sector pack #3 — Intermediary rules, SPDI and consumer data protection',
  sector: 'Tech/E-commerce',
  description:
    'Overlay of MeitY IT Intermediary Guidelines (2021) and SPDI Rules (2011), CCPA Consumer Protection (E-Commerce) Rules (2020), and CERT-In Directions onto the DPDPA control set (M4.2/M4.8). Pack #3 per operator decision of 2026-09-26.',
  frameworkCodes: [
    'MEITY-INTERMEDIARY-2021',
    'CCPA-ECOMMERCE-2020',
    'MEITY-SPDI-2011',
    'CERT-IN-DIRECTIONS-2022',
  ],
  controlIds: [...new Set(TECH_CONTROL_MAPPINGS.map((m) => m.controlId))].sort(),
  evidenceRequirements: [
    {
      requirement:
        'Architecture and infrastructure security review report (ISO/IEC 27001 or SOC 2 Type II)',
      evidenceType: 'report',
    },
    {
      requirement:
        'Privacy policy and user terms published on web/mobile apps with version history',
      evidenceType: 'document',
    },
    {
      requirement:
        'Consent capture audit log verifying un-ticked default checkboxes and timestamped opt-in',
      evidenceType: 'log',
    },
    {
      requirement:
        'Grievance portal ticket log showing acknowledgement under 24 hours and resolution workflows',
      evidenceType: 'log',
    },
    {
      requirement:
        'Data retention configuration specifying 180-day audit log retention and automated erasure triggers',
      evidenceType: 'config',
    },
  ],
  remediationPatterns: [
    'policy',
    'consent',
    'config',
    'vendor-risk',
    'data-deletion',
    'review',
    'reporting',
  ],
  provenance: 'reference',
  basis:
    'Reference pack: derived from MeitY Intermediary Guidelines (2021), SPDI Rules (2011), CCPA E-Commerce Rules (2020), and CERT-In Directions (2022). Mapping strengths capped at partial; no equivalence claim without client tenant verification.',
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. UNIFIED COLLECTIONS
// ─────────────────────────────────────────────────────────────────────────────

export const ALL_FRAMEWORKS: readonly SectorPackFramework[] = [
  ...BFSI_FRAMEWORKS,
  ...HEALTHCARE_FRAMEWORKS,
  ...TECH_FRAMEWORKS,
];

export const ALL_FRAMEWORK_CONTROLS: readonly SectorPackFrameworkControl[] = [
  ...BFSI_FRAMEWORK_CONTROLS,
  ...HEALTHCARE_FRAMEWORK_CONTROLS,
  ...TECH_FRAMEWORK_CONTROLS,
];

export const ALL_CONTROL_MAPPINGS: readonly SectorPackMapping[] = [
  ...BFSI_CONTROL_MAPPINGS,
  ...HEALTHCARE_CONTROL_MAPPINGS,
  ...TECH_CONTROL_MAPPINGS,
];

export const ALL_SECTOR_PACKS: readonly SectorPack[] = [
  BFSI_SECTOR_PACK,
  HEALTHCARE_SECTOR_PACK,
  TECH_SECTOR_PACK,
];

// ─── Validation ─────────────────────────────────────────────────────────────

const CONTROL_IDS = new Set(controls.map((c) => c.id));
const FRAMEWORK_CODES = new Set(ALL_FRAMEWORKS.map((f) => f.code));
const FRAMEWORK_CONTROL_KEYS = new Set(
  ALL_FRAMEWORK_CONTROLS.map((fc) => `${fc.frameworkCode}::${fc.ref}`),
);

/**
 * Validates all sector packs and multi-regulator mappings against library invariants.
 * Returns the list of violations; an empty list means all packs are coherent.
 */
export function validateSectorPacks(): string[] {
  const errors: string[] = [];

  for (const f of ALL_FRAMEWORKS) {
    const parsed = OverlayRegulatorSchema.safeParse(f.regulator);
    if (!parsed.success) errors.push(`Framework ${f.code}: unknown regulator ${f.regulator}`);
    if (!f.sourceUrl.startsWith('https://')) {
      errors.push(`Framework ${f.code}: sourceUrl must be https`);
    }
  }

  for (const fc of ALL_FRAMEWORK_CONTROLS) {
    if (!FRAMEWORK_CODES.has(fc.frameworkCode)) {
      errors.push(`Framework control ${fc.frameworkCode}::${fc.ref}: unknown framework`);
    }
  }

  for (const m of ALL_CONTROL_MAPPINGS) {
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

  for (const pack of ALL_SECTOR_PACKS) {
    if (!SectorPackSectorSchema.safeParse(pack.sector).success) {
      errors.push(`Pack ${pack.code}: invalid sector ${pack.sector}`);
    }
    for (const id of pack.controlIds) {
      if (!CONTROL_IDS.has(id)) {
        errors.push(`Pack ${pack.code}: control ${id} is not in the library`);
      }
    }
    for (const code of pack.frameworkCodes) {
      if (!FRAMEWORK_CODES.has(code)) {
        errors.push(`Pack ${pack.code}: unknown framework ${code}`);
      }
    }
    // Pack control subset must be covered by mappings for that pack's frameworks
    const packMappings = ALL_CONTROL_MAPPINGS.filter((m) =>
      pack.frameworkCodes.includes(m.frameworkCode),
    );
    const mappedControls = new Set(packMappings.map((m) => m.controlId));
    for (const id of pack.controlIds) {
      if (!mappedControls.has(id)) {
        errors.push(
          `Pack ${pack.code}: control ${id} has no overlay mapping in declared frameworks`,
        );
      }
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
