import type { ReadinessIndex } from '@axiom/types';

interface SectorProfile {
  benchmark: number;
  topRisks: string[];
  multiplier: number;
}

const SECTOR_PROFILES: Record<string, SectorProfile> = {
  BFSI: {
    benchmark: 76,
    topRisks: [
      'Unencrypted core customer financial identifiers stored in legacy databases (DPDPA-SEC-001)',
      'Missing 72-hour DPB breach notification workflow for fraud/leak incidents (DPDPA-BRCH-001)',
      'Cross-border financial transaction log transfers lacking adequacy safeguards (DPDPA-XBR-001)',
    ],
    multiplier: 2.2,
  },
  Healthcare: {
    benchmark: 72,
    topRisks: [
      'Processing sensitive diagnostic data without verifiable granular consent (DPDPA-CNS-001)',
      'Missing Data Processing Agreements with diagnostic lab and cloud vendors (DPDPA-GOV-003)',
      'Absence of regular Data Protection Impact Assessments (DPIAs) for patient portals (DPDPA-DPIA-001)',
    ],
    multiplier: 2.5,
  },
  'SaaS / Tech': {
    benchmark: 74,
    topRisks: [
      'Third-party analytics and AI model processors operating without signed DPAs (DPDPA-GOV-003)',
      'No automated mechanism for users to withdraw consent as easily as given (DPDPA-CNS-004)',
      'Uninventoried customer data stores in distributed microservice architectures (DPDPA-RCD-002)',
    ],
    multiplier: 1.8,
  },
  'E-commerce / D2C': {
    benchmark: 64,
    topRisks: [
      'Pre-ticked checkboxes and bundled marketing consents on checkout funnels (DPDPA-CNS-001)',
      'Targeted ads and behavioural tracking on minors without age-gating (DPDPA-CHI-001)',
      'Customer order address data retained indefinitely with no automated deletion policy (DPDPA-RCD-001)',
    ],
    multiplier: 1.6,
  },
  Manufacturing: {
    benchmark: 58,
    topRisks: [
      'Uninventoried legacy vendor databases holding contractor and staff PII (DPDPA-RCD-002)',
      'Absence of a formally published Grievance Redressal Officer (DPDPA-DAT-003)',
      'Lack of MFA on supervisory ERP and industrial telemetry credentials (DPDPA-SEC-001)',
    ],
    multiplier: 1.4,
  },
  'Education / EdTech': {
    benchmark: 66,
    topRisks: [
      'Mandatory Section 9 verifiable parental consent missing for students under 18 (DPDPA-CHI-001)',
      'Student behavioural profiling and tracking without lawful processing basis (DPDPA-CNS-001)',
      'Unencrypted student evaluation data stored on third-party cloud tools (DPDPA-SEC-001)',
    ],
    multiplier: 2.0,
  },
  Logistics: {
    benchmark: 62,
    topRisks: [
      'Live geolocation and contact telemetry shared with third-party delivery partners without DPAs (DPDPA-GOV-003)',
      'Driver and recipient KYC documents stored unencrypted on field devices (DPDPA-SEC-001)',
      'Inadequate breach incident response protocols for third-party courier APIs (DPDPA-BRCH-001)',
    ],
    multiplier: 1.5,
  },
  Hospitality: {
    benchmark: 61,
    topRisks: [
      'Unredacted government ID/passport photocopies retained beyond guest stay (DPDPA-RCD-001)',
      'Promotional communications sent without affirmative marketing opt-in (DPDPA-CNS-001)',
      'Property management system access lacking role-based MFA controls (DPDPA-SEC-001)',
    ],
    multiplier: 1.5,
  },
};

const DEFAULT_PROFILE: SectorProfile = {
  benchmark: 65,
  topRisks: [
    'Absence of written Record of Processing Activities (RoPA) across business units (DPDPA-RCD-001)',
    'Unencrypted customer data at rest in primary database instances (DPDPA-SEC-001)',
    'Missing publicly designated Data Protection Grievance Officer (DPDPA-DAT-003)',
  ],
  multiplier: 1.5,
};

/**
 * Computes the Quarterly Axiom Proof DPDPA Readiness Index.
 *
 * C-W0-7 provenance: the sector benchmarks, multipliers and top risks above are
 * Axiom editorial estimates, not measured peer data, and `percentileRank` is a
 * position derived from that estimate — not a percentile of real respondents.
 * Every surface must present them as indicative (`benchmarkBasis`).
 */
export function computeQuarterlyReadinessIndex(
  sector: string = 'Other',
  companyScore: number = 0,
): ReadinessIndex {
  const profile = SECTOR_PROFILES[sector] || DEFAULT_PROFILE;
  const benchmark = profile.benchmark;
  const score = Math.max(0, Math.min(100, Math.round(companyScore)));

  // Indicative standing (1-99) relative to the editorial benchmark, not real respondents
  let percentileRank: number;
  if (score >= benchmark) {
    const headroom = Math.max(1, 100 - benchmark);
    percentileRank = Math.min(99, Math.round(50 + ((score - benchmark) / headroom) * 48));
  } else {
    percentileRank = Math.max(5, Math.round((score / Math.max(1, benchmark)) * 48));
  }

  // Determine status
  let status: 'leading' | 'on_track' | 'lagging';
  if (score >= benchmark + 5) {
    status = 'leading';
  } else if (score >= benchmark - 12) {
    status = 'on_track';
  } else {
    status = 'lagging';
  }

  // Compute targeted quarterly progression roadmap
  const targetQ1 = Math.min(100, Math.max(score, Math.round(score + (100 - score) * 0.35)));
  const targetQ2 = Math.min(100, Math.max(targetQ1, Math.round(score + (100 - score) * 0.65)));
  const targetQ3 = Math.min(100, Math.max(targetQ2, Math.round(score + (100 - score) * 0.85)));
  const targetQ4 = 100;

  const quarterlyRoadmap = [
    {
      quarter: 'Q1 (Months 1–3)',
      targetScore: targetQ1,
      milestone:
        'Appoint Data Protection Grievance Officer, publish compliant privacy notice & complete RoPA.',
      statutoryDeadline: 'Immediate Baseline (Rule 3)',
    },
    {
      quarter: 'Q2 (Months 4–6)',
      targetScore: targetQ2,
      milestone:
        'Implement itemised multi-language consent capture, withdrawal flows & vendor DPAs.',
      statutoryDeadline: 'Vendor & Consent Gate',
    },
    {
      quarter: 'Q3 (Months 7–9)',
      targetScore: targetQ3,
      milestone:
        'Deploy automated 72-hour DPB breach workflow & enforce KMS-backed database encryption.',
      statutoryDeadline: 'Mandatory DPB Integration',
    },
    {
      quarter: 'Q4 (Months 10–12)',
      targetScore: targetQ4,
      milestone:
        'Full independent audit readiness pack, sealed cryptographic evidence ledger & Board sign-off.',
      statutoryDeadline: 'Statutory Enforcement',
    },
  ];

  return {
    sector: sector || 'Cross-Industry',
    companyScore: score,
    sectorBenchmarkScore: benchmark,
    percentileRank,
    status,
    exposureMultiplier: profile.multiplier,
    sectorTopRisks: profile.topRisks,
    quarterlyRoadmap,
    generatedAt: new Date().toISOString(),
    benchmarkBasis: 'editorial_estimate',
  };
}
