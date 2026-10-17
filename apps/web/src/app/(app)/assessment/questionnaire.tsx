'use client';
import { buttonVariants } from '@axiom/ui';
import React, { useEffect, useState } from 'react';
import {
  AssessmentQuestionnaireSchema,
  type AssessmentQuestionnaire,
  type AssessmentRequest,
} from '@axiom/types';

export interface ReviewedQuestionnaire {
  answers: AssessmentRequest['answers'];
  applicability: AssessmentRequest['applicability'];
  questionnaireDigest: string;
}
interface Props {
  tenantId: string;
  engagementId: string;
  libraryVersion: string;
  onReviewed: (value: ReviewedQuestionnaire | null) => void;
  disabled?: boolean;
}
const flags = [
  ['sdfSelfAttested', 'Significant Data Fiduciary designation (self-declared)'],
  ['processesChildren', 'Processes children’s personal data'],
  ['processesHealth', 'Processes health-related personal data'],
] as const;
const choice = (value: boolean | null) => (value === null ? 'unknown' : value ? 'yes' : 'no');
const answer = (value: string) => (value === 'yes' ? true : value === 'no' ? false : null);
function declaredAnswer(
  answers: AssessmentRequest['answers'],
  controlId: string,
  questionId: string,
): boolean | null {
  const row = Object.hasOwn(answers, controlId) ? answers[controlId] : undefined;
  return row && Object.hasOwn(row, questionId) ? (row[questionId] ?? null) : null;
}

/** Declaration collection only. No scores, inferred facts or submissions. */
export function AssessmentQuestionnaireEditor({
  tenantId,
  engagementId,
  libraryVersion,
  onReviewed,
  disabled = false,
}: Props) {
  const [source, setSource] = useState<AssessmentQuestionnaire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<AssessmentRequest['answers']>({});
  const [applicability, setApplicability] = useState<AssessmentRequest['applicability']>({
    sdfSelfAttested: null,
    processesChildren: null,
    processesHealth: null,
  });
  const [reviewing, setReviewing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(
          `/api/bff/v1/assessment/questionnaire?engagementId=${engagementId}`,
          {
            cache: 'no-store',
            headers: { 'X-Tenant-Id': tenantId },
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
          },
        );
        if (!response.ok) throw new Error();
        const raw = await response.text();
        if (new TextEncoder().encode(raw).length > 2_000_000) throw new Error();
        const value = AssessmentQuestionnaireSchema.parse(JSON.parse(raw));
        if (
          value.tenantId !== tenantId ||
          value.engagementId !== engagementId ||
          value.libraryVersion !== libraryVersion
        )
          throw new Error();
        if (live) {
          setSource(value);
          setError(null);
        }
      } catch {
        if (live)
          setError(
            'The published questionnaire could not be verified. Keep your answers unknown until its source is available.',
          );
      }
    }
    void load();
    return () => {
      live = false;
      controller.abort();
    };
  }, [tenantId, engagementId, libraryVersion, attempt]);
  function invalidate() {
    setReviewing(false);
    onReviewed(null);
  }
  if (error)
    return (
      <div role="alert">
        {error}{' '}
        <button
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
          type="button"
          onClick={() => {
            setError(null);
            setAttempt((old) => old + 1);
          }}
        >
          Retry questionnaire loading
        </button>
      </div>
    );
  if (!source) return <p role="status">Loading the published questionnaire…</p>;
  return (
    <div className="space-y-4">
      <p>
        Library {source.libraryVersion}. Answers are your unverified declarations; supporting
        evidence is reviewed separately.
      </p>
      <p className="break-all text-xs">
        Questionnaire reference: {source.questionnaireDigest}. This identifies the displayed
        questions, not a finalized assessment or verified evidence.
      </p>
      <fieldset disabled={disabled} className="space-y-2">
        <legend className="font-semibold">Applicability declarations</legend>
        {flags.map(([id, label]) => (
          <label className="flex min-w-0 flex-wrap items-center gap-2 break-words" key={id}>
            {label}
            {reviewing ? (
              <span>{choice(applicability[id])}</span>
            ) : (
              <select
                className="max-w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900"
                aria-label={label}
                value={choice(applicability[id])}
                onChange={(e) => {
                  invalidate();
                  setApplicability((old) => ({ ...old, [id]: answer(e.target.value) }));
                }}
              >
                <option value="unknown">Unknown</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            )}
          </label>
        ))}
      </fieldset>
      {source.controls.map((control) => (
        <fieldset
          disabled={disabled}
          key={control.id}
          className="min-w-0 space-y-2 rounded-lg border border-slate-200 p-3"
        >
          <legend className="px-1 font-semibold">
            {control.id}: {control.title}
          </legend>
          {control.questions.map((question) => (
            <div key={question.id}>
              {question.type === 'boolean' ? (
                <label className="flex min-w-0 flex-wrap items-center gap-2 break-words">
                  {question.prompt}
                  {reviewing ? (
                    <span>{choice(declaredAnswer(answers, control.id, question.id))}</span>
                  ) : (
                    <select
                      className="max-w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900"
                      aria-label={`${control.id} ${question.id}: ${question.prompt}`}
                      value={choice(declaredAnswer(answers, control.id, question.id))}
                      onChange={(e) => {
                        invalidate();
                        setAnswers((old) => ({
                          ...old,
                          [control.id]: {
                            ...old[control.id],
                            [question.id]: answer(e.target.value),
                          },
                        }));
                      }}
                    >
                      <option value="unknown">Unknown</option>
                      <option value="yes">Yes</option>
                      <option value="no">No</option>
                    </select>
                  )}
                </label>
              ) : (
                <p>
                  {question.prompt} — {question.type} input requires a separate supported workflow
                  and remains unassessed here.
                </p>
              )}
            </div>
          ))}
        </fieldset>
      ))}
      {reviewing ? (
        <>
          <p role="status">
            Review the declarations above, then explicitly confirm submission below. Unknown answers
            and unsupported inputs remain unresolved.
          </p>
          <button
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
            type="button"
            disabled={disabled}
            onClick={invalidate}
          >
            Edit questionnaire declarations
          </button>
        </>
      ) : (
        <button
          type="button"
          disabled={disabled}
          className="rounded-lg border border-slate-300 px-3 py-2 font-semibold"
          onClick={() => {
            const complete = Object.fromEntries(
              source.controls
                .map((control): [string, Record<string, boolean | null>] => [
                  control.id,
                  Object.fromEntries(
                    control.questions
                      .filter((q) => q.type === 'boolean')
                      .map((q) => [q.id, declaredAnswer(answers, control.id, q.id)]),
                  ),
                ])
                .filter(([, questions]) => Object.keys(questions).length),
            );
            setReviewing(true);
            onReviewed({
              answers: complete,
              applicability,
              questionnaireDigest: source.questionnaireDigest,
            });
          }}
        >
          Review questionnaire declarations
        </button>
      )}
    </div>
  );
}
