import { describe, expect, it } from 'vitest';
import {
  buildLibrarySeed,
  buildLibrarySeedForVersion,
  commencementStatusAsOf,
  controls as controls_0_1_1,
  KNOWN_LIBRARY_VERSIONS,
  resolveControlLibrary,
  UnknownLibraryVersionError,
} from '../../index';
import { publishCatalogue } from '../../catalogue-publication';
import { ControlSchema } from '../../types';
import { ruleByNumber, rulesCitedIn } from '../../regulatory-baseline';
import { CORRECTED_CONTROL_IDS_0_2_0, controls_0_2_0, LIBRARY_VERSION_0_2_0 } from './controls';
import {
  actSectionCommencement,
  citationCommencement,
  CORRECTED_CONTROL_RECORDS_0_2_0,
  LEGAL_REVIEW_0_2_0,
  OFFICIAL_SOURCES_0_2_0,
  ruleCommencement,
} from './legal-registry';

const v2 = (id: string) => {
  const c = controls_0_2_0.find((x) => x.id === id);
  if (!c) throw new Error(id);
  return c;
};
const v1 = (id: string) => controls_0_1_1.find((x) => x.id === id)!;
const text = (id: string) =>
  [
    v2(id).title,
    v2(id).obligation,
    ...v2(id).assessmentQuestions.map((q) => q.prompt),
    ...v2(id).evidenceRequired.map((e) => e.description),
  ].join('\n');
const refs = (id: string) => v2(id).citations.map((c) => `${c.instrument} ${c.reference}`);

describe('0.2.0 is a separate, complete, valid catalogue', () => {
  it('is version 0.2.0, a candidate, with the same 46 control ids in the same order', () => {
    expect(LIBRARY_VERSION_0_2_0).toBe('0.2.0');
    expect(KNOWN_LIBRARY_VERSIONS).toEqual(['0.1.1', '0.2.0']);
    expect(resolveControlLibrary('0.2.0').status).toBe('candidate');
    expect(controls_0_2_0.map((c) => c.id)).toEqual(controls_0_1_1.map((c) => c.id));
  });

  it('every control satisfies the Control schema and carries a citation', () => {
    for (const c of controls_0_2_0) {
      expect(ControlSchema.safeParse(c).success, c.id).toBe(true);
      expect(c.citations.length, c.id).toBeGreaterThan(0);
    }
  });

  it('changes exactly the six approved controls and nothing else', () => {
    expect(CORRECTED_CONTROL_IDS_0_2_0).toEqual(
      [
        'DPDPA-BRCH-002',
        'DPDPA-CNS-003',
        'DPDPA-DAT-003',
        'DPDPA-DAT-006',
        'DPDPA-RCD-001',
        'DPDPA-RCD-003',
      ].sort(),
    );
    for (const c of controls_0_2_0) {
      const original = v1(c.id);
      if (CORRECTED_CONTROL_IDS_0_2_0.includes(c.id)) {
        expect(c.revisedInVersion).toBe('0.2.0');
        expect(c.introducedInVersion).toBe(original.introducedInVersion);
        expect(c.obligation).not.toBe(original.obligation);
      } else {
        expect(c).toEqual(original);
      }
    }
  });

  it('cites only rules that exist, and names no rule in prose that it does not cite', () => {
    const rulesIn = (s: string) => new Set((s.match(/Rule (\d+)/g) ?? []).map((m) => m.slice(5)));
    for (const c of controls_0_2_0) {
      const cited = new Set<string>();
      for (const cit of c.citations.filter((x) => x.instrument === 'DPDPR-2025'))
        for (const n of rulesCitedIn(cit.reference)) {
          expect(ruleByNumber(n), `${c.id} Rule ${n}`).toBeDefined();
          cited.add(String(n));
        }
      // A sentence disclaiming a rule ("Neither … nor Rule 8", "not … under Rule 8")
      // names it precisely so a reader does not rely on it; every other mention
      // must be backed by a citation.
      const asserted = c.obligation
        .split(/(?<=\.)\s+/)
        .filter((s) => !/\b(Neither|not)\b/.test(s))
        .join(' ');
      for (const n of rulesIn(asserted)) expect(cited.has(n), `${c.id} names Rule ${n}`).toBe(true);
      if (!CORRECTED_CONTROL_IDS_0_2_0.includes(c.id))
        for (const n of rulesIn(c.obligation))
          expect(cited.has(n), `${c.id} names Rule ${n}`).toBe(true);
    }
  });

  it('seeds every row at 0.2.0 and leaves the default seed at 0.1.1', () => {
    const seed = buildLibrarySeedForVersion('0.2.0');
    expect(seed.version).toBe('0.2.0');
    expect(seed.controls).toHaveLength(46);
    expect(seed.controls.every((r) => r.library_version === '0.2.0')).toBe(true);
    expect(buildLibrarySeed().version).toBe('0.1.1');
  });
});

describe('confirmed oracle findings are corrected in 0.2.0', () => {
  it('CNS-003: seven years is scoped to registered Consent Managers; Section 6(10) is the general duty', () => {
    expect(v1('DPDPA-CNS-003').obligation).toMatch(/at least 7 years/);
    expect(refs('DPDPA-CNS-003')).toContain('DPDPA-2023 Section 6(10)');
    expect(v2('DPDPA-CNS-003').obligation).toMatch(/prove that notice was given/);
    expect(v2('DPDPA-CNS-003').obligation).toMatch(
      /seven-year platform-record period applies only to a registered Consent Manager/,
    );
    expect(v2('DPDPA-CNS-003').title).not.toMatch(/7-year/);
    const q = v2('DPDPA-CNS-003').assessmentQuestions;
    expect(q.find((x) => x.id === 'Q2')!.prompt).not.toMatch(/7 years|seven years/);
    expect(q.find((x) => x.id === 'Q3')!.prompt).toMatch(
      /^Only if you are a registered Consent Manager/,
    );
    const record = CORRECTED_CONTROL_RECORDS_0_2_0.find((r) => r.controlId === 'DPDPA-CNS-003')!;
    expect(record.conditionalQuestions).toEqual([
      { questionId: 'Q3', condition: 'registered_consent_manager' },
    ]);
  });

  it('DAT-003: published period capped at ninety days (Rule 14(3)); 30 days is policy only', () => {
    expect(v1('DPDPA-DAT-003').obligation).toMatch(
      /respond to data principal complaints within 30 days/,
    );
    expect(refs('DPDPA-DAT-003')).toEqual([
      'DPDPA-2023 Section 13(1), 13(2)',
      'DPDPR-2025 Rule 14(3)',
    ]);
    expect(v2('DPDPA-DAT-003').obligation).toMatch(/not exceeding ninety days/);
    expect(v2('DPDPA-DAT-003').obligation).toMatch(/30 days, is organisational policy/);
    expect(text('DPDPA-DAT-003')).not.toMatch(/respond to complaints within 30 days\?/);
    expect(text('DPDPA-DAT-003')).toMatch(/no longer than 90 days/);
  });

  it('DAT-006: no general portability entitlement; Section 11(2) no longer cited as one', () => {
    expect(v1('DPDPA-DAT-006').obligation).toMatch(/entitled to receive/);
    expect(v2('DPDPA-DAT-006').obligation).not.toMatch(/entitled/);
    expect(v2('DPDPA-DAT-006').obligation).toMatch(
      /does not create a general data portability entitlement/,
    );
    expect(v2('DPDPA-DAT-006').obligation).toMatch(/Section 11\(2\) is an exception/);
    expect(v2('DPDPA-DAT-006').title).toMatch(/voluntary/i);
    expect(v2('DPDPA-DAT-006').tags).toContain('organisation-policy');
    expect(v2('DPDPA-DAT-006').obligation).toMatch(/Part B item 4\(b\)/);
  });

  it('BRCH-002: any personal data breach triggers principal notice; no likely-harm gate', () => {
    expect(v1('DPDPA-BRCH-002').obligation).toMatch(/likely to cause harm/);
    expect(v2('DPDPA-BRCH-002').title).not.toMatch(/harm/);
    expect(v2('DPDPA-BRCH-002').obligation).toMatch(
      /On becoming aware of any personal data breach/,
    );
    expect(v2('DPDPA-BRCH-002').obligation).toMatch(/There is no likely-harm threshold/);
    expect(v2('DPDPA-BRCH-002').obligation).not.toMatch(/Where a breach is likely to cause harm/);
    expect(refs('DPDPA-BRCH-002')).toContain('DPDPR-2025 Rule 7');
  });

  it('RCD-001 and RCD-003: accountability practice, Rule 8 / Third Schedule no longer cited', () => {
    for (const id of ['DPDPA-RCD-001', 'DPDPA-RCD-003']) {
      expect(v1(id).citations.some((c) => /Rule 8/.test(c.reference))).toBe(true);
      expect(v2(id).citations.some((c) => /Rule 8|Third Schedule/.test(c.reference))).toBe(false);
      expect(refs(id)).toEqual(['DPDPA-2023 Section 8(1)']);
      expect(v2(id).obligation).toMatch(/accountability/);
      expect(v2(id).tags).toContain('organisation-policy');
      const record = CORRECTED_CONTROL_RECORDS_0_2_0.find((r) => r.controlId === id)!;
      expect(record.legalBasis).toBe('organisation_policy');
    }
    expect(v2('DPDPA-RCD-001').title).not.toMatch(/RoPA/);
  });

  it('records official sources with digests and leaves legal sign-off pending', () => {
    expect(OFFICIAL_SOURCES_0_2_0.map((s) => s.code)).toEqual([
      'DPDPA-2023',
      'GSR-846E',
      'GSR-843E',
    ]);
    for (const s of OFFICIAL_SOURCES_0_2_0) {
      expect(s.url).toMatch(/^https:\/\/www\.meity\.gov\.in\/static\/uploads\//);
      expect(s.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(CORRECTED_CONTROL_RECORDS_0_2_0.map((r) => r.controlId).sort()).toEqual([
      ...CORRECTED_CONTROL_IDS_0_2_0,
    ]);
    expect(LEGAL_REVIEW_0_2_0.legalSignOff).toBe('pending');
  });
});

describe('phased commencement (G.S.R. 843(E) and Rule 1(2)–(4))', () => {
  it.each([
    ['2(k)', 'on_publication'],
    ['1(2)', 'on_publication'],
    ['18', 'on_publication'],
    ['44(1)', 'on_publication'],
    ['44(2)', 'eighteen_months'],
    ['6(9)', 'one_year'],
    ['6(10)', 'eighteen_months'],
    ['27(1)(d)', 'one_year'],
    ['27(2)', 'eighteen_months'],
    ['8(6)', 'eighteen_months'],
    ['36', 'eighteen_months'],
    ['35', 'on_publication'],
  ] as const)('Act section %s commences %s', (section, group) => {
    expect(actSectionCommencement(section)).toBe(group);
  });

  it('refuses sections the notification does not name', () => {
    expect(actSectionCommencement('1(1)')).toBeNull();
    expect(actSectionCommencement('45')).toBeNull();
    expect(ruleCommencement(24)).toBeNull();
  });

  it('resolves every DPDP citation in 0.2.0 to a commencement group', () => {
    for (const c of controls_0_2_0)
      for (const cit of c.citations.filter((x) => x.instrument !== 'Other'))
        for (const p of citationCommencement(cit.instrument, cit.reference))
          expect(p.group, `${c.id} ${p.reference}`).not.toBeNull();
  });

  it('labels readiness against future duties by assessment date', () => {
    expect(commencementStatusAsOf('0.2.0', 'DPDPA-BRCH-002', '2026-10-16')).toBe(
      'not_yet_in_force',
    );
    expect(commencementStatusAsOf('0.2.0', 'DPDPA-BRCH-002', '2027-05-13')).toBe('in_force');
    // Consent Manager element (Rule 4 / First Schedule) commences a year after publication.
    expect(commencementStatusAsOf('0.2.0', 'DPDPA-CNS-003', '2026-11-13')).toBe(
      'partially_in_force',
    );
    expect(
      resolveControlLibrary('0.2.0').commencement!.find((c) => c.controlId === 'DPDPA-CNS-003')!
        .effectiveFrom,
    ).toBe('2027-05-13');
    // 0.1.1 never carried per-control commencement; it is not invented retroactively.
    expect(commencementStatusAsOf('0.1.1', 'DPDPA-BRCH-002', '2027-05-13')).toBe(
      'unknown_for_version',
    );
    expect(() => commencementStatusAsOf('0.2.0', 'DPDPA-BRCH-002', '13/05/2027')).toThrow();
  });
});

describe('version resolution refuses rather than substitutes', () => {
  it.each(['0.1.0', '0.2', 'latest', '', '0.2.0 ', '1.0.0'])('refuses %j', (v) => {
    expect(() => resolveControlLibrary(v)).toThrow(UnknownLibraryVersionError);
    expect(() => buildLibrarySeedForVersion(v)).toThrow(UnknownLibraryVersionError);
  });

  it('resolves each known version to rows carrying only that version', () => {
    for (const v of KNOWN_LIBRARY_VERSIONS) {
      const lib = resolveControlLibrary(v);
      expect(lib.version).toBe(v);
      expect(buildLibrarySeedForVersion(v).controls.every((r) => r.library_version === v)).toBe(
        true,
      );
    }
  });

  it('publication still targets only published 0.1.1 (no activation of the candidate)', async () => {
    const reads: Record<string, unknown>[] = [];
    await publishCatalogue({
      read: async (table, _c, filters) => {
        reads.push({ table, ...filters });
        return { data: [], error: { message: 'stop' } };
      },
      insert: async () => ({ data: null, error: null }),
      activate: async () => ({ data: null, error: null }),
      rpc: async () => ({ data: null, error: null }),
    }).catch(() => undefined);
    expect(reads[0]).toEqual({ table: 'control_libraries', version: '0.1.1' });
  });
});
