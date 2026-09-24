import { describe, it, expect } from 'vitest';
import { controls, CONTROL_LIBRARY_COUNT, LIBRARY_VERSION, validateLibrary } from './controls';
import {
  BASELINE_INSTRUMENT_CODES,
  COMMENCEMENT,
  DPDP_RULES_2025,
  DPDP_SCHEDULES_2025,
  commencementFor,
  ruleByNumber,
  rulesCitedIn,
} from './regulatory-baseline';

/**
 * W7.1 · CTL-1 regression suite.
 *
 * CTL-1 was not a typo — it was a whole class of defect that nothing in the
 * codebase could detect, because nothing recorded what a citation had been
 * checked against. 21 of 24 Rules citations pointed at the wrong rule for a
 * year, and every report generated in that year cited the wrong law.
 *
 * These tests are the vaccine. A citation naming a rule that does not exist,
 * or a rule whose subject does not match the control's domain, now fails the
 * build rather than reaching a client report.
 */

type Citation = { instrument: string; reference: string };

const dpdprCitations: Array<{ id: string; domain: string; citation: Citation }> = controls.flatMap(
  (c) =>
    c.citations
      .filter((cit) => cit.instrument === 'DPDPR-2025')
      .map((citation) => ({ id: c.id, domain: c.domain, citation })),
);

describe('the notified Rules table matches the Gazette', () => {
  it('has exactly 23 rules', () => {
    expect(DPDP_RULES_2025).toHaveLength(23);
  });

  it('has exactly 7 schedules', () => {
    expect(DPDP_SCHEDULES_2025).toHaveLength(7);
  });

  it('numbers the rules 1..23 with no gaps', () => {
    expect(DPDP_RULES_2025.map((r) => r.rule)).toEqual(Array.from({ length: 23 }, (_, i) => i + 1));
  });

  // Rule 1(2)-(4), as corrected by G.S.R. 892(E). A widely-cited explainer
  // lists Rule 16 in the "in force now" group; the Gazette does not, and
  // treating the research exemption as live would wave through processing that
  // has no exemption until 2027.
  it('commences rules 1, 2 and 17 to 21 on publication', () => {
    for (const rule of [1, 2, 17, 18, 19, 20, 21]) {
      expect(commencementFor(rule)).toBe(COMMENCEMENT.onPublication);
    }
  });

  it('commences rule 4 one year after publication', () => {
    expect(commencementFor(4)).toBe(COMMENCEMENT.oneYear);
  });

  it('commences rules 3, 5 to 16, 22 and 23 eighteen months after publication', () => {
    for (const rule of [3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 22, 23]) {
      expect(commencementFor(rule)).toBe(COMMENCEMENT.eighteenMonths);
    }
  });

  it('is not fooled into commencing rule 16 early', () => {
    expect(commencementFor(16)).toBe(COMMENCEMENT.eighteenMonths);
    expect(commencementFor(16)).not.toBe(COMMENCEMENT.onPublication);
  });

  it('dates the commencement clock from 13 November 2025', () => {
    // The Gazette issue is dated the 13th. The library header previously said
    // 14 November, which made every derived date wrong by a day.
    expect(COMMENCEMENT.onPublication).toBe('2025-11-13');
    expect(COMMENCEMENT.oneYear).toBe('2026-11-13');
    expect(COMMENCEMENT.eighteenMonths).toBe('2027-05-13');
  });
});

describe('CTL-1 · every Rules citation names a rule that exists', () => {
  it('cites at least one rule per DPDPR-2025 citation', () => {
    expect(dpdprCitations.length).toBeGreaterThan(0);
  });

  it.each(dpdprCitations)('$id cites a real rule in "$citation.reference"', ({ citation }) => {
    const cited = rulesCitedIn(citation.reference);
    expect(cited.length).toBeGreaterThan(0);
    for (const n of cited) {
      expect(ruleByNumber(n), `Rule ${n} does not exist in G.S.R. 846(E)`).toBeDefined();
    }
  });

  it('never cites a rule number above 23', () => {
    // The draft numbering ran higher than the notified one, which is how the
    // library ended up citing "Rule 24".
    for (const { id, citation } of dpdprCitations) {
      for (const n of rulesCitedIn(citation.reference)) {
        expect(n, `${id} cites Rule ${n}`).toBeLessThanOrEqual(23);
      }
    }
  });

  it('cites only named schedules that exist', () => {
    const names = new Set(DPDP_SCHEDULES_2025.map((s) => s.ref));
    const pattern = /(First|Second|Third|Fourth|Fifth|Sixth|Seventh) Schedule/g;
    for (const { id, citation } of dpdprCitations) {
      for (const match of citation.reference.matchAll(pattern)) {
        expect(names.has(match[0]), `${id} cites unknown ${match[0]}`).toBe(true);
      }
    }
  });
});

describe('CTL-1 · citations match the subject of the control', () => {
  /**
   * The specific mis-mappings that shipped. Each of these was a control
   * citing a rule about something else entirely — Board salaries cited as the
   * authority for data-principal rights, child-data exemptions cited for SDF
   * audit duties. Pinning them stops a regression reintroducing the draft
   * numbering wholesale.
   */
  const EXPECTED: Record<string, number[]> = {
    'DPDPA-GOV-002': [3], // notice content, not Rule 5 (State processing)
    'DPDPA-GOV-003': [6], // reasonable security safeguards
    'DPDPA-CNS-001': [3],
    'DPDPA-CNS-002': [3],
    'DPDPA-CNS-003': [4], // Consent Manager duties + First Schedule
    'DPDPA-CNS-005': [3],
    'DPDPA-DAT-001': [14], // rights of Data Principals, not Rule 16 (research)
    'DPDPA-DAT-002': [14], // not Rule 17 (Board appointment)
    'DPDPA-DAT-003': [14], // not Rule 18 (Board salaries)
    'DPDPA-DAT-005': [14],
    'DPDPA-RCD-001': [8], // retention + Third Schedule, not Rule 21 (Board staff)
    'DPDPA-RCD-002': [6], // logs and monitoring
    'DPDPA-RCD-003': [8],
    'DPDPA-BRCH-001': [7], // breach intimation, not Rule 19/20 (Board meetings)
    'DPDPA-BRCH-002': [7],
    'DPDPA-XBR-001': [15], // transfer outside India, not Rule 13 (SDF)
    'DPDPA-CHD-001': [10], // was already correct
    'DPDPA-CHD-002': [10], // was already correct
    'DPDPA-SDF-001': [13], // SDF duties, not Rule 11 (persons with disabilities)
    'DPDPA-SDF-002': [13],
    'DPDPA-SDF-003': [13],
    'DPDPA-SEC-001': [6], // security safeguards, not Rule 14/15
    'DPDPA-DPIA-001': [13], // annual DPIA is an SDF duty
    'DPDPA-DPIA-002': [13], // annual audit is an SDF duty
  };

  it.each(Object.entries(EXPECTED))('%s cites the correct rule', (id, expectedRules) => {
    const control = controls.find((c) => c.id === id);
    expect(control, `${id} not found`).toBeDefined();
    const cited = control!.citations
      .filter((c) => c.instrument === 'DPDPR-2025')
      .flatMap((c) => rulesCitedIn(c.reference));
    expect(cited).toEqual(expectedRules);
  });

  it('covers every DPDPR-2025 citation in the library', () => {
    // If a control gains a Rules citation, it must be pinned here too —
    // otherwise the next re-map drifts silently, exactly as this one did.
    const cited = new Set(dpdprCitations.map((c) => c.id));
    expect([...cited].sort()).toEqual(Object.keys(EXPECTED).sort());
  });
});

describe('CTL-1 · the prose agrees with the citation beside it', () => {
  /**
   * The rule numbers embedded in `obligation` text, which is what a client
   * actually reads in a report.
   *
   * W7.1 corrected the structured `citations` array and left these behind, so
   * twelve controls named one rule in their metadata and a different one in
   * their own sentence — Rule 16 in the text, Rule 14 in the citation, for the
   * same obligation. The control-count gate could never see it: it compares
   * totals, and the totals matched throughout.
   */
  const rulesIn = (text: string) =>
    new Set((text.match(/Rule (\d+)/g) ?? []).map((m) => m.replace('Rule ', '')));

  const citedRules = (c: (typeof controls)[number]) =>
    new Set(
      c.citations
        .filter((cite) => cite.instrument === 'DPDPR-2025')
        .flatMap((cite) =>
          (cite.reference.match(/Rule (\d+)/g) ?? []).map((m) => m.replace('Rule ', '')),
        ),
    );

  it.each(controls.filter((c) => rulesIn(c.obligation).size > 0).map((c) => [c.id, c] as const))(
    '%s cites the same rule in its text as in its metadata',
    (_id, control) => {
      const prose = [...rulesIn(control.obligation)].sort();
      const cited = [...citedRules(control)].sort();
      // A control may cite rules it does not name in prose; it must not name a
      // rule in prose that its citations contradict.
      expect(cited.length, 'prose names a Rule but nothing cites one').toBeGreaterThan(0);
      expect(prose).toEqual(cited);
    },
  );
});

describe('library metadata', () => {
  it('is published as 0.1.1 — a PATCH, so assessments stay comparable', () => {
    expect(LIBRARY_VERSION).toBe('0.1.1');
  });

  it('derives the control count rather than asserting a literal (QUA-3)', () => {
    expect(CONTROL_LIBRARY_COUNT).toBe(controls.length);
  });

  it('declares the baseline instruments', () => {
    expect(BASELINE_INSTRUMENT_CODES).toEqual(['DPDPA-2023', 'GSR-846E', 'GSR-892E']);
  });

  it('passes its own validation', () => {
    expect(validateLibrary()).toEqual({ ok: true });
  });
});
