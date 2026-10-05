import { describe, expect, it } from 'vitest';
import { sourcePacket } from './board-v2.fixture';
import {
  interpretAssessmentReport,
  AssessmentReportFindingInterpretationSchema,
  assessmentReviewRecommendation,
} from './assessment-interpretation';
describe('source-bound report interpretation', () => {
  it('retains 46 controls and 65 unanswered Boolean questions without alleging any failure', () => {
    const { controls, result, digest } = sourcePacket();
    const value = interpretAssessmentReport(result, controls, digest, 'Review');
    expect(result.questionnaire_provenance.controls.reduce((n, c) => n + c.unknown_count, 0)).toBe(
      65,
    );
    expect(value.summary).toMatchObject({
      total_controls: 46,
      unknown_controls: 44,
      not_boolean_assessable_controls: 2,
      posture_score: 30,
      estimated_exposure_inr: 123456,
      provisional_score_bands: { at_least_80: 0, from_40_to_under_80: 0, under_40: 0 },
    });
    expect(value.summary).not.toHaveProperty('failed_controls');
    expect(value.findings).toHaveLength(46);
    expect(value.findings.every((f) => f.score_band === null)).toBe(true);
    expect(assessmentReviewRecommendation('unknown', ['Delete all records'])).not.toContain(
      'Delete',
    );
  });
  it('separates partial, complete caller declarations and caller-declared exclusions', () => {
    const { controls, result } = sourcePacket();
    const p = result.questionnaire_provenance;
    p.controls[0]!.questions[0]!.declaration = 'caller_affirmed';
    p.controls[0]!.caller_affirmed_count = 1;
    p.controls[0]!.unknown_count = 1;
    p.controls[0]!.answer_state = 'partially_answered';
    p.controls[21]!.questions[0]!.declaration = 'caller_denied';
    p.controls[21]!.caller_denied_count = 1;
    p.controls[21]!.unknown_count = 0;
    p.controls[21]!.answer_state = 'caller_declared_unverified';
    controls[22]!.sdf_only = true;
    p.applicability.sdf_self_attested = { value: false, provenance: 'caller_declared_unverified' };
    p.controls[22]!.applicability_state = 'caller_declared_not_applicable_unverified';
    controls[23]!.children_only = true;
    p.controls[23]!.applicability_state = 'unknown';
    const digest = awaitHash(controls);
    p.source_library_digest = digest;
    const value = interpretAssessmentReport(result, controls, digest, 'Review');
    expect(value.findings[0]!.display_state).toBe('unknown');
    expect(value.findings[21]).toMatchObject({
      display_state: 'provisional_score_band',
      score_band: 'under_40',
    });
    expect(value.findings[22]!.display_state).toBe('declared_not_applicable_unverified');
    expect(value.findings[23]!.display_state).toBe('unknown');
    expect(value.summary.provisional_score_bands.under_40).toBe(1);
  });
  it('labels legacy provenance unavailable rather than guessing answers from score or rationale', () => {
    const { controls, result, digest } = sourcePacket();
    const { questionnaire_provenance: _, ...legacy } = result;
    const value = interpretAssessmentReport(legacy, controls, digest, 'Review');
    expect(value.summary.provenance_unavailable_controls).toBe(46);
    expect(value.summary.unknown_controls).toBe(0);
  });
  it.each(['digest', 'qid', 'count', 'applicability', 'null'])(
    'refuses inconsistent present metadata: %s',
    (mode) => {
      const { controls, result, digest } = sourcePacket();
      const p = result.questionnaire_provenance;
      if (mode === 'digest') p.source_library_digest = 'f'.repeat(64);
      if (mode === 'qid') p.controls[0]!.questions[0]!.question_id = 'foreign';
      if (mode === 'count') p.controls[0]!.unknown_count = 0;
      if (mode === 'applicability')
        p.controls[0]!.applicability_state = 'caller_declared_not_applicable_unverified';
      const raw = mode === 'null' ? { ...result, questionnaire_provenance: null } : result;
      expect(() => interpretAssessmentReport(raw, controls, digest, 'Review')).toThrow();
    },
  );
  it('refuses public interpretation claiming a complete score band for unknown declarations', () => {
    expect(
      AssessmentReportFindingInterpretationSchema.safeParse({
        display_state: 'provisional_score_band',
        answer_state: 'unknown',
        applicability_state: 'unconditional',
        answer_counts: { known: 2, affirmed: 0, denied: 0, unknown: 2 },
        score_band: 'under_40',
      }).success,
    ).toBe(false);
  });
});
import { packetHash } from './board-v2.fixture';
function awaitHash(value: unknown) {
  return packetHash(JSON.stringify(value));
}
