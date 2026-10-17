/**
 * Axiom Proof — Control Library v0.2.0 (CANDIDATE, not published)
 *
 * Derived from published 0.1.1 by deep copy. Exactly six controls are replaced,
 * each corrected against official primary text recorded in `legal-registry.ts`:
 * CNS-003, DAT-003, DAT-006, BRCH-002, RCD-001 and RCD-003. Every other control
 * is carried over unchanged except for its library version. Published 0.1.1 is
 * never mutated; this module only reads it.
 *
 * MINOR, not PATCH: the corrections change what four controls test and how two
 * questions are scoped, so 0.2.0 results are NOT comparable with 0.1.1 for the
 * corrected controls. A 0.1.1 assessment stays valid against 0.1.1 and must be
 * verified against 0.1.1, never re-read against this version.
 */
import type { Control } from '../../types';
import { controls as controls_0_1_1, LIBRARY_PUBLISHER } from '../../controls';
import { COMMENCEMENT } from '../../regulatory-baseline';

export const LIBRARY_VERSION_0_2_0 = '0.2.0';
/** Authoring date of the candidate; confirm at publication. */
export const LIBRARY_PUBLISHED_AT_0_2_0 = '2026-10-17';
export const LIBRARY_PUBLISHER_0_2_0 = LIBRARY_PUBLISHER;
/** The 0.2.0 baseline adds the Act commencement notification G.S.R. 843(E). */
export const LIBRARY_BASELINE_0_2_0 = 'IN-DPDP@2026-10-17';
export const LIBRARY_DEFAULT_EFFECTIVE_FROM_0_2_0 = COMMENCEMENT.eighteenMonths;

export const LIBRARY_CHANGELOG_0_2_0 = `0.2.0 — LEGAL CONTENT CORRECTION (MINOR; corrected controls are NOT comparable with 0.1.1).

Corrected against the official Act, the DPDP Rules 2025 (G.S.R. 846(E)) and the
Act commencement notification (G.S.R. 843(E)):
- CNS-003: the seven-year record period applies to a registered Consent Manager
  (First Schedule Part B item 4(c)), not every Data Fiduciary; the general duty is
  to be able to prove notice and consent (Section 6(10)).
- DAT-003: Rule 14(3) requires a published grievance response period not
  exceeding ninety days; a 30-day internal target is organisational policy.
- DAT-006: the DPDP Act creates no general data portability entitlement and
  Section 11(2) is an exception to access information; export is voluntary policy.
- BRCH-002: Rule 7(1) applies to any personal data breach; there is no
  likely-harm trigger.
- RCD-001 and RCD-003: processing inventories and data-flow maps are accountability
  practice, not express Rule 8 / Third Schedule duties.
- Per-control phased commencement is derived from the cited provisions.

Published 0.1.1 controls, mappings and historical report hashes are unchanged.
The new controls previously planned for 0.2.0 move to a later MINOR.`;

const REPLACEMENTS: Readonly<Record<string, Omit<Control, 'introducedInVersion'>>> = {
  'DPDPA-CNS-003': {
    id: 'DPDPA-CNS-003',
    title: 'Keep verifiable records proving notice and consent',
    domain: 'CNS',
    severity: 'high',
    obligation:
      'Where consent is the basis of processing, the Data Fiduciary must be able to prove that notice was given and consent was obtained in accordance with the Act and the Rules (Section 6(10)). Consent records should capture the notice version, the data principal identifier, the timestamp and the items consented to, and be kept for a period with a documented, applicable basis. The seven-year platform-record period applies only to a registered Consent Manager (Rule 4 read with the First Schedule, Part B item 4(c)).',
    citations: [
      { instrument: 'DPDPA-2023', reference: 'Section 6(10)' },
      { instrument: 'DPDPR-2025', reference: 'Rule 4 and First Schedule' },
    ],
    evidenceRequired: [
      {
        type: 'config',
        description:
          'Consent-record schema and retention policy stating the period and its applicable basis',
      },
      { type: 'log', description: 'Sample consent record with all required fields' },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt:
          'Do you store a record of every consent with timestamp + notice version + items + data principal ID?',
        type: 'boolean',
        evidenceTypes: ['config', 'log'],
        dependsOn: [],
      },
      {
        id: 'Q2',
        prompt:
          'Is the retention period for consent records documented, with an applicable basis for that period?',
        type: 'boolean',
        evidenceTypes: ['config', 'document'],
        dependsOn: [],
      },
      {
        id: 'Q3',
        prompt:
          'Only if you are a registered Consent Manager: do you keep platform consent records for at least seven years (First Schedule, Part B item 4(c))?',
        type: 'boolean',
        evidenceTypes: ['config'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 18, maxPenaltyINR: 5_00_00_000 },
    remediationPatterns: ['config', 'policy'],
    tags: ['always-applies', 'retention'],
    sdfOnly: false,
    childrenOnly: false,
    revisedInVersion: '0.2.0',
    notes:
      'Q3 applies only to a Consent Manager registered under Section 6(9) and Rule 4; record it as not applicable for any other Data Fiduciary.',
  },
  'DPDPA-DAT-003': {
    id: 'DPDPA-DAT-003',
    title: 'Operate grievance redressal within a published response period',
    domain: 'DAT',
    severity: 'high',
    obligation:
      'The Data Fiduciary must provide readily available means of grievance redressal and respond within the prescribed period (Section 13(1)–(2)). It must prominently publish on its website or app the period for responding to grievances, which must be a reasonable period not exceeding ninety days, and implement technical and organisational measures to respond within it (Rule 14(3)). A stricter internal target, such as 30 days, is organisational policy and not the statutory limit.',
    citations: [
      { instrument: 'DPDPA-2023', reference: 'Section 13(1), 13(2)' },
      { instrument: 'DPDPR-2025', reference: 'Rule 14(3)' },
    ],
    evidenceRequired: [
      {
        type: 'document',
        description: 'Published grievance contact and response period (not exceeding 90 days)',
      },
      {
        type: 'log',
        description: 'Grievance ticketing with response time tracked against the published period',
      },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt: 'Is the grievance officer name and contact publicly available?',
        type: 'boolean',
        evidenceTypes: ['document', 'screenshot'],
        dependsOn: [],
      },
      {
        id: 'Q2',
        prompt:
          'Is your grievance response period prominently published on your website or app, and is it no longer than 90 days?',
        type: 'boolean',
        evidenceTypes: ['document', 'screenshot'],
        dependsOn: [],
      },
      {
        id: 'Q3',
        prompt:
          'Do you track grievance responses against the published period (and against any stricter internal target, labelled as policy)?',
        type: 'boolean',
        evidenceTypes: ['log', 'attestation'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 18, maxPenaltyINR: 5_00_00_000 },
    remediationPatterns: ['policy', 'dpo-appointment'],
    tags: ['always-applies'],
    sdfOnly: false,
    childrenOnly: false,
    revisedInVersion: '0.2.0',
  },
  'DPDPA-DAT-006': {
    id: 'DPDPA-DAT-006',
    title: 'Offer voluntary structured data export (organisational policy)',
    domain: 'DAT',
    severity: 'medium',
    obligation:
      'The DPDP Act does not create a general data portability entitlement. Section 11(1) gives a right to a summary of personal data and processing and to information about sharing; Section 11(2) is an exception to that sharing information, not a portability right. Any structured, machine-readable export the Data Fiduciary offers is voluntary organisational policy. Machine-readable access to platform records is a separate duty of a registered Consent Manager (First Schedule, Part B item 4(b)).',
    citations: [{ instrument: 'DPDPA-2023', reference: 'Section 11(1), 11(2)' }],
    evidenceRequired: [
      {
        type: 'config',
        description:
          'If offered: export pipeline producing JSON / CSV in a documented schema, labelled as policy',
      },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt:
          "As a voluntary policy, can you export a user's data in a structured, machine-readable format on request?",
        type: 'boolean',
        evidenceTypes: ['config', 'log'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 10, maxPenaltyINR: 2_00_00_000 },
    remediationPatterns: ['data-portability', 'config'],
    tags: ['always-applies', 'rights', 'organisation-policy'],
    sdfOnly: false,
    childrenOnly: false,
    revisedInVersion: '0.2.0',
    notes:
      'Organisation-policy control. A gap here is not a statutory breach and must not drive a statutory penalty estimate; scoring is pending owner review.',
  },
  'DPDPA-BRCH-002': {
    id: 'DPDPA-BRCH-002',
    title: 'Notify each affected data principal of any personal data breach',
    domain: 'BRCH',
    severity: 'high',
    obligation:
      'On becoming aware of any personal data breach, the Data Fiduciary must, to the best of its knowledge, inform each affected data principal without delay, concisely, clearly and in plain language, through her user account or registered mode of communication. The notice covers the nature, extent and timing of the breach, its likely consequences for her, mitigation measures, the safety measures she may take, and a business contact for queries (Rule 7(1)). There is no likely-harm threshold; likely consequences shape the content, not the trigger. Board intimation is separate (Rule 7(2); see DPDPA-BRCH-001).',
    citations: [
      { instrument: 'DPDPA-2023', reference: 'Section 8(6)' },
      { instrument: 'DPDPR-2025', reference: 'Rule 7' },
    ],
    evidenceRequired: [
      {
        type: 'document',
        description: 'Principal notification template covering the Rule 7(1)(a)–(e) contents',
      },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt: 'Do you have a template for notifying affected principals?',
        type: 'boolean',
        evidenceTypes: ['document'],
        dependsOn: [],
      },
      {
        id: 'Q2',
        prompt:
          'Does your procedure notify affected principals of any personal data breach (not only where harm is likely), with the Rule 7(1)(a)–(e) contents?',
        type: 'boolean',
        evidenceTypes: ['document'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 22, maxPenaltyINR: 5_00_00_000 },
    remediationPatterns: ['breach-process', 'policy'],
    tags: ['always-applies'],
    sdfOnly: false,
    childrenOnly: false,
    revisedInVersion: '0.2.0',
  },
  'DPDPA-RCD-001': {
    id: 'DPDPA-RCD-001',
    title: 'Maintain a processing inventory (accountability practice)',
    domain: 'RCD',
    severity: 'high',
    obligation:
      'Maintain an accurate, current inventory of processing activities as an accountability and evidence practice that supports the Data Fiduciary’s responsibility for compliance, including processing by Data Processors (Section 8(1)). Neither the Act nor Rule 8 and the Third Schedule prescribe a general Record of Processing Activities; Rule 8 erasure and retention duties apply separately where their classes and purposes apply.',
    citations: [{ instrument: 'DPDPA-2023', reference: 'Section 8(1)' }],
    evidenceRequired: [
      {
        type: 'inventory',
        description:
          'Living processing inventory — purpose, data items, basis, processors, retention, cross-border',
      },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt: 'Do you maintain a written inventory of your processing activities?',
        type: 'boolean',
        evidenceTypes: ['inventory', 'document'],
        dependsOn: [],
      },
      {
        id: 'Q2',
        prompt: 'Is it updated within 30 days of any change in processing (internal policy)?',
        type: 'boolean',
        evidenceTypes: ['attestation'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 18, maxPenaltyINR: 5_00_00_000 },
    remediationPatterns: ['discovery', 'reporting'],
    tags: ['always-applies', 'core', 'organisation-policy'],
    sdfOnly: false,
    childrenOnly: false,
    revisedInVersion: '0.2.0',
    notes:
      'Accountability practice, not an express statutory record duty; scoring is pending owner review.',
  },
  'DPDPA-RCD-003': {
    id: 'DPDPA-RCD-003',
    title: 'Map data flows to processors and sub-processors (accountability practice)',
    domain: 'RCD',
    severity: 'high',
    obligation:
      'Maintain a working data-flow map showing personal data movement, including to processors and sub-processors, as an accountability practice supporting the Data Fiduciary’s responsibility for processing on its behalf (Section 8(1)). This is not an express directive under Rule 8 or the Third Schedule.',
    citations: [{ instrument: 'DPDPA-2023', reference: 'Section 8(1)' }],
    evidenceRequired: [
      { type: 'inventory', description: 'Data flow diagram with processors and sub-processors' },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt: 'Is there a current data-flow map showing processors and sub-processors?',
        type: 'boolean',
        evidenceTypes: ['inventory', 'document'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 18, maxPenaltyINR: 5_00_00_000 },
    remediationPatterns: ['discovery', 'vendor-risk'],
    tags: ['always-applies', 'organisation-policy'],
    sdfOnly: false,
    childrenOnly: false,
    revisedInVersion: '0.2.0',
    notes:
      'Accountability practice, not an express statutory duty; scoring is pending owner review.',
  },
};

export const CORRECTED_CONTROL_IDS_0_2_0 = Object.freeze(Object.keys(REPLACEMENTS).sort());

function build(): Control[] {
  const seen = new Set<string>();
  const out = controls_0_1_1.map((original) => {
    const replacement = REPLACEMENTS[original.id];
    if (!replacement) return structuredClone(original);
    seen.add(original.id);
    // Keep the key order of the published row so the seed shape is stable.
    return { ...structuredClone(replacement), introducedInVersion: original.introducedInVersion };
  });
  if (seen.size !== Object.keys(REPLACEMENTS).length)
    throw new Error('0.2.0 replacement targets a control absent from 0.1.1');
  return out;
}

export const controls_0_2_0: readonly Control[] = Object.freeze(build());
