/**
 * Axiom Proof — Regulatory baseline (W7.0)
 *
 * The control library is the definition of what compliance *means*: the
 * baseline every assessment, finding, penalty estimate and client report is
 * computed against. Before this module it had no recorded relationship to the
 * law it claims to implement — one free-text changelog, and no way to answer
 * "which gazette text was this control verified against, by whom, when?".
 *
 * That absence is why CTL-1 went unnoticed for a year: every `DPDPR-2025`
 * citation in the library was authored against the *draft* Rules numbering and
 * never re-mapped after notification, so generated reports cited the wrong rule
 * for breach notification, cross-border transfer, notice, retention and
 * data-principal rights. Nothing in the codebase could have detected it,
 * because nothing recorded what the citations were checked against.
 *
 * Everything below is quoted from, or verified against, the Gazette text. Where
 * a secondary explainer disagreed with the Gazette, the Gazette wins — one
 * widely-cited explainer lists Rule 16 as commencing on 13 Nov 2025, which is
 * wrong: Rule 1(2) commences Rules 1, 2 and 17 to 21, and Rule 16 does not
 * commence until 13 May 2027.
 */

/** An instrument's standing in the baseline. */
export type InstrumentStatus =
  | 'notified' // in the Gazette and operative (subject to commencement)
  | 'corrigendum' // corrects the printed text of another instrument
  | 'proposed' // announced or consulted on, NOT law
  | 'draft'
  | 'repealed';

export interface RegulatoryInstrument {
  /** Stable short code used in citations. */
  code: string;
  jurisdiction: 'IN';
  title: string;
  /** Gazette reference as printed. */
  gazetteRef: string;
  /** Date printed on the Gazette issue itself, not the date it was reported. */
  publishedOn: string;
  status: InstrumentStatus;
  sourceUrl: string;
  /** When a human last checked this record against the source. */
  verifiedOn: string;
  verifiedBy: string;
  /** The instrument this one amends, if any. */
  amends?: string;
  notes?: string;
}

/**
 * The instruments in the declared baseline.
 *
 * On the 13-vs-14 November question: reputable secondary sources report
 * 14 November 2025, because that is when MeitY announced the notifications.
 * The Gazette issue (No. 760) is itself dated 13 November 2025, and Rule 1(2)
 * commences on "the date of their publication in the Official Gazette" — so
 * the operative date, and every date computed from it, runs from the 13th.
 * The library header previously said 14 November, which also made its derived
 * enforcement date wrong by a day.
 */
export const REGULATORY_INSTRUMENTS: readonly RegulatoryInstrument[] = [
  {
    code: 'DPDPA-2023',
    jurisdiction: 'IN',
    title: 'Digital Personal Data Protection Act, 2023',
    gazetteRef: 'Act 22 of 2023',
    publishedOn: '2023-08-11',
    status: 'notified',
    sourceUrl: 'https://www.meity.gov.in/data-protection-framework',
    verifiedOn: '2026-09-20',
    verifiedBy: 'Axiom Minds · Founder',
    notes: 'Primary legislation. Brought into force in stages alongside the Rules.',
  },
  {
    code: 'GSR-846E',
    jurisdiction: 'IN',
    title: 'Digital Personal Data Protection Rules, 2025',
    gazetteRef: 'G.S.R. 846(E), Gazette No. 760',
    publishedOn: '2025-11-13',
    status: 'notified',
    sourceUrl: 'https://dpdprules.org/rules/1',
    verifiedOn: '2026-09-20',
    verifiedBy: 'Axiom Minds · Founder',
    notes:
      '23 rules and 7 schedules. The publication date is printed on Gazette issue No. 760, ' +
      'so it is an official fact rather than a computed one.',
  },
  {
    code: 'GSR-892E',
    jurisdiction: 'IN',
    title: 'Corrigenda to the Digital Personal Data Protection Rules, 2025',
    gazetteRef: 'G.S.R. 892(E)',
    publishedOn: '2025-12-11',
    status: 'corrigendum',
    amends: 'GSR-846E',
    sourceUrl: 'https://dpdprules.org/rules/1',
    verifiedOn: '2026-09-20',
    verifiedBy: 'Axiom Minds · Founder',
    notes:
      'Non-substantive. Items (i)(a) and (i)(b) amend rule 1(3) and 1(4), reading ' +
      '"in the Official Gazette" for "of this Gazette". Commencement dates unchanged. ' +
      'This is precisely why the change model has to record change TYPE: the corrigendum ' +
      'did amend the Rules, and it must not invalidate a single assessment.',
  },
];

/**
 * Tracked but deliberately EXCLUDED from the compliance baseline.
 *
 * A proposal is not law. Clients need to plan for it, so it drives a "what-if"
 * posture view, but it must never contaminate a compliance score — a report
 * that assessed against a proposal would be assessing against nothing.
 */
export const PROPOSED_INSTRUMENTS: readonly RegulatoryInstrument[] = [
  {
    code: 'MEITY-12MO-PROPOSAL',
    jurisdiction: 'IN',
    title: 'MeitY proposal to shorten the 18-month window to 12 months',
    gazetteRef: '— (not notified)',
    publishedOn: '2026-01-01',
    status: 'proposed',
    sourceUrl: 'https://dpdprules.org/blog/dpdp-deadline-18-months-to-12-months',
    verifiedOn: '2026-09-20',
    verifiedBy: 'Axiom Minds · Founder',
    notes:
      'Would move the core compliance date from 13 May 2027 to 13 Nov 2026. ' +
      'Excluded from scoring; drives the what-if view only.',
  },
];

/** The frozen, named instrument set this library version is assessed against. */
export const BASELINE_CODE = 'IN-DPDP@2026-09-20';
export const BASELINE_DECLARED_ON = '2026-09-20';
export const BASELINE_DECLARED_BY = 'Axiom Minds · Founder';
export const BASELINE_INSTRUMENT_CODES = ['DPDPA-2023', 'GSR-846E', 'GSR-892E'] as const;

/**
 * Commencement, per rule 1 as corrected by G.S.R. 892(E).
 *
 * Rule 1 is more than a control: the staggered commencement is the readiness
 * clock the product sells against. A control that is not yet in force is not a
 * finding today, and conflating the two either alarms a client about an
 * obligation that does not yet bind them or lets them miss one that does.
 */
export const COMMENCEMENT = {
  /** Rules 1, 2 and 17 to 21 — on publication. */
  onPublication: '2025-11-13',
  /** Rule 4 — one year after publication. */
  oneYear: '2026-11-13',
  /** Rules 3, 5 to 16, 22 and 23 — eighteen months after publication. */
  eighteenMonths: '2027-05-13',
} as const;

/** Which commencement group a rule falls in. Derived from rule 1(2)–(4). */
export function commencementFor(ruleNumber: number): string {
  if (ruleNumber === 1 || ruleNumber === 2 || (ruleNumber >= 17 && ruleNumber <= 21)) {
    return COMMENCEMENT.onPublication;
  }
  if (ruleNumber === 4) return COMMENCEMENT.oneYear;
  // Rules 3, 5–16, 22, 23.
  return COMMENCEMENT.eighteenMonths;
}

export interface RegulatoryProvision {
  /** Citation reference exactly as it should be printed. */
  ref: string;
  /** Rule number, for commencement lookup. */
  rule: number;
  /** Heading as printed in the Gazette. */
  heading: string;
  /** Named schedule this rule operates through, if any. */
  schedule?: string;
}

/**
 * The 23 rules of G.S.R. 846(E), with the headings as printed.
 *
 * Verified against the Gazette text on 2026-09-20. This is the table the
 * citation re-map is computed from, and the table CI checks every citation
 * against — so a citation naming a rule that does not exist, or whose subject
 * does not match the control, fails the build rather than reaching a client
 * report.
 */
export const DPDP_RULES_2025: readonly RegulatoryProvision[] = [
  { rule: 1, ref: 'Rule 1', heading: 'Short title and commencement' },
  { rule: 2, ref: 'Rule 2', heading: 'Definitions' },
  { rule: 3, ref: 'Rule 3', heading: 'Notice given by Data Fiduciary to Data Principal' },
  {
    rule: 4,
    ref: 'Rule 4',
    heading: 'Registration and obligations of Consent Manager',
    schedule: 'First Schedule',
  },
  {
    rule: 5,
    ref: 'Rule 5',
    heading:
      'Processing of personal data for provision or issue of subsidy, benefit, service, ' +
      'certificate, licence or permit by State and its instrumentalities',
    schedule: 'Second Schedule',
  },
  { rule: 6, ref: 'Rule 6', heading: 'Reasonable security safeguards' },
  { rule: 7, ref: 'Rule 7', heading: 'Intimation of personal data breach' },
  {
    rule: 8,
    ref: 'Rule 8',
    heading: 'Time period for specified purpose to be deemed as no longer being served',
    schedule: 'Third Schedule',
  },
  {
    rule: 9,
    ref: 'Rule 9',
    heading: 'Contact information of person to answer questions about processing',
  },
  {
    rule: 10,
    ref: 'Rule 10',
    heading: 'Verifiable consent for processing of personal data of child',
  },
  {
    rule: 11,
    ref: 'Rule 11',
    heading:
      'Verifiable consent for processing of personal data of person with disability who has ' +
      'lawful guardian',
  },
  {
    rule: 12,
    ref: 'Rule 12',
    heading:
      'Exemptions from certain obligations applicable to processing of personal data of child',
    schedule: 'Fourth Schedule',
  },
  { rule: 13, ref: 'Rule 13', heading: 'Additional obligations of Significant Data Fiduciary' },
  { rule: 14, ref: 'Rule 14', heading: 'Rights of Data Principals' },
  { rule: 15, ref: 'Rule 15', heading: 'Transfer of personal data outside the territory of India' },
  {
    rule: 16,
    ref: 'Rule 16',
    heading: 'Exemption from Act for research, archiving or statistical purposes',
    schedule: 'Second Schedule',
  },
  { rule: 17, ref: 'Rule 17', heading: 'Appointment of Chairperson and other Members' },
  {
    rule: 18,
    ref: 'Rule 18',
    heading:
      'Salary, allowances and other terms and conditions of service of Chairperson and other Members',
    schedule: 'Fifth Schedule',
  },
  {
    rule: 19,
    ref: 'Rule 19',
    heading:
      'Procedure for meetings of Board and authentication of its orders, directions and instruments',
  },
  { rule: 20, ref: 'Rule 20', heading: 'Functioning of Board as digital office' },
  {
    rule: 21,
    ref: 'Rule 21',
    heading: 'Terms and conditions of appointment and service of officers and employees of Board',
    schedule: 'Sixth Schedule',
  },
  { rule: 22, ref: 'Rule 22', heading: 'Appeal to Appellate Tribunal' },
  {
    rule: 23,
    ref: 'Rule 23',
    heading: 'Calling for information from Data Fiduciary or intermediary',
    schedule: 'Seventh Schedule',
  },
];

/** The 7 schedules, as printed. */
export const DPDP_SCHEDULES_2025: readonly { ref: string; heading: string; underRule: number }[] = [
  {
    ref: 'First Schedule',
    heading: 'Registration and obligations of Consent Manager',
    underRule: 4,
  },
  {
    ref: 'Second Schedule',
    heading:
      'Standards for processing by State and its instrumentalities and for research, archiving ' +
      'or statistical purposes',
    underRule: 5,
  },
  { ref: 'Third Schedule', heading: 'Time periods for retention under rule 8', underRule: 8 },
  {
    ref: 'Fourth Schedule',
    heading: "Exemptions for processing of children's personal data",
    underRule: 12,
  },
  {
    ref: 'Fifth Schedule',
    heading: 'Terms and conditions of service of Chairperson and Members',
    underRule: 18,
  },
  {
    ref: 'Sixth Schedule',
    heading: 'Terms of appointment and service of Board officers and employees',
    underRule: 21,
  },
  {
    ref: 'Seventh Schedule',
    heading: 'Purposes and authorised persons for calling for information',
    underRule: 23,
  },
];

const RULE_BY_NUMBER = new Map(DPDP_RULES_2025.map((r) => [r.rule, r]));

/** Look up a rule by number. Returns undefined for a rule that does not exist. */
export function ruleByNumber(n: number): RegulatoryProvision | undefined {
  return RULE_BY_NUMBER.get(n);
}

/**
 * Parse the rule numbers out of a citation reference.
 *
 * Handles the shapes the library actually uses: "Rule 7", "Rule 13(2)",
 * "Rule 5, 6", "Rule 5(1)(a)".
 */
export function rulesCitedIn(reference: string): number[] {
  const withoutPrefix = reference.replace(/^Rules?\s*/i, '');
  const numbers = withoutPrefix.match(/\b\d+\b(?=\s*(\(|,|$|\s))/g) ?? [];
  // Only leading-position numbers are rule numbers; "13(2)" must not yield 2.
  const parts = withoutPrefix.split(',').map((p) => p.trim());
  const out: number[] = [];
  for (const part of parts) {
    const m = part.match(/^(\d+)/);
    if (m) out.push(Number(m[1]));
  }
  return out.length > 0 ? out : numbers.map(Number);
}
