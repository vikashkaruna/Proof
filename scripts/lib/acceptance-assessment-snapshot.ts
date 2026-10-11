import assert from 'node:assert/strict';
import type { AssessmentSnapshot } from '../../packages/types/src/assessment.js';
/** Fixture-only proof against the selected canonical library. Scores are
 * provisional; absent Boolean questions never become answered declarations. */
export function verifyUnknownAssessmentSnapshot(
  snapshot: Pick<AssessmentSnapshot, 'controls'>,
  source: readonly {
    id: string;
    assessment_questions: readonly { id: string; type: string }[];
  }[],
) {
  assert(source.length > 0);
  assert.equal(new Set(source.map((control) => control.id)).size, source.length);
  assert.equal(snapshot.controls.length, source.length);
  assert.equal(new Set(snapshot.controls.map((control) => control.id)).size, source.length);
  const definitions = new Map(source.map((control) => [control.id, control]));
  let booleanAssessableControls = 0,
    nonBooleanAssessableControls = 0,
    unknownQuestions = 0;
  for (const control of snapshot.controls) {
    const definition = definitions.get(control.id);
    assert(definition, 'Readback control must belong to the canonical library');
    assert(definition.assessment_questions.every((question) => question.id.length > 0));
    assert.equal(
      new Set(definition.assessment_questions.map((question) => question.id)).size,
      definition.assessment_questions.length,
    );
    const count = definition.assessment_questions.filter(
      (question) => question.type === 'boolean',
    ).length;
    assert.equal(control.status, 'unknown');
    assert.equal(control.answerState, count > 0 ? 'unknown' : 'not_boolean_assessable');
    assert.deepEqual(control.answerCounts, {
      knownBooleanQuestions: count,
      callerAffirmed: 0,
      callerDenied: 0,
      unknown: count,
    });
    unknownQuestions += count;
    if (count > 0) booleanAssessableControls++;
    else nonBooleanAssessableControls++;
  }
  return { booleanAssessableControls, nonBooleanAssessableControls, unknownQuestions };
}
