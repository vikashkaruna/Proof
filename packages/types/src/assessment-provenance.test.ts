import { describe, expect, it } from 'vitest';
import {
  validateQuestionnaireProvenance,
  questionnaireProvenanceSchema,
} from './assessment-provenance';
function fixture() {
  const controls = [
    {
      id: 'C',
      library_version: 'v1',
      sdf_only: true,
      children_only: true,
      assessment_questions: [
        { id: 'Q1', type: 'boolean' },
        { id: 'Q2', type: 'boolean' },
        { id: 'TEXT', type: 'text' },
      ],
    },
  ];
  const provenance = {
    version: 1,
    source_library_version: 'v1',
    source_library_digest: 'a'.repeat(64),
    estimates: 'provisional',
    review_required: true,
    controls: [
      {
        control_id: 'C',
        questions: [
          { question_id: 'Q1', declaration: 'unknown' },
          { question_id: 'Q2', declaration: 'unknown' },
        ],
        known_boolean_question_count: 2,
        caller_affirmed_count: 0,
        caller_denied_count: 0,
        unknown_count: 2,
        answer_state: 'unknown',
        applicability_state: 'unknown',
      },
    ],
    applicability: {
      sdf_self_attested: { value: null as boolean | null, provenance: 'unknown' },
      processes_children: { value: null as boolean | null, provenance: 'unknown' },
      processes_health: { value: null as boolean | null, provenance: 'unknown' },
    },
  };
  return {
    controls,
    result: {
      library_version: 'v1',
      findings: [{ control_id: 'C' }],
      questionnaire_provenance: provenance,
    },
    digest: 'a'.repeat(64),
  };
}
describe('shared immutable questionnaire provenance', () => {
  it('preserves unknown nullable declarations and binds exact source Boolean questions', () => {
    const f = fixture();
    expect(validateQuestionnaireProvenance(f.result, f.controls, f.digest)).toMatchObject({
      status: 'available_unverified',
      provenance: {
        controls: [{ answer_state: 'unknown', unknown_count: 2 }],
        applicability: { sdf_self_attested: { value: null } },
      },
    });
  });
  it('keeps historical absence explicitly unavailable without guessing pinned definitions', () => {
    expect(
      validateQuestionnaireProvenance(
        { library_version: 'v1', findings: [{ control_id: 'C' }] },
        [],
        'legacy',
      ),
    ).toEqual({ status: 'unavailable', provenance: null });
  });
  it.each(['yes', 'no', 'partial', 'zero'])('validates declared answer state %s', (mode) => {
    const f = fixture(),
      c = f.result.questionnaire_provenance.controls[0]!;
    if (mode === 'zero') {
      f.controls[0]!.assessment_questions = [];
      c.questions = [];
      c.known_boolean_question_count = 0;
      c.unknown_count = 0;
      c.answer_state = 'not_boolean_assessable';
    } else {
      c.questions[0]!.declaration = mode === 'no' ? 'caller_denied' : 'caller_affirmed';
      c.caller_affirmed_count = mode === 'no' ? 0 : 1;
      c.caller_denied_count = mode === 'no' ? 1 : 0;
      c.unknown_count = 1;
      c.answer_state = 'partially_answered';
      if (mode !== 'partial') {
        c.questions[1]!.declaration = c.questions[0]!.declaration;
        c.caller_affirmed_count *= 2;
        c.caller_denied_count *= 2;
        c.unknown_count = 0;
        c.answer_state = 'caller_declared_unverified';
      }
    }
    expect(validateQuestionnaireProvenance(f.result, f.controls, f.digest).status).toBe(
      'available_unverified',
    );
  });
  it.each(['unconditional', 'applicable', 'excluded'])(
    'binds frozen applicability predicates %s',
    (mode) => {
      const f = fixture(),
        p = f.result.questionnaire_provenance;
      if (mode === 'unconditional') {
        f.controls[0]!.sdf_only = false;
        f.controls[0]!.children_only = false;
        p.controls[0]!.applicability_state = 'unconditional';
      } else {
        p.applicability.sdf_self_attested = {
          value: mode === 'applicable',
          provenance: 'caller_declared_unverified',
        };
        p.applicability.processes_children = {
          value: true,
          provenance: 'caller_declared_unverified',
        };
        p.controls[0]!.applicability_state =
          mode === 'applicable'
            ? 'caller_declared_applicable_unverified'
            : 'caller_declared_not_applicable_unverified';
      }
      expect(validateQuestionnaireProvenance(f.result, f.controls, f.digest).status).toBe(
        'available_unverified',
      );
    },
  );
  it.each([
    'digest',
    'library',
    'qid',
    'count',
    'duplicateQuestion',
    'control',
    'duplicateControl',
    'sourceDuplicate',
    'predicate',
    'flag',
    'null',
    'extra',
  ])('refuses corrupt present binding %s', (mode) => {
    const f = fixture(),
      p = f.result.questionnaire_provenance,
      c = p.controls[0]!;
    if (mode === 'digest') p.source_library_digest = 'b'.repeat(64);
    if (mode === 'library') f.controls[0]!.library_version = 'other';
    if (mode === 'qid') c.questions[0]!.question_id = 'foreign';
    if (mode === 'count') c.unknown_count = 1;
    if (mode === 'duplicateQuestion') c.questions[1]!.question_id = 'Q1';
    if (mode === 'control') c.control_id = 'foreign';
    if (mode === 'duplicateControl') p.controls.push({ ...c });
    if (mode === 'sourceDuplicate') f.controls.push({ ...f.controls[0]! });
    if (mode === 'predicate') c.applicability_state = 'unconditional';
    if (mode === 'flag') p.applicability.sdf_self_attested.value = true;
    const result =
      mode === 'null'
        ? { ...f.result, questionnaire_provenance: null }
        : mode === 'extra'
          ? { ...f.result, questionnaire_provenance: { ...p, confidential: 'extra' } }
          : f.result;
    expect(() => validateQuestionnaireProvenance(result, f.controls, f.digest)).toThrow();
  });
  it('bounds structured source and provenance bytes', () => {
    const f = fixture();
    f.controls[0]!.assessment_questions = Array.from({ length: 1000 }, (_, i) => ({
      id: `${i}-${'x'.repeat(195)}`,
      type: 'x'.repeat(100),
    }));
    expect(() => validateQuestionnaireProvenance(f.result, f.controls, f.digest)).toThrow();
    const p = f.result.questionnaire_provenance;
    const raw = {
      ...p,
      controls: Array.from({ length: 500 }, () => ({
        ...p.controls[0]!,
        questions: Array.from({ length: 1000 }, (_, i) => ({
          question_id: `${i}-${'x'.repeat(190)}`,
          declaration: 'unknown',
        })),
      })),
    };
    expect(questionnaireProvenanceSchema.safeParse(raw).success).toBe(false);
  });
});
