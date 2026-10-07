import test from 'node:test';
import assert from 'node:assert/strict';
import type { AssessmentSnapshot } from '../../packages/types/src/assessment.js';
import { verifyUnknownAssessmentSnapshot } from './acceptance-assessment-snapshot.js';
const source = [
  {
    id: 'C1',
    assessment_questions: [
      { id: 'Q1', type: 'boolean' },
      { id: 'T1', type: 'text' },
    ],
  },
  { id: 'C2', assessment_questions: [{ id: 'T1', type: 'text' }] },
];
function snapshot(): Pick<AssessmentSnapshot, 'controls'> {
  return {
    controls: source.map((control) => {
      const count = control.assessment_questions.filter(
        (question) => question.type === 'boolean',
      ).length;
      return {
        id: control.id,
        name: control.id,
        domain: 'synthetic',
        cite: '',
        score: 100,
        scoreBand: 'pass',
        status: 'unknown',
        answerState: count ? 'unknown' : 'not_boolean_assessable',
        answerCounts: {
          knownBooleanQuestions: count,
          callerAffirmed: 0,
          callerDenied: 0,
          unknown: count,
        },
        evidenceIds: [],
      };
    }),
  };
}
test('unknown source facts preserve both Boolean and nonassessable controls despite numeric score', () => {
  assert.deepEqual(verifyUnknownAssessmentSnapshot(snapshot(), source), {
    booleanAssessableControls: 1,
    nonBooleanAssessableControls: 1,
    unknownQuestions: 1,
  });
});
for (const mutation of [
  'wrong-nonassessable-state',
  'confirmed-status',
  'affirmed',
  'denied',
  'missing-unknown',
  'wrong-known-count',
  'foreign-control',
  'duplicate-control',
  'missing-control',
] as const)
  test(`refuses malformed readback ${mutation}`, () => {
    const value = snapshot(),
      first = value.controls[0]!;
    if (mutation === 'wrong-nonassessable-state') value.controls[1]!.answerState = 'unknown';
    if (mutation === 'confirmed-status') first.status = 'pass';
    if (mutation === 'affirmed') first.answerCounts!.callerAffirmed = 1;
    if (mutation === 'denied') first.answerCounts!.callerDenied = 1;
    if (mutation === 'missing-unknown') first.answerCounts!.unknown = 0;
    if (mutation === 'wrong-known-count') first.answerCounts!.knownBooleanQuestions = 2;
    if (mutation === 'foreign-control') first.id = 'foreign';
    if (mutation === 'duplicate-control') value.controls[1] = structuredClone(first);
    if (mutation === 'missing-control') value.controls.pop();
    assert.throws(() => verifyUnknownAssessmentSnapshot(value, source));
  });
test('refuses ambiguous canonical control or question IDs and empty libraries', () => {
  assert.throws(() => verifyUnknownAssessmentSnapshot(snapshot(), [source[0]!, source[0]!]));
  assert.throws(() =>
    verifyUnknownAssessmentSnapshot(snapshot(), [
      {
        ...source[0]!,
        assessment_questions: [
          { id: 'Q1', type: 'boolean' },
          { id: 'Q1', type: 'boolean' },
        ],
      },
      source[1]!,
    ]),
  );
  assert.throws(() => verifyUnknownAssessmentSnapshot({ controls: [] }, []));
});
