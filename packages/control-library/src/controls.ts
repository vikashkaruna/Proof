import type { Control } from './types';
import { BASELINE_CODE, COMMENCEMENT } from './regulatory-baseline';

/**
 * Axiom Proof — Control Library v0.1.1
 *
 * 46 controls covering the Digital Personal Data Protection Act, 2023 and the
 * Digital Personal Data Protection Rules, 2025 — G.S.R. 846(E), Gazette No. 760,
 * published 13 November 2025, as corrected by G.S.R. 892(E) of 11 December 2025.
 * 23 rules and 7 schedules. Core substantive enforcement 13 May 2027.
 *
 * Assessed against baseline `IN-DPDP@2026-09-20`. See `regulatory-baseline.ts`
 * for the instruments, the verified rule table and the commencement clock.
 *
 * Severity rubric:
 *   critical = statutory ceiling fine applies (up to ₹250 Cr per breach)
 *   high     = specific enforceable obligation with named penalty
 *   medium   = process / record-keeping obligation
 *   low      = best-practice / quality control
 *
 * Penalty points are calibrated to the Section 33 tiering: ₹50–250 Cr.
 * Conservative — a single critical finding should not on its own imply
 * the ₹250 Cr ceiling; that requires the Section 8(5) test (failure to
 * take reasonable security). The cumulative exposure across multiple
 * findings is what matters.
 */

export const LIBRARY_VERSION = '0.1.1';
export const LIBRARY_PUBLISHED_AT = '2026-09-20';
export const LIBRARY_PUBLISHER = 'Axiom Minds · Founder';
export const LIBRARY_BASELINE = BASELINE_CODE;

/**
 * 0.1.1 is a PATCH under the comparability rule (W7.0): what each control
 * TESTS is unchanged, only the statutory reference it prints. Existing client
 * assessments pinned to 0.1.0 therefore remain valid and need no re-run — they
 * are offered a re-issued report carrying corrected citations against the same
 * results. Only a scoring-model change (1.0.0) forces re-assessment.
 */
export const LIBRARY_CHANGELOG = `0.1.1 — CITATION CORRECTION (PATCH; assessments remain comparable).

The DPDPR-2025 citations were authored against the DRAFT Rules numbering and
were never re-mapped after notification, so 21 of 24 pointed at the wrong rule.
Reports generated against 0.1.0 cite the wrong law for notice, breach
notification, retention, cross-border transfer, data-principal rights and SDF
obligations. All 24 re-mapped against the Gazette text of G.S.R. 846(E) and
verified on 2026-09-20; each citation now records what it was verified against.

Header facts corrected: notification is 13 November 2025 (not 14 — the Gazette
issue is dated the 13th, and every commencement date is computed from it);
there are 23 rules (not "rules 5-24"); children's-data controls follow Rule 10
(not "Rules 9-10"); SDF controls follow Rule 13 (not "Rules 11-12").

No control's obligation, evidence requirement, question, scoring or remediation
pattern changed. Control count unchanged; the ~19 controls for the 10 uncited
rules and 7 schedules land in 0.2.0 as a MINOR.`; // axiom-count-ok: 19 is the number of NEW controls in 0.2.0, not the library total

/**
 * Default commencement for a control whose rules are all in the 18-month
 * group. Individual controls override via `effectiveFrom`.
 */
export const LIBRARY_DEFAULT_EFFECTIVE_FROM = COMMENCEMENT.eighteenMonths;

export const controls: Control[] = [
  // ─────────────────────────────────────────────────────────────────────
  // GOV — Governance & Accountability
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'DPDPA-GOV-001',
    title: 'Designate a data fiduciary accountable for DPDPA compliance',
    domain: 'GOV',
    severity: 'critical',
    obligation:
      'Every entity that determines the purpose and means of processing digital personal data is a Data Fiduciary and bears primary statutory accountability under Section 8 of the DPDP Act, regardless of contract structure.',
    citations: [{ instrument: 'DPDPA-2023', reference: 'Section 2(i), 2(k), 8(1)' }],
    evidenceRequired: [
      {
        type: 'document',
        description: 'Board resolution or partnership deed naming the Data Fiduciary entity',
      },
      {
        type: 'config',
        description: 'Authoritative organisational record (MCA / GST filing) showing the entity',
      },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt:
          'Is there a single legal entity formally identified as the Data Fiduciary for the personal data you process?',
        type: 'boolean',
        evidenceTypes: ['document', 'config'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 30, maxPenaltyINR: 25_00_00_000 },
    remediationPatterns: ['dpo-appointment', 'review'],
    tags: ['foundation', 'always-applies'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },
  {
    id: 'DPDPA-GOV-002',
    title: 'Publish a privacy policy covering all processing activities',
    domain: 'GOV',
    severity: 'high',
    obligation:
      'A publicly accessible privacy policy must describe the personal data processed, the purposes, the rights of data principals, and contact information for grievance redressal (Section 5(3) read with Rule 3).',
    citations: [
      { instrument: 'DPDPA-2023', reference: 'Section 5(3)' },
      { instrument: 'DPDPR-2025', reference: 'Rule 3' },
    ],
    evidenceRequired: [
      { type: 'document', description: 'Public privacy policy URL with version + effective date' },
      { type: 'screenshot', description: 'Live screenshot of the published policy' },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt:
          'Do you have a publicly accessible privacy policy that meets Section 5(3) requirements?',
        type: 'boolean',
        evidenceTypes: ['document', 'screenshot'],
        dependsOn: [],
      },
      {
        id: 'Q2',
        prompt: 'When was the policy last reviewed and is the version date visible on the page?',
        type: 'evidence',
        evidenceTypes: ['screenshot'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 18, maxPenaltyINR: 5_00_00_000 },
    remediationPatterns: ['policy'],
    tags: ['always-applies', 'public-facing'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },
  {
    id: 'DPDPA-GOV-003',
    title: 'Maintain a written data-processing agreement with every Data Processor',
    domain: 'GOV',
    severity: 'high',
    obligation:
      "Personal data may be processed by a Data Processor only under a valid contract that limits processing to the Data Fiduciary's instructions, enforces security safeguards, and binds the processor to the Act (Section 8(1), Rule 6).",
    citations: [
      { instrument: 'DPDPA-2023', reference: 'Section 8(1), 2(l)' },
      { instrument: 'DPDPR-2025', reference: 'Rule 6' },
    ],
    evidenceRequired: [
      {
        type: 'document',
        description:
          'Signed DPA with each processor covering scope, security, sub-processors, return/deletion',
      },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt:
          'List all third parties that process personal data on your behalf (Data Processors).',
        type: 'text',
        evidenceTypes: ['document'],
        dependsOn: [],
      },
      {
        id: 'Q2',
        prompt: 'For each processor, is there a signed DPA that meets Rule 6 requirements?',
        type: 'evidence',
        evidenceTypes: ['document'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 20, maxPenaltyINR: 5_00_00_000 },
    remediationPatterns: ['dpa-execution', 'vendor-risk'],
    tags: ['always-applies', 'vendor'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },

  // ─────────────────────────────────────────────────────────────────────
  // CNS — Consent & Notice
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'DPDPA-CNS-001',
    title: 'Obtain free, specific, informed, unconditional, unambiguous consent',
    domain: 'CNS',
    severity: 'critical',
    obligation:
      'Consent must be free, specific, informed, unconditional and unambiguous, with a clear affirmative action, and must be capable of being withdrawn as easily as it was given (Section 6(1)–(4)).',
    citations: [
      { instrument: 'DPDPA-2023', reference: 'Section 6(1), 6(2), 6(3), 6(4)' },
      { instrument: 'DPDPR-2025', reference: 'Rule 3' },
    ],
    evidenceRequired: [
      {
        type: 'screenshot',
        description:
          'Screenshot of the consent capture UX showing it is un-bundled and affirmative',
      },
      {
        type: 'log',
        description: 'Sample of consent records with timestamp and version of notice shown',
      },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt:
          'Is consent obtained via a clear affirmative action (not pre-ticked boxes or implied consent)?',
        type: 'boolean',
        evidenceTypes: ['screenshot', 'config'],
        dependsOn: [],
      },
      {
        id: 'Q2',
        prompt: 'Is the consent notice shown at the time of consent and version-pinned?',
        type: 'boolean',
        evidenceTypes: ['screenshot', 'log'],
        dependsOn: [],
      },
      {
        id: 'Q3',
        prompt: 'Can the data principal withdraw consent as easily as they gave it?',
        type: 'boolean',
        evidenceTypes: ['screenshot', 'config'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 35, maxPenaltyINR: 25_00_00_000 },
    remediationPatterns: ['consent', 'policy'],
    tags: ['always-applies', 'first-principle'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },
  {
    id: 'DPDPA-CNS-002',
    title: 'Issue notice before or alongside consent specifying purpose, items, and rights',
    domain: 'CNS',
    severity: 'high',
    obligation:
      'Before seeking consent the Data Fiduciary must issue a notice describing the personal data and the purpose of processing, the manner of exercising rights, and the means of making a complaint (Section 5(1)–(2), Rule 3).',
    citations: [
      { instrument: 'DPDPA-2023', reference: 'Section 5(1), 5(2)' },
      { instrument: 'DPDPR-2025', reference: 'Rule 3' },
    ],
    evidenceRequired: [
      { type: 'document', description: 'Consent notice text showing all required items' },
      { type: 'screenshot', description: 'Live UI showing notice at point of consent' },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt:
          'Does the notice describe the personal data items being collected and the specific purpose?',
        type: 'boolean',
        evidenceTypes: ['document'],
        dependsOn: [],
      },
      {
        id: 'Q2',
        prompt: 'Does the notice explain how to exercise rights and how to make a complaint?',
        type: 'boolean',
        evidenceTypes: ['document'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 20, maxPenaltyINR: 5_00_00_000 },
    remediationPatterns: ['policy', 'consent'],
    tags: ['always-applies'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },
  {
    id: 'DPDPA-CNS-003',
    title: 'Maintain a consent ledger with at least 7-year retention',
    domain: 'CNS',
    severity: 'high',
    obligation:
      'Records of consent — including the notice version, the data principal identifier, the timestamp, and the items consented to — must be retained for at least 7 years from the date of consent or last action, whichever is later (Rule 4 read with the First Schedule).',
    citations: [{ instrument: 'DPDPR-2025', reference: 'Rule 4 and First Schedule' }],
    evidenceRequired: [
      {
        type: 'config',
        description: 'Schema + retention policy showing 7-year retention on consent records',
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
        prompt: 'Is the retention period at least 7 years?',
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
    introducedInVersion: '0.1.0',
  },
  {
    id: 'DPDPA-CNS-004',
    title: 'Honor consent withdrawal and erase related data',
    domain: 'CNS',
    severity: 'critical',
    obligation:
      'On withdrawal of consent, processing must stop and personal data must be erased within a reasonable time, except where retention is necessary for legal obligation (Section 6(4), 8(7)).',
    citations: [{ instrument: 'DPDPA-2023', reference: 'Section 6(4), 8(7)' }],
    evidenceRequired: [
      { type: 'log', description: 'Withdrawal workflow showing receipt → action → completion' },
      { type: 'attestation', description: 'Policy on what is erased vs retained and why' },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt: 'Is there a working mechanism for users to withdraw consent?',
        type: 'boolean',
        evidenceTypes: ['screenshot', 'config'],
        dependsOn: [],
      },
      {
        id: 'Q2',
        prompt:
          "After withdrawal, is the user's personal data erased from active systems within a reasonable time?",
        type: 'boolean',
        evidenceTypes: ['log', 'attestation'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 30, maxPenaltyINR: 25_00_00_000 },
    remediationPatterns: ['data-deletion', 'consent', 'config'],
    tags: ['always-applies', 'rights'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },
  {
    id: 'DPDPA-CNS-005',
    title: 'Publish an itemised list of personal data collected for each purpose',
    domain: 'CNS',
    severity: 'medium',
    obligation:
      'The notice must itemise the personal data being collected and the specific purpose, not generic categories. "Personal data" must be itemised at a level a data principal can understand and consent to specifically.',
    citations: [
      { instrument: 'DPDPA-2023', reference: 'Section 5(1)(b)' },
      { instrument: 'DPDPR-2025', reference: 'Rule 3' },
    ],
    evidenceRequired: [{ type: 'document', description: 'Notice text showing itemised fields' }],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt:
          'For each processing purpose, does the notice itemise the specific data fields collected?',
        type: 'boolean',
        evidenceTypes: ['document'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 12, maxPenaltyINR: 5_00_00_000 },
    remediationPatterns: ['policy'],
    tags: ['always-applies'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },

  // ─────────────────────────────────────────────────────────────────────
  // DAT — Data Principal Rights
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'DPDPA-DAT-001',
    title: 'Provide a right-of-access mechanism (summary of personal data held)',
    domain: 'DAT',
    severity: 'high',
    obligation:
      'A data principal has the right to obtain a summary of their personal data being processed and the related processing activities (Section 11(1), Rule 14).',
    citations: [
      { instrument: 'DPDPA-2023', reference: 'Section 11(1)' },
      { instrument: 'DPDPR-2025', reference: 'Rule 14' },
    ],
    evidenceRequired: [
      { type: 'config', description: 'DSAR intake + identity verification flow' },
      { type: 'log', description: 'Sample of past fulfilled access requests' },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt: 'Can a data principal request a copy of their personal data you hold?',
        type: 'boolean',
        evidenceTypes: ['screenshot', 'config'],
        dependsOn: [],
      },
      {
        id: 'Q2',
        prompt: 'Within what timeframe do you respond?',
        type: 'text',
        evidenceTypes: ['attestation'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 20, maxPenaltyINR: 5_00_00_000 },
    remediationPatterns: ['review', 'policy', 'data-portability'],
    tags: ['always-applies', 'rights'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },
  {
    id: 'DPDPA-DAT-002',
    title: 'Provide right to correction and erasure of personal data',
    domain: 'DAT',
    severity: 'high',
    obligation:
      'A data principal may request correction or erasure of their personal data where it is incomplete, inaccurate, or no longer necessary (Section 12, Rule 14).',
    citations: [
      { instrument: 'DPDPA-2023', reference: 'Section 12' },
      { instrument: 'DPDPR-2025', reference: 'Rule 14' },
    ],
    evidenceRequired: [
      { type: 'config', description: 'Correction/erasure request workflow' },
      { type: 'log', description: 'Sample of completed correction/erasure requests' },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt: 'Can a data principal request correction of inaccurate personal data?',
        type: 'boolean',
        evidenceTypes: ['screenshot', 'config'],
        dependsOn: [],
      },
      {
        id: 'Q2',
        prompt:
          'Can a data principal request erasure of personal data, and do you action it across all systems (including processors)?',
        type: 'boolean',
        evidenceTypes: ['screenshot', 'config', 'log'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 22, maxPenaltyINR: 5_00_00_000 },
    remediationPatterns: ['data-deletion', 'config', 'policy'],
    tags: ['always-applies', 'rights'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },
  {
    id: 'DPDPA-DAT-003',
    title: 'Operate a grievance redressal mechanism with named contact',
    domain: 'DAT',
    severity: 'high',
    obligation:
      'The Data Fiduciary must establish a grievance redressal mechanism and respond to data principal complaints within 30 days, with the name and contact details of the grievance officer published (Section 13(1), Rule 14).',
    citations: [
      { instrument: 'DPDPA-2023', reference: 'Section 13(1)' },
      { instrument: 'DPDPR-2025', reference: 'Rule 14' },
    ],
    evidenceRequired: [
      { type: 'document', description: 'Published grievance officer name and contact' },
      { type: 'log', description: 'Grievance ticketing with response time tracking' },
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
        prompt: 'Do you respond to complaints within 30 days?',
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
    introducedInVersion: '0.1.0',
  },
  {
    id: 'DPDPA-DAT-004',
    title: 'Provide right to nominate another individual',
    domain: 'DAT',
    severity: 'medium',
    obligation:
      'A data principal may nominate another individual to exercise their rights in the event of death or incapacity (Section 14).',
    citations: [{ instrument: 'DPDPA-2023', reference: 'Section 14' }],
    evidenceRequired: [
      { type: 'config', description: 'Nomination feature in user account' },
      { type: 'document', description: 'Notice describing the right' },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt: 'Can a user nominate another individual to exercise their rights?',
        type: 'boolean',
        evidenceTypes: ['screenshot', 'config'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 8, maxPenaltyINR: 2_00_00_000 },
    remediationPatterns: ['config', 'policy'],
    tags: ['always-applies', 'rights'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },

  // ─────────────────────────────────────────────────────────────────────
  // RCD — Record-keeping
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'DPDPA-RCD-001',
    title: 'Maintain a Record of Processing Activities (RoPA)',
    domain: 'RCD',
    severity: 'high',
    obligation:
      'The Data Fiduciary must maintain accurate and up-to-date records of its processing activities, sufficient to demonstrate compliance (Rule 8 read with the Third Schedule).',
    citations: [
      { instrument: 'DPDPR-2025', reference: 'Rule 8 and Third Schedule' },
      { instrument: 'DPDPA-2023', reference: 'Section 8' },
    ],
    evidenceRequired: [
      {
        type: 'inventory',
        description:
          'Living RoPA — purpose, data items, lawful basis, processors, retention, cross-border',
      },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt: 'Do you maintain a written Record of Processing Activities?',
        type: 'boolean',
        evidenceTypes: ['inventory', 'document'],
        dependsOn: [],
      },
      {
        id: 'Q2',
        prompt: 'Is it updated within 30 days of any change in processing?',
        type: 'boolean',
        evidenceTypes: ['attestation'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 18, maxPenaltyINR: 5_00_00_000 },
    remediationPatterns: ['discovery', 'reporting'],
    tags: ['always-applies', 'core'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },
  {
    id: 'DPDPA-RCD-002',
    title: 'Capture a complete data inventory (systems, fields, flows)',
    domain: 'RCD',
    severity: 'high',
    obligation:
      'The RoPA must be backed by an actual inventory of systems, databases, fields and data flows — not a generic narrative. Records must be available on demand to the Data Protection Board.',
    citations: [{ instrument: 'DPDPR-2025', reference: 'Rule 6' }],
    evidenceRequired: [
      {
        type: 'inventory',
        description: 'System-level inventory with field-level personal-data classification',
      },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt: 'Have you inventoried all systems that hold personal data?',
        type: 'boolean',
        evidenceTypes: ['inventory'],
        dependsOn: [],
      },
      {
        id: 'Q2',
        prompt: 'Is the inventory field-level (not just system-level)?',
        type: 'boolean',
        evidenceTypes: ['inventory'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 18, maxPenaltyINR: 5_00_00_000 },
    remediationPatterns: ['discovery'],
    tags: ['always-applies', 'core'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },

  // ─────────────────────────────────────────────────────────────────────
  // BRCH — Breach & Incident
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'DPDPA-BRCH-001',
    title: 'Notify the Data Protection Board of a personal data breach',
    domain: 'BRCH',
    severity: 'critical',
    obligation:
      'On becoming aware of a personal data breach, the Data Fiduciary must inform the Data Protection Board and the affected data principals in the manner and within the time prescribed (Section 8(6), Rules 19–20).',
    citations: [
      { instrument: 'DPDPA-2023', reference: 'Section 8(6)' },
      { instrument: 'DPDPR-2025', reference: 'Rule 7' },
    ],
    evidenceRequired: [
      { type: 'document', description: 'Breach response runbook with 72-hour DPB clock' },
      { type: 'log', description: 'Forensic log capture capability' },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt: 'Do you have a documented breach response procedure?',
        type: 'boolean',
        evidenceTypes: ['document'],
        dependsOn: [],
      },
      {
        id: 'Q2',
        prompt:
          'Can you meet the statutory notification clock (typically 72 hours from awareness)?',
        type: 'boolean',
        evidenceTypes: ['attestation', 'log'],
        dependsOn: [],
      },
      {
        id: 'Q3',
        prompt: 'Do you have forensic log capture sufficient to reconstruct a breach?',
        type: 'boolean',
        evidenceTypes: ['log', 'config'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 40, maxPenaltyINR: 25_00_00_000 },
    remediationPatterns: ['breach-process', 'policy'],
    tags: ['always-applies', 'high-stakes'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },
  {
    id: 'DPDPA-BRCH-002',
    title: 'Notify affected data principals of a breach where harm is likely',
    domain: 'BRCH',
    severity: 'high',
    obligation:
      'Where a breach is likely to cause harm to a data principal, the Data Fiduciary must inform affected principals without delay, in plain language, of the nature of the breach and the protective measures (Rule 7).',
    citations: [{ instrument: 'DPDPR-2025', reference: 'Rule 7' }],
    evidenceRequired: [
      { type: 'document', description: 'Principal notification template and trigger criteria' },
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
        prompt: 'Is the trigger criteria for principal notification defined?',
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
    introducedInVersion: '0.1.0',
  },

  // ─────────────────────────────────────────────────────────────────────
  // XBR — Cross-border Transfer
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'DPDPA-XBR-001',
    title: 'Restrict cross-border transfer to countries not on the restricted list',
    domain: 'XBR',
    severity: 'high',
    obligation:
      'Personal data may be transferred outside India only to countries or territories not specifically restricted by the Central Government via notification (Section 16, Rule 15).',
    citations: [
      { instrument: 'DPDPA-2023', reference: 'Section 16' },
      { instrument: 'DPDPR-2025', reference: 'Rule 15' },
    ],
    evidenceRequired: [
      { type: 'inventory', description: 'Data flow map showing all cross-border destinations' },
      {
        type: 'document',
        description: 'Policy and DPA clauses restricting transfer to allowed jurisdictions',
      },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt: 'Do you transfer any personal data outside India?',
        type: 'boolean',
        evidenceTypes: ['inventory'],
        dependsOn: [],
      },
      {
        id: 'Q2',
        prompt:
          'If yes, are all destinations confirmed not on the restricted list (as notified by the Central Government)?',
        type: 'boolean',
        evidenceTypes: ['document', 'attestation'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 25, maxPenaltyINR: 5_00_00_000 },
    remediationPatterns: ['vendor-risk', 'dpa-execution', 'policy'],
    tags: ['always-applies', 'cross-border'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },
  {
    id: 'DPDPA-XBR-002',
    title: 'Document the legal basis for any cross-border transfer',
    domain: 'XBR',
    severity: 'medium',
    obligation:
      'Every cross-border transfer must be supported by a specific contract clause, consent, or other lawful basis that meets Section 16 requirements.',
    citations: [{ instrument: 'DPDPA-2023', reference: 'Section 16' }],
    evidenceRequired: [
      { type: 'document', description: 'Transfer impact assessment or contract clauses' },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt: 'For each cross-border transfer, is the legal basis documented?',
        type: 'boolean',
        evidenceTypes: ['document'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 15, maxPenaltyINR: 5_00_00_000 },
    remediationPatterns: ['dpa-execution', 'policy'],
    tags: ['cross-border'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },

  // ─────────────────────────────────────────────────────────────────────
  // CHD — Children's Data
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'DPDPA-CHD-001',
    title: "Obtain verifiable parental consent before processing children's data",
    domain: 'CHD',
    severity: 'critical',
    obligation:
      'Personal data of children (under 18) may be processed only with verifiable parental consent, and processing must not be detrimental to the well-being of the child (Section 9, Rule 10).',
    citations: [
      { instrument: 'DPDPA-2023', reference: 'Section 9' },
      { instrument: 'DPDPR-2025', reference: 'Rule 10' },
    ],
    evidenceRequired: [
      { type: 'config', description: 'Age-gate + parental consent flow' },
      { type: 'document', description: 'Age-appropriate notice language' },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt: 'Do you process data of children (users under 18)?',
        type: 'boolean',
        evidenceTypes: ['inventory'],
        dependsOn: [],
      },
      {
        id: 'Q2',
        prompt: 'If yes, do you obtain verifiable parental consent before processing?',
        type: 'boolean',
        evidenceTypes: ['config', 'log'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 35, maxPenaltyINR: 25_00_00_000 },
    remediationPatterns: ['consent', 'config', 'policy'],
    tags: ['children'],
    sdfOnly: false,
    childrenOnly: true,
    introducedInVersion: '0.1.0',
  },
  {
    id: 'DPDPA-CHD-002',
    title: 'Refuse to undertake tracking or behavioural monitoring of children',
    domain: 'CHD',
    severity: 'high',
    obligation:
      'Data Fiduciaries must not undertake tracking, behavioural monitoring, or targeted advertising directed at children (Section 9(2), Rule 10).',
    citations: [
      { instrument: 'DPDPA-2023', reference: 'Section 9(2)' },
      { instrument: 'DPDPR-2025', reference: 'Rule 10' },
    ],
    evidenceRequired: [
      { type: 'config', description: 'Ad-tech and analytics exclusion for child users' },
      { type: 'attestation', description: 'Internal policy on no-targeted-ads-to-children' },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt:
          'Do you run any tracking, behavioural monitoring, or targeted advertising that could reach children?',
        type: 'boolean',
        evidenceTypes: ['config', 'attestation'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 25, maxPenaltyINR: 5_00_00_000 },
    remediationPatterns: ['config', 'policy'],
    tags: ['children'],
    sdfOnly: false,
    childrenOnly: true,
    introducedInVersion: '0.1.0',
  },

  // ─────────────────────────────────────────────────────────────────────
  // SDF — Significant Data Fiduciary
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'DPDPA-SDF-001',
    title: 'Appoint a Data Protection Officer (India-based, named)',
    domain: 'SDF',
    severity: 'high',
    obligation:
      'A Significant Data Fiduciary must appoint a Data Protection Officer based in India who reports to the board, and publish their name and contact (Section 10, Rule 13).',
    citations: [
      { instrument: 'DPDPA-2023', reference: 'Section 10' },
      { instrument: 'DPDPR-2025', reference: 'Rule 13' },
    ],
    evidenceRequired: [
      {
        type: 'document',
        description: 'DPO appointment letter, India-based address, board reporting line',
      },
      { type: 'config', description: 'Public DPO contact on website' },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt:
          'Have you been designated as a Significant Data Fiduciary by the Central Government?',
        type: 'boolean',
        evidenceTypes: ['document', 'attestation'],
        dependsOn: [],
      },
      {
        id: 'Q2',
        prompt:
          'If yes, have you appointed a Data Protection Officer based in India and published their contact?',
        type: 'boolean',
        evidenceTypes: ['document', 'screenshot'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 22, maxPenaltyINR: 5_00_00_000 },
    remediationPatterns: ['dpo-appointment', 'policy'],
    tags: ['SDF'],
    sdfOnly: true,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },
  {
    id: 'DPDPA-SDF-002',
    title: 'Conduct periodic Data Protection Impact Assessments (DPIA)',
    domain: 'SDF',
    severity: 'high',
    obligation:
      'A Significant Data Fiduciary must conduct periodic Data Protection Impact Assessments, including for any processing that is likely to cause harm to a data principal (Section 10, Rule 13).',
    citations: [
      { instrument: 'DPDPA-2023', reference: 'Section 10' },
      { instrument: 'DPDPR-2025', reference: 'Rule 13' },
    ],
    evidenceRequired: [
      { type: 'document', description: 'DPIA template + completed DPIA artifacts' },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt: 'Are DPIAs conducted at least annually, and prior to any new high-risk processing?',
        type: 'boolean',
        evidenceTypes: ['document'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 20, maxPenaltyINR: 5_00_00_000 },
    remediationPatterns: ['review', 'reporting', 'policy'],
    tags: ['SDF'],
    sdfOnly: true,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },
  {
    id: 'DPDPA-SDF-003',
    title: 'Submit to periodic audit by an independent Data Auditor',
    domain: 'SDF',
    severity: 'high',
    obligation:
      'A Significant Data Fiduciary must be audited periodically by an independent Data Auditor, and the audit report must be submitted to the Board (Section 10, Rule 13).',
    citations: [
      { instrument: 'DPDPA-2023', reference: 'Section 10' },
      { instrument: 'DPDPR-2025', reference: 'Rule 13' },
    ],
    evidenceRequired: [
      { type: 'document', description: 'Independent audit engagement + latest audit report' },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt: 'Are you audited annually by an independent Data Auditor?',
        type: 'boolean',
        evidenceTypes: ['document'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 20, maxPenaltyINR: 5_00_00_000 },
    remediationPatterns: ['reporting', 'vendor-risk'],
    tags: ['SDF'],
    sdfOnly: true,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },

  // ─────────────────────────────────────────────────────────────────────
  // SEC — Security Safeguards
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'DPDPA-SEC-001',
    title: 'Implement reasonable security safeguards (technical + organisational)',
    domain: 'SEC',
    severity: 'critical',
    obligation:
      'The Data Fiduciary must protect personal data in its possession by taking reasonable security safeguards to prevent personal data breach (Section 8(5)). Failure constitutes grounds for the highest penalty tier under Section 33(7).',
    citations: [
      { instrument: 'DPDPA-2023', reference: 'Section 8(5)' },
      { instrument: 'DPDPR-2025', reference: 'Rule 6' },
    ],
    evidenceRequired: [
      {
        type: 'config',
        description: 'Encryption at rest + in transit, access controls, MFA, logging',
      },
      { type: 'document', description: 'Security policy + incident response plan' },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt:
          'Is personal data encrypted at rest (AES-256 or equivalent) and in transit (TLS 1.2+)?',
        type: 'boolean',
        evidenceTypes: ['config'],
        dependsOn: [],
      },
      {
        id: 'Q2',
        prompt:
          'Is multi-factor authentication enforced for administrative access to personal data stores?',
        type: 'boolean',
        evidenceTypes: ['config'],
        dependsOn: [],
      },
      {
        id: 'Q3',
        prompt: 'Is access to personal data logged and reviewed?',
        type: 'boolean',
        evidenceTypes: ['log', 'config'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 50, maxPenaltyINR: 25_00_00_000 },
    remediationPatterns: ['config', 'policy', 'training'],
    tags: ['always-applies', 'foundation'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },
  {
    id: 'DPDPA-SEC-002',
    title: 'Enforce least-privilege access to personal data',
    domain: 'SEC',
    severity: 'high',
    obligation:
      'Access to personal data must be limited to personnel who require it for the documented purpose, with role-based access controls and periodic access review.',
    citations: [{ instrument: 'DPDPA-2023', reference: 'Section 8(5)' }],
    evidenceRequired: [{ type: 'config', description: 'RBAC configuration + access review logs' }],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt: 'Is access to personal data gated by role-based access control?',
        type: 'boolean',
        evidenceTypes: ['config'],
        dependsOn: [],
      },
      {
        id: 'Q2',
        prompt: 'Are access rights reviewed at least annually?',
        type: 'boolean',
        evidenceTypes: ['log', 'attestation'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 20, maxPenaltyINR: 5_00_00_000 },
    remediationPatterns: ['config', 'review', 'policy'],
    tags: ['always-applies'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },
  {
    id: 'DPDPA-SEC-003',
    title: 'Maintain audit logs of access and processing of personal data',
    domain: 'SEC',
    severity: 'high',
    obligation:
      'Comprehensive, tamper-evident logs of who accessed or processed personal data, when, and for what purpose must be maintained for forensic and regulatory use.',
    citations: [{ instrument: 'DPDPA-2023', reference: 'Section 8(5)' }],
    evidenceRequired: [{ type: 'log', description: 'Append-only, hash-chained audit ledger' }],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt: 'Are all access and processing events recorded to an append-only audit log?',
        type: 'boolean',
        evidenceTypes: ['log', 'config'],
        dependsOn: [],
      },
      {
        id: 'Q2',
        prompt: 'Is the log tamper-evident (e.g. hash-chained, write-once)?',
        type: 'boolean',
        evidenceTypes: ['config'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 20, maxPenaltyINR: 5_00_00_000 },
    remediationPatterns: ['config', 'review'],
    tags: ['always-applies', 'audit'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },
  {
    id: 'DPDPA-SEC-004',
    title: 'Conduct periodic vulnerability assessment and penetration testing',
    domain: 'SEC',
    severity: 'medium',
    obligation:
      'Personal-data-bearing systems should be subject to periodic vulnerability assessment and penetration testing, with findings remediated within a defined SLA.',
    citations: [{ instrument: 'DPDPA-2023', reference: 'Section 8(5)' }],
    evidenceRequired: [
      { type: 'document', description: 'Latest VAPT report + remediation evidence' },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt: 'When was your last VAPT?',
        type: 'text',
        evidenceTypes: ['document'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 12, maxPenaltyINR: 5_00_00_000 },
    remediationPatterns: ['review', 'policy'],
    tags: ['always-applies'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },
  {
    id: 'DPDPA-SEC-005',
    title: 'Encrypt backups of personal data',
    domain: 'SEC',
    severity: 'high',
    obligation:
      'Backups containing personal data must be encrypted and access-controlled at the same standard as the primary system.',
    citations: [{ instrument: 'DPDPA-2023', reference: 'Section 8(5)' }],
    evidenceRequired: [{ type: 'config', description: 'Backup encryption configuration' }],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt: 'Are backups encrypted at rest?',
        type: 'boolean',
        evidenceTypes: ['config'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 15, maxPenaltyINR: 5_00_00_000 },
    remediationPatterns: ['config'],
    tags: ['always-applies', 'ops'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },

  // ─────────────────────────────────────────────────────────────────────
  // RTN — Retention & Erasure
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'DPDPA-RTN-001',
    title: 'Define and enforce a retention schedule for personal data',
    domain: 'RTN',
    severity: 'high',
    obligation:
      'Personal data must be retained only for as long as necessary to satisfy the purpose for which it was collected, and erased thereafter (Section 8(7)).',
    citations: [{ instrument: 'DPDPA-2023', reference: 'Section 8(7)' }],
    evidenceRequired: [
      { type: 'document', description: 'Written retention schedule with purpose-linked durations' },
      { type: 'config', description: 'System-level enforcement of retention + deletion' },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt: 'Do you have a written retention schedule for each category of personal data?',
        type: 'boolean',
        evidenceTypes: ['document'],
        dependsOn: [],
      },
      {
        id: 'Q2',
        prompt: 'Is retention enforced automatically in your systems?',
        type: 'boolean',
        evidenceTypes: ['config'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 18, maxPenaltyINR: 5_00_00_000 },
    remediationPatterns: ['config', 'policy', 'data-deletion'],
    tags: ['always-applies'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },
  {
    id: 'DPDPA-RTN-002',
    title: 'Erase personal data upon purpose-end or withdrawal',
    domain: 'RTN',
    severity: 'high',
    obligation:
      'On the conclusion of the processing purpose, or on consent withdrawal, the Data Fiduciary must erase the personal data unless retention is required for legal obligation (Section 8(7)).',
    citations: [{ instrument: 'DPDPA-2023', reference: 'Section 8(7)' }],
    evidenceRequired: [
      { type: 'log', description: 'Erasure workflow + sample completed erasures' },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt:
          'Is erasure performed on the documented trigger (purpose end / withdrawal / retention expiry)?',
        type: 'boolean',
        evidenceTypes: ['log', 'config'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 18, maxPenaltyINR: 5_00_00_000 },
    remediationPatterns: ['data-deletion', 'config'],
    tags: ['always-applies'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },
  {
    id: 'DPDPA-RTN-003',
    title: 'Maintain an exception register for legally-required retention',
    domain: 'RTN',
    severity: 'medium',
    obligation:
      'Where erasure is deferred for a legal obligation (e.g. tax, AML, litigation hold), the basis, scope, and the responsible officer must be recorded in a register that an auditor or the Board can review.',
    citations: [{ instrument: 'DPDPA-2023', reference: 'Section 8(7)' }],
    evidenceRequired: [
      { type: 'document', description: 'Exception register with reason, scope, owner, expiry' },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt:
          'Do you maintain a register of records retained for legal obligation rather than erased?',
        type: 'boolean',
        evidenceTypes: ['document'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 8, maxPenaltyINR: 2_00_00_000 },
    remediationPatterns: ['policy', 'reporting'],
    tags: ['always-applies'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },

  // ─────────────────────────────────────────────────────────────────────
  // DPF — DPO / Contact
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'DPDPA-DPF-001',
    title: 'Publish contact details for privacy inquiries',
    domain: 'DPF',
    severity: 'medium',
    obligation:
      "An email and a contact mechanism for privacy inquiries must be publicly available; this can be a grievance officer or a DPO depending on the entity's SDF status.",
    citations: [{ instrument: 'DPDPA-2023', reference: 'Section 5(3)(d), 13(1)' }],
    evidenceRequired: [{ type: 'screenshot', description: 'Public contact details' }],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt: 'Is a privacy contact email publicly listed?',
        type: 'boolean',
        evidenceTypes: ['screenshot', 'document'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 8, maxPenaltyINR: 2_00_00_000 },
    remediationPatterns: ['policy', 'dpo-appointment'],
    tags: ['always-applies'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },
  {
    id: 'DPDPA-DPF-002',
    title: 'Designate a single point of accountability for privacy',
    domain: 'DPF',
    severity: 'high',
    obligation:
      'Even non-SDF Data Fiduciaries benefit from designating a single internal owner — typically a Privacy Lead — who is responsible for the privacy programme, escalation, and Board reporting.',
    citations: [{ instrument: 'DPDPA-2023', reference: 'Section 8' }],
    evidenceRequired: [
      { type: 'document', description: 'Internal appointment / role description' },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt: 'Is there a named individual accountable for the privacy programme?',
        type: 'boolean',
        evidenceTypes: ['document'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 15, maxPenaltyINR: 5_00_00_000 },
    remediationPatterns: ['dpo-appointment', 'policy'],
    tags: ['always-applies'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },

  // ─────────────────────────────────────────────────────────────────────
  // AUD — Audit & Oversight
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'DPDPA-AUD-001',
    title: 'Maintain a continuous, timestamped evidence history of compliance',
    domain: 'AUD',
    severity: 'high',
    obligation:
      'A defensible compliance posture requires a continuous, timestamped, tamper-evident history of compliance evidence — not point-in-time documentation. This is the operational manifestation of the Act\'s "demonstrate compliance" burden.',
    citations: [{ instrument: 'DPDPA-2023', reference: 'Section 8, 33' }],
    evidenceRequired: [
      {
        type: 'log',
        description: 'Append-only, hash-chained evidence ledger spanning the assessment period',
      },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt:
          'Can you produce, on demand, a verifiable, timestamped history of every compliance control for the past 12 months?',
        type: 'boolean',
        evidenceTypes: ['log', 'document'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 22, maxPenaltyINR: 5_00_00_000 },
    remediationPatterns: ['review', 'reporting'],
    tags: ['always-applies', 'defensibility'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },
  {
    id: 'DPDPA-AUD-002',
    title: 'Report posture to the Board or Audit Committee at least annually',
    domain: 'AUD',
    severity: 'medium',
    obligation:
      'A periodic (at least annual) posture report to the Board or Audit Committee establishes governance accountability and provides defensible evidence of oversight.',
    citations: [{ instrument: 'DPDPA-2023', reference: 'Section 8' }],
    evidenceRequired: [
      { type: 'document', description: 'Most recent Board / Audit Committee privacy report' },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt:
          'Has the Board / Audit Committee received a privacy posture update in the past 12 months?',
        type: 'boolean',
        evidenceTypes: ['document'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 10, maxPenaltyINR: 2_00_00_000 },
    remediationPatterns: ['reporting', 'policy'],
    tags: ['always-applies', 'governance'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },

  // ─────────────────────────────────────────────────────────────────────
  // DPIA — Data Protection Impact Assessment
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'DPDPA-DPIA-001',
    title: 'Conduct a DPIA before launching any new high-risk processing',
    domain: 'DPIA',
    severity: 'high',
    obligation:
      'Where processing is likely to cause harm to data principals — large-scale profiling, biometric processing, children, cross-border — a Data Protection Impact Assessment must be completed before processing begins.',
    citations: [
      { instrument: 'DPDPA-2023', reference: 'Section 10' },
      { instrument: 'DPDPR-2025', reference: 'Rule 13' },
    ],
    evidenceRequired: [
      { type: 'document', description: 'DPIA template + completed DPIAs for high-risk processing' },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt: 'Do you conduct a DPIA before any new high-risk processing?',
        type: 'boolean',
        evidenceTypes: ['document'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 20, maxPenaltyINR: 5_00_00_000 },
    remediationPatterns: ['review', 'policy'],
    tags: ['always-applies', 'high-risk'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },
  {
    id: 'DPDPA-DPIA-002',
    title: 'Capture and remediate risks identified in the DPIA',
    domain: 'DPIA',
    severity: 'high',
    obligation:
      'Risks identified in a DPIA must be tracked to closure with an owner, a remediation plan, and a re-assessment after remediation.',
    citations: [{ instrument: 'DPDPR-2025', reference: 'Rule 13' }],
    evidenceRequired: [{ type: 'log', description: 'DPIA risk register + closure evidence' }],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt: 'Are DPIA findings tracked in a risk register with owners and closure dates?',
        type: 'boolean',
        evidenceTypes: ['log', 'document'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 18, maxPenaltyINR: 5_00_00_000 },
    remediationPatterns: ['review', 'reporting'],
    tags: ['high-risk'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },

  // ─────────────────────────────────────────────────────────────────────
  // GOV — additional governance controls
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'DPDPA-GOV-004',
    title: 'Maintain a current org chart of data processing responsibilities',
    domain: 'GOV',
    severity: 'low',
    obligation:
      'Roles and responsibilities for privacy must be visible and current — who decides purposes, who signs off on processors, who handles DSARs, who is on the breach call.',
    citations: [{ instrument: 'DPDPA-2023', reference: 'Section 8' }],
    evidenceRequired: [{ type: 'document', description: 'RACI / org chart for privacy' }],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt: 'Is there a current RACI or org chart for privacy responsibilities?',
        type: 'boolean',
        evidenceTypes: ['document'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 5, maxPenaltyINR: 2_00_00_000 },
    remediationPatterns: ['policy'],
    tags: ['governance'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },
  {
    id: 'DPDPA-GOV-005',
    title: 'Conduct annual privacy training for staff handling personal data',
    domain: 'GOV',
    severity: 'medium',
    obligation:
      'Personnel handling personal data must receive privacy training on induction and at least annually thereafter, with completion recorded.',
    citations: [{ instrument: 'DPDPA-2023', reference: 'Section 8(5)' }],
    evidenceRequired: [{ type: 'log', description: 'Training records with completion status' }],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt: 'Do all staff handling personal data receive annual privacy training?',
        type: 'boolean',
        evidenceTypes: ['log'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 10, maxPenaltyINR: 2_00_00_000 },
    remediationPatterns: ['training', 'policy'],
    tags: ['always-applies', 'training'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },

  // ─────────────────────────────────────────────────────────────────────
  // BRCH — additional breach controls
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'DPDPA-BRCH-003',
    title: 'Designate a breach response owner with a documented playbook',
    domain: 'BRCH',
    severity: 'high',
    obligation:
      'A named individual must own breach response end-to-end, with a documented playbook covering detection → triage → notification → post-mortem, exercised at least annually.',
    citations: [{ instrument: 'DPDPA-2023', reference: 'Section 8(6)' }],
    evidenceRequired: [
      { type: 'document', description: 'Breach response playbook' },
      { type: 'attestation', description: 'Tabletop exercise record' },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt: 'Is there a named breach response owner and a current playbook?',
        type: 'boolean',
        evidenceTypes: ['document'],
        dependsOn: [],
      },
      {
        id: 'Q2',
        prompt: 'Has a tabletop exercise been run in the past 12 months?',
        type: 'boolean',
        evidenceTypes: ['attestation'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 18, maxPenaltyINR: 5_00_00_000 },
    remediationPatterns: ['breach-process', 'policy'],
    tags: ['always-applies'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },

  // ─────────────────────────────────────────────────────────────────────
  // RCD — additional record-keeping
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'DPDPA-RCD-003',
    title: 'Map and document data flows to processors and sub-processors',
    domain: 'RCD',
    severity: 'high',
    obligation:
      'Beyond the RoPA, a working data-flow map (system-of-systems diagram) showing personal data movement — including to sub-processors — must be available for the Board and any DPB inquiry.',
    citations: [{ instrument: 'DPDPR-2025', reference: 'Rule 8 and Third Schedule' }],
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
    tags: ['always-applies'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },

  // ─────────────────────────────────────────────────────────────────────
  // XBR — additional cross-border controls
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'DPDPA-XBR-003',
    title: 'Conduct a transfer impact assessment for high-risk destinations',
    domain: 'XBR',
    severity: 'medium',
    obligation:
      'For transfers to jurisdictions with materially different data protection regimes, a transfer impact assessment should be completed to demonstrate that the receiving environment provides comparable protection.',
    citations: [{ instrument: 'DPDPA-2023', reference: 'Section 16' }],
    evidenceRequired: [{ type: 'document', description: 'TIA per high-risk destination' }],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt:
          'Have you completed a transfer impact assessment for each cross-border destination with weaker protection?',
        type: 'boolean',
        evidenceTypes: ['document'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 12, maxPenaltyINR: 5_00_00_000 },
    remediationPatterns: ['vendor-risk', 'policy'],
    tags: ['cross-border'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },

  // ─────────────────────────────────────────────────────────────────────
  // SEC — additional security controls
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'DPDPA-SEC-006',
    title: 'Securely dispose of media and devices containing personal data',
    domain: 'SEC',
    severity: 'medium',
    obligation:
      'Media and devices containing personal data, including at end-of-life, must be securely wiped or destroyed with a documented process and certificate of destruction where applicable.',
    citations: [{ instrument: 'DPDPA-2023', reference: 'Section 8(5)' }],
    evidenceRequired: [
      {
        type: 'document',
        description: 'Media sanitisation policy + certificate of destruction register',
      },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt:
          'Is there a documented media sanitisation process and a register of end-of-life destructions?',
        type: 'boolean',
        evidenceTypes: ['document'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 8, maxPenaltyINR: 2_00_00_000 },
    remediationPatterns: ['policy', 'config'],
    tags: ['always-applies', 'ops'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },
  {
    id: 'DPDPA-SEC-007',
    title: 'Operate an incident response capability with rehearsed playbook',
    domain: 'SEC',
    severity: 'high',
    obligation:
      'Beyond breach notification, an operational incident response capability — on-call, escalation, runbook, post-mortem — is necessary to meet the 72-hour clock in practice, not just in policy.',
    citations: [{ instrument: 'DPDPA-2023', reference: 'Section 8(5), 8(6)' }],
    evidenceRequired: [
      { type: 'document', description: 'Incident response runbook + on-call roster' },
      { type: 'log', description: 'Tabletop exercise record' },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt: 'Do you have an on-call rotation and runbook for security incidents?',
        type: 'boolean',
        evidenceTypes: ['document', 'attestation'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 18, maxPenaltyINR: 5_00_00_000 },
    remediationPatterns: ['breach-process', 'policy', 'training'],
    tags: ['always-applies'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },

  // ─────────────────────────────────────────────────────────────────────
  // DAT — additional rights controls
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'DPDPA-DAT-005',
    title: 'Verify the identity of a data principal before acting on rights requests',
    domain: 'DAT',
    severity: 'medium',
    obligation:
      'Identity verification proportional to the sensitivity of the request is required before acting on access, correction, or erasure requests, to prevent unauthorised disclosure.',
    citations: [{ instrument: 'DPDPR-2025', reference: 'Rule 14' }],
    evidenceRequired: [{ type: 'document', description: 'Identity verification procedure' }],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt:
          'Do you verify the identity of the data principal before fulfilling rights requests?',
        type: 'boolean',
        evidenceTypes: ['document', 'attestation'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 10, maxPenaltyINR: 2_00_00_000 },
    remediationPatterns: ['policy', 'config'],
    tags: ['always-applies', 'rights'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },
  {
    id: 'DPDPA-DAT-006',
    title: 'Provide data portability in a structured, commonly used format',
    domain: 'DAT',
    severity: 'medium',
    obligation:
      'On request, the data principal is entitled to receive a copy of their personal data in a structured, commonly used and machine-readable format (Section 11(2)).',
    citations: [{ instrument: 'DPDPA-2023', reference: 'Section 11(2)' }],
    evidenceRequired: [
      {
        type: 'config',
        description: 'Export pipeline producing JSON / CSV in a documented schema',
      },
    ],
    assessmentQuestions: [
      {
        id: 'Q1',
        prompt: "Can you export a user's data in a structured, machine-readable format on request?",
        type: 'boolean',
        evidenceTypes: ['config', 'log'],
        dependsOn: [],
      },
    ],
    scoring: { baseline: 0, weight: 1, penaltyPoints: 10, maxPenaltyINR: 2_00_00_000 },
    remediationPatterns: ['data-portability', 'config'],
    tags: ['always-applies', 'rights'],
    sdfOnly: false,
    childrenOnly: false,
    introducedInVersion: '0.1.0',
  },
];

/**
 * W7.3 (QUA-3): derived from the array, never asserted against a literal.
 *
 * The count was hardcoded as 46 and merely *checked* against the array, so the
 * two could only ever agree or throw — while six other places in the repo
 * carried their own literals (43 on the dashboard, 48 in the reports client,
 * "forty-three" in the PRD, 43 in three docs). A client could see three
 * different totals for the same library. Every consumer now reads this, and
 * `scripts/check-control-count.sh` fails CI on any hardcoded count elsewhere.
 */
export const CONTROL_LIBRARY_COUNT = controls.length;

/**
 * Distinct domains represented in the library. Derived for the same reason as
 * the count — the reports client claimed "14 DPDPA domains" against a library
 * with 13.
 */
export const CONTROL_LIBRARY_DOMAIN_COUNT = new Set(controls.map((c) => c.domain)).size;

/**
 * Sanity: ensure the totals are correct and the library is self-consistent.
 * Throw at module load if invariants are violated — better to catch at build
 * time than to ship an inconsistent library.
 */
export function validateLibrary(): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const seen = new Set<string>();
  let totalWeight = 0;

  for (const c of controls) {
    if (seen.has(c.id)) errors.push(`Duplicate control id: ${c.id}`);
    seen.add(c.id);
    if (c.scoring.weight < 0 || c.scoring.weight > 1) {
      errors.push(`${c.id}: weight out of [0,1] range`);
    }
    totalWeight += c.scoring.weight;
  }

  // The count is derived, so there is nothing to cross-check it against. What
  // is worth asserting is that the library is not empty and every control
  // carries a citation — an uncited control in a compliance library is a claim
  // with no authority behind it.
  if (controls.length === 0) {
    errors.push('Control library is empty');
  }
  for (const c of controls) {
    if (c.citations.length === 0) {
      errors.push(`${c.id}: has no statutory citation`);
    }
  }

  // Domain coverage check. Weights are per-control values (the v0.1.0
  // source uses 1.0 for each control), so summing a domain to 1 would be an
  // invalid invariant and would reject the published library.
  const domainWeights: Record<string, number> = {};
  for (const c of controls) {
    domainWeights[c.domain] = (domainWeights[c.domain] ?? 0) + c.scoring.weight;
  }
  for (const [d, w] of Object.entries(domainWeights)) {
    if (w <= 0) {
      errors.push(`Domain ${d} has no positive scoring weight`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}
