/**
 * Legal registry for candidate control library 0.2.0.
 *
 * Records the official primary sources the 0.2.0 corrections rest on, the
 * phased commencement of the Act under G.S.R. 843(E) and of the Rules under
 * Rule 1(2)–(4), and the legal classification of each corrected control.
 *
 * Verification provenance: the URLs, SHA-256 digests and paragraph references
 * below were taken from an independent read-only legal oracle run on
 * 2026-10-16 against the MeitY-hosted PDFs, and re-checked against the
 * retained text extracts on 2026-10-17. This is engineering verification, not
 * legal sign-off: `legalSignOff` stays 'pending' until a human records it.
 *
 * Nothing here alters published 0.1.1. The registry describes 0.2.0 only.
 */
import { COMMENCEMENT } from '../../regulatory-baseline';

export interface OfficialSource {
  code: 'DPDPA-2023' | 'GSR-846E' | 'GSR-843E';
  title: string;
  url: string;
  sha256: string;
  accessedOn: string;
}

export const OFFICIAL_SOURCES_0_2_0: readonly OfficialSource[] = [
  {
    code: 'DPDPA-2023',
    title: 'Digital Personal Data Protection Act, 2023 (22 of 2023)',
    url: 'https://www.meity.gov.in/static/uploads/2024/06/2bf1f0e9f04e6fb4f8fef35e82c42aa5.pdf',
    sha256: '4deb23981d3010c8225a2ff6149e7243dc2268455b299e283afebdd7b72a7d15',
    accessedOn: '2026-10-16',
  },
  {
    code: 'GSR-846E',
    title: 'Digital Personal Data Protection Rules, 2025 — G.S.R. 846(E)',
    url: 'https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf',
    sha256: 'eabc7d05e013144615d78ddc0e8b9c9aac1920e814f4fad38ce6560951f5aa08',
    accessedOn: '2026-10-16',
  },
  {
    code: 'GSR-843E',
    title: 'Commencement of the DPDP Act, 2023 — G.S.R. 843(E), 13 November 2025',
    url: 'https://www.meity.gov.in/static/uploads/2025/11/c56ceae6c383460ca69577428d36828b.pdf',
    sha256: '6df25cd8c76ac8eb18cae81835d51d51128ffbf2ed13262843395efddf0998e5',
    accessedOn: '2026-10-16',
  },
];

export type CommencementGroup = 'on_publication' | 'one_year' | 'eighteen_months';

const GROUP_DATE: Readonly<Record<CommencementGroup, string>> = {
  on_publication: COMMENCEMENT.onPublication,
  one_year: COMMENCEMENT.oneYear,
  eighteen_months: COMMENCEMENT.eighteenMonths,
};

/**
 * Act commencement under G.S.R. 843(E) (PDF page 2):
 *  (a) on publication: s.1(2), s.2, ss.18–26, ss.35, 38–43, s.44(1) and (3);
 *  (b) one year: s.6(9) and s.27(1)(d);
 *  (c) eighteen months: ss.3–5, s.6(1)–(8) and (10), ss.7–10, ss.11–17,
 *      s.27 except (1)(d), ss.28–34, 36, 37 and s.44(2).
 * Returns null for a section the notification does not name.
 */
export function actSectionCommencement(reference: string): CommencementGroup | null {
  const m = /^\s*(\d+)((?:\([0-9a-z]+\))*)/i.exec(reference);
  if (!m) return null;
  const section = Number(m[1]);
  const sub = m[2] ?? '';
  if (section === 1) return sub.startsWith('(2)') ? 'on_publication' : null;
  if (section === 2) return 'on_publication';
  if (section === 6 && sub.startsWith('(9)')) return 'one_year';
  if (section === 27 && sub.startsWith('(1)(d)')) return 'one_year';
  if (section === 44) {
    if (sub.startsWith('(2)')) return 'eighteen_months';
    if (sub.startsWith('(1)') || sub.startsWith('(3)')) return 'on_publication';
    return null;
  }
  if (section >= 18 && section <= 26) return 'on_publication';
  if ([35, 38, 39, 40, 41, 42, 43].includes(section)) return 'on_publication';
  if (section >= 3 && section <= 17) return 'eighteen_months';
  if (section >= 27 && section <= 34) return 'eighteen_months';
  if (section === 36 || section === 37) return 'eighteen_months';
  return null;
}

/** Rule commencement under Rule 1(2)–(4) of G.S.R. 846(E). */
export function ruleCommencement(rule: number): CommencementGroup | null {
  if (!Number.isInteger(rule) || rule < 1 || rule > 23) return null;
  if (rule === 1 || rule === 2 || (rule >= 17 && rule <= 21)) return 'on_publication';
  if (rule === 4) return 'one_year';
  return 'eighteen_months';
}

const SCHEDULE_RULE: Readonly<Record<string, number>> = {
  First: 4,
  Second: 5,
  Third: 8,
  Fourth: 12,
  Fifth: 18,
  Sixth: 21,
  Seventh: 23,
};

export interface CitedProvisionCommencement {
  instrument: string;
  reference: string;
  /** null when the provision is outside the DPDP commencement notifications. */
  group: CommencementGroup | null;
  commencesOn: string | null;
}

/** Commencement for each provision named in one citation reference. */
export function citationCommencement(
  instrument: string,
  reference: string,
): CitedProvisionCommencement[] {
  const out: CitedProvisionCommencement[] = [];
  const push = (provision: string, group: CommencementGroup | null) =>
    out.push({
      instrument,
      reference: provision,
      group,
      commencesOn: group ? GROUP_DATE[group] : null,
    });
  if (instrument === 'DPDPA-2023') {
    const body = reference.replace(/^Sections?\s*/i, '');
    for (const part of body.split(/,|\band\b/)) {
      const trimmed = part.trim();
      if (trimmed) push(`Section ${trimmed}`, actSectionCommencement(trimmed));
    }
  } else if (instrument === 'DPDPR-2025') {
    for (const m of reference.matchAll(/Rules?\s+(\d+(?:\([0-9a-z]+\))*)/g))
      push(`Rule ${m[1]}`, ruleCommencement(Number(/^\d+/.exec(m[1]!)![0])));
    for (const m of reference.matchAll(/(First|Second|Third|Fourth|Fifth|Sixth|Seventh) Schedule/g))
      push(m[0], ruleCommencement(SCHEDULE_RULE[m[1]!]!));
  } else {
    push(reference, null);
  }
  if (out.length === 0) push(reference, null);
  return out;
}

/** Legal character of a control's primary obligation in 0.2.0. */
export type LegalBasis =
  /** The cited text expressly imposes the duty on every Data Fiduciary. */
  | 'express_statutory'
  /** The duty binds only an entity meeting a named statutory condition. */
  | 'statutory_conditional'
  /** Accountability or evidence practice; not an express statutory duty. */
  | 'organisation_policy';

export type ApplicabilityCondition = 'registered_consent_manager';

export interface ControlLegalRecord {
  controlId: string;
  legalBasis: LegalBasis;
  /** Questions that apply only when the named condition holds. */
  conditionalQuestions: readonly { questionId: string; condition: ApplicabilityCondition }[];
  /** Official-source paragraph references the 0.2.0 wording rests on. */
  primarySources: readonly {
    source: OfficialSource['code'];
    pdfPageOneBased: number;
    paragraph: string;
  }[];
  /** Oracle finding status this record corrects. */
  correctsFinding: string;
  /** Legal penalty inference from this control requires owner scoring review. */
  statutoryPenaltyInference: 'permitted' | 'not_permitted_pending_owner_scoring_review';
}

/** Records for the six controls corrected in 0.2.0. */
export const CORRECTED_CONTROL_RECORDS_0_2_0: readonly ControlLegalRecord[] = [
  {
    controlId: 'DPDPA-CNS-003',
    legalBasis: 'express_statutory',
    conditionalQuestions: [{ questionId: 'Q3', condition: 'registered_consent_manager' }],
    primarySources: [
      { source: 'DPDPA-2023', pdfPageOneBased: 6, paragraph: 'Section 6(10)' },
      {
        source: 'GSR-846E',
        pdfPageOneBased: 33,
        paragraph: 'Rule 4; First Schedule Part B items 3 and 4(c)',
      },
    ],
    correctsFinding: 'confirmed_scope_error',
    statutoryPenaltyInference: 'permitted',
  },
  {
    controlId: 'DPDPA-DAT-003',
    legalBasis: 'express_statutory',
    conditionalQuestions: [],
    primarySources: [
      { source: 'DPDPA-2023', pdfPageOneBased: 10, paragraph: 'Section 13(1)–(2)' },
      { source: 'GSR-846E', pdfPageOneBased: 30, paragraph: 'Rule 14(3)' },
    ],
    correctsFinding: 'confirmed_incorrect_statutory_deadline',
    statutoryPenaltyInference: 'permitted',
  },
  {
    controlId: 'DPDPA-BRCH-002',
    legalBasis: 'express_statutory',
    conditionalQuestions: [],
    primarySources: [{ source: 'GSR-846E', pdfPageOneBased: 26, paragraph: 'Rule 7(1) and 7(2)' }],
    correctsFinding: 'confirmed_unsupported_harm_threshold',
    statutoryPenaltyInference: 'permitted',
  },
  {
    controlId: 'DPDPA-RCD-001',
    legalBasis: 'organisation_policy',
    conditionalQuestions: [],
    primarySources: [
      { source: 'DPDPA-2023', pdfPageOneBased: 7, paragraph: 'Section 8(1)' },
      { source: 'GSR-846E', pdfPageOneBased: 27, paragraph: 'Rule 8(1)–(3) and Third Schedule' },
    ],
    correctsFinding: 'confirmed_unsupported_direct_citation',
    statutoryPenaltyInference: 'not_permitted_pending_owner_scoring_review',
  },
  {
    controlId: 'DPDPA-RCD-003',
    legalBasis: 'organisation_policy',
    conditionalQuestions: [],
    primarySources: [
      { source: 'DPDPA-2023', pdfPageOneBased: 7, paragraph: 'Section 8(1)' },
      { source: 'GSR-846E', pdfPageOneBased: 27, paragraph: 'Rule 8(1)–(3) and Third Schedule' },
    ],
    correctsFinding: 'confirmed_unsupported_direct_citation (related to RCD-001)',
    statutoryPenaltyInference: 'not_permitted_pending_owner_scoring_review',
  },
  {
    controlId: 'DPDPA-DAT-006',
    legalBasis: 'organisation_policy',
    conditionalQuestions: [],
    primarySources: [
      { source: 'DPDPA-2023', pdfPageOneBased: 9, paragraph: 'Section 11(1) and 11(2)' },
      { source: 'GSR-846E', pdfPageOneBased: 33, paragraph: 'First Schedule Part B item 4(b)' },
    ],
    correctsFinding: 'confirmed_previously_known_approved_versioned_correction',
    statutoryPenaltyInference: 'not_permitted_pending_owner_scoring_review',
  },
];

export const LEGAL_REVIEW_0_2_0 = {
  oracleAsOf: '2026-10-16',
  engineeringRecheckedOn: '2026-10-17',
  ownerScopeApproval: 'recorded (session log e385)',
  legalSignOff: 'pending',
  excludedUnverified: ['October 2026 Removal of Difficulties Order S.O. 5458(E)'],
} as const;
