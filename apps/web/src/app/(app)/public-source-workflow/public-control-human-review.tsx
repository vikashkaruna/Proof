'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { canonicalJson } from '@axiom/ledger';
import { generateUUID } from '@axiom/ui';
import {
  publicControlCatalogueV2Manifest,
  publicEvidenceCatalogueRowsMatchV2,
} from '@axiom/control-library';
import {
  parsePublicControlReviewSetAnyRequestText as parsePublicControlReviewSetRequestText,
  publicControlReviewSetAnyRequestSchema,
  publicControlReviewSetRequestSchema,
  type PublicControlAssessmentV2,
  publicControlAssessmentV2Schema,
  type PublicControlReviewSetRequest,
} from '@axiom/types';
import {
  readControlReviewOperations,
  retainControlReviewOperation,
  clearResolvedControlReviewOperation,
  type ControlReviewOperation,
} from './control-review-journal';
import {
  loadHumanControlReview,
  reconcileHumanControlReview,
  sendHumanControlReview,
  type HumanControlReviewHead,
  type ResolvedHumanControlReview,
} from './control-review-client';

import {
  PublicControlAssetSelection,
  type AssetReviewHint,
  type ConfirmedReviewAssociation,
} from './public-control-asset-selection';
const button = 'rounded border border-slate-300 px-3 py-2 text-sm disabled:opacity-50';
const field =
  'block w-full max-w-full rounded border border-slate-300 bg-white p-2 text-sm text-slate-900';
const unknownApplicability = () => ({
  sdfSelfAttested: null,
  processesChildren: null,
  processesHealth: null,
  rationale: '',
});
const choice = (v: boolean | null) => (v === null ? 'unknown' : v ? 'yes' : 'no');
const answer = (v: string) => (v === 'yes' ? true : v === 'no' ? false : null);
type Props = {
  actorId: string;
  canReview: boolean;
  canRun?: boolean;
  assessment: PublicControlAssessmentV2;
  assetHint?: AssetReviewHint;
};

/** Saved human declarations remain distinct from observed facts and compliance conclusions. */
export function PublicControlHumanReview(props: Props) {
  const s = props.assessment.source;
  return (
    <HumanReview
      key={`${s.tenantId}/${props.actorId}/${s.engagementId}/${s.checkId}/${s.projectionSha256}/${props.assetHint?.targetId ?? ''}/${props.assetHint?.associationId ?? ''}`}
      {...props}
    />
  );
}
function HumanReview({ actorId, canReview, canRun = false, assessment, assetHint }: Props) {
  const source = assessment.source;
  const [linkedMode, setLinkedMode] = useState(false);
  const [associationRevision, setAssociationRevision] = useState(0);
  const [associationRef, setAssociationRef] = useState<ConfirmedReviewAssociation | null>(null);

  const [head, setHead] = useState<HumanControlReviewHead | null>(null);
  const [judgments, setJudgments] = useState<PublicControlReviewSetRequest['answers']>({});
  const [applicability, setApplicability] =
    useState<PublicControlReviewSetRequest['applicability']>(unknownApplicability);
  const [operations, setOperations] = useState<ControlReviewOperation[]>([]);
  const [storageReady, setStorageReady] = useState(false),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const associationChanged = useCallback((value: ConfirmedReviewAssociation | null) => {
    setAssociationRef(value);
    if (value) setLinkedMode(true);
    setConfirmed(false);
  }, []);
  const [cancellations, setCancellations] = useState<
    Record<string, { reason: string; confirmed: boolean }>
  >({});
  const [dirty, setDirty] = useState(false);
  const [controlId, setControlId] = useState(
    publicControlCatalogueV2Manifest().controls[0]!.control.id,
  );
  const [questionId, setQuestionId] = useState(
    publicControlCatalogueV2Manifest().controls[0]!.control.assessmentQuestions[0]!.id,
  );
  const [draftAnswer, setDraftAnswer] = useState('unknown'),
    [rationale, setRationale] = useState(''),
    [candidateText, setCandidateText] = useState('');
  const headRevision = useRef(0);
  const active = useRef(false),
    mounted = useRef(true);
  const [manifest] = useState(publicControlCatalogueV2Manifest);
  const validManifest =
    publicControlAssessmentV2Schema.safeParse(assessment).success &&
    publicEvidenceCatalogueRowsMatchV2(assessment.controls);
  const control =
    manifest.controls.find((row) => row.control.id === controlId)?.control ??
    manifest.controls[0]!.control;
  const question = control.assessmentQuestions.find((row) => row.id === questionId);
  const disposition = assessment.controls
    .find((row) => row.controlId === controlId)
    ?.questions.find((row) => row.questionId === questionId);
  const inspectStorage = useCallback(() => {
    const saved = readControlReviewOperations(localStorage, source.tenantId, actorId);
    if (mounted.current) {
      setOperations(saved);
      setStorageReady(true);
    }
    return saved;
  }, [source.tenantId, actorId]);
  const applyHead = useCallback(
    function applyHead(value: HumanControlReviewHead) {
      if (!mounted.current) return;
      setHead(value);
      setAssociationRef(null);
      setAssociationRevision((value) => value + 1);
      const previous = value.review;
      const sameEstate = previous?.estate_id === value.estateId;
      setJudgments(
        previous && sameEstate ? structuredClone(previous.snapshot.request.answers) : {},
      );
      setApplicability(
        previous && sameEstate
          ? structuredClone(previous.snapshot.request.applicability)
          : unknownApplicability(),
      );
      setConfirmed(false);
      setDirty(false);
      const selected = manifest.controls[0]!.control;
      const selectedQuestion = selected.assessmentQuestions[0]!.id;
      setControlId(selected.id);
      setQuestionId(selectedQuestion);
      const judgment =
        previous && sameEstate
          ? previous.snapshot.request.answers[selected.id]?.[selectedQuestion]
          : undefined;
      setDraftAnswer(choice(judgment?.answer ?? null));
      setRationale(judgment?.rationale ?? '');
      setCandidateText(judgment?.candidateOrdinals.join(', ') ?? '');
    },
    [manifest.controls],
  );
  const readHead = useCallback(
    async (signal?: AbortSignal) => {
      const revision = ++headRevision.current;
      const value = await loadHumanControlReview(assessment, signal);
      if (mounted.current && !signal?.aborted && revision === headRevision.current)
        applyHead(value);
    },
    [assessment, applyHead],
  );
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    function storageChanged() {
      try {
        inspectStorage();
      } catch {
        setStorageReady(false);
        setError(
          'Retained human-review storage cannot be verified. Preserve it and restore access before recording.',
        );
      }
    }
    void Promise.resolve().then(() => {
      if (!controller.signal.aborted) storageChanged();
    });
    void readHead(controller.signal).catch(() => {
      if (!controller.signal.aborted && mounted.current)
        setError(
          'Saved human control review could not be loaded. Refresh this review before recording.',
        );
    });
    window.addEventListener('storage', storageChanged);
    return () => {
      mounted.current = false;
      controller.abort();
      window.removeEventListener('storage', storageChanged);
    };
  }, [inspectStorage, readHead]);
  function selectQuestion(nextControlId: string, nextQuestionId: string) {
    const selected = manifest.controls.find((row) => row.control.id === nextControlId)?.control;
    if (!selected || !selected.assessmentQuestions.some((row) => row.id === nextQuestionId)) return;
    const old = judgments[nextControlId]?.[nextQuestionId];
    setControlId(nextControlId);
    setQuestionId(nextQuestionId);
    setConfirmed(false);
    setDraftAnswer(choice(old?.answer ?? null));
    setRationale(old?.rationale ?? '');
    setCandidateText(old?.candidateOrdinals.join(', ') ?? '');
  }
  function editField(update: () => void) {
    update();
    setDirty(true);
    setConfirmed(false);
  }
  function editJudgment() {
    try {
      if (question?.type !== 'boolean')
        throw new Error(
          'This question requires a separate supported evidence workflow and stays unassessed here.',
        );
      if (!rationale.trim())
        throw new Error('Enter a rationale for this question before adding the judgment.');
      const candidates = candidateText.trim()
        ? candidateText.split(',').map((v) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN))
        : [];
      if (
        new Set(candidates).size !== candidates.length ||
        candidates.some((ordinal) => !source.candidates.some((v) => v.ordinal === ordinal))
      )
        throw new Error('Choose recorded candidate numbers from this capture.');
      const changed = publicControlReviewSetRequestSchema.shape.answers.parse({
        [controlId]: {
          [questionId]: {
            answer: answer(draftAnswer),
            rationale: rationale.trim(),
            candidateOrdinals: candidates,
          },
        },
      });
      setJudgments((old) => ({
        ...old,
        [controlId]: { ...old[controlId], ...changed[controlId] },
      }));
      setConfirmed(false);
      setDirty(false);
      setError('');
      setNotice(
        'Judgment added to the local review draft. Record the review explicitly to save it.',
      );
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message.length < 250
          ? cause.message
          : 'Enter a rationale and valid, distinct candidate numbers.',
      );
    }
  }
  async function resolvePositive(
    state: ResolvedHumanControlReview,
    operation: ControlReviewOperation,
  ) {
    if (state.state === 'not_found') {
      if (mounted.current)
        setNotice(
          'No recorded outcome was found yet. The original request remains retained. Retry that exact request, or explicitly cancel it if it has not been recorded.',
        );
      return;
    }
    ++headRevision.current;
    if (mounted.current) {
      setHead(null);
      setConfirmed(false);
    }
    clearResolvedControlReviewOperation(localStorage, operation);
    if (!mounted.current) return;
    inspectStorage();
    const resolvedKey = parsePublicControlReviewSetRequestText(operation.requestText).operationKey;
    setCancellations((old) => {
      const next = { ...old };
      delete next[resolvedKey];
      return next;
    });
    setNotice(
      state.state === 'cancelled'
        ? `Unrecorded review request cancelled. Receipt ${state.data.receipt_id}; no earlier judgment was changed.`
        : `Human review recorded. Receipt ${state.data.receipt_id}${state.isCurrent && state.contextCurrent ? '' : '; historical receipt, no longer current for this context'}. Declarations remain unverified.`,
    );
    try {
      await readHead();
    } catch {
      if (mounted.current)
        setError(
          'The recorded outcome was verified, but fresh review context could not be loaded. Refresh human review before recording another revision.',
        );
    }
  }
  async function task(action: () => Promise<void>) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      if (mounted.current) {
        setError(
          cause instanceof Error && cause.name !== 'ZodError' && cause.message.length < 500
            ? cause.message
            : 'The human review outcome could not be confirmed. Preserve and reconcile its retained request.',
        );
        try {
          inspectStorage();
        } catch {
          setStorageReady(false);
        }
      }
    } finally {
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const associationRequired = Boolean(
    linkedMode ||
    assetHint?.targetId ||
    assetHint?.associationId ||
    head?.review?.snapshot.version === 2,
  );
  function record() {
    if (
      !canReview ||
      !validManifest ||
      !head ||
      !storageReady ||
      !confirmed ||
      dirty ||
      operations.length ||
      (associationRequired && !associationRef)
    )
      return;
    void task(async () => {
      const parsedRequest = publicControlReviewSetAnyRequestSchema.safeParse({
        ...(associationRef ? { version: 2, associationRef } : { version: 1 }),
        operationKey: generateUUID(),
        engagementId: source.engagementId,
        checkId: source.checkId,
        expectedEstateId: head.estateId,
        expectedPreviousReviewId: head.review?.id ?? null,
        expectedSource: head.expectedSource,
        answers: judgments,
        applicability,
      });
      if (!parsedRequest.success)
        throw new Error(
          'Review question rationales, evidence candidate numbers and the applicability rationale before recording.',
        );
      const request = parsedRequest.data;
      const operation = retainControlReviewOperation(localStorage, {
        tenantId: source.tenantId,
        actorId,
        requestText: canonicalJson(request),
      });
      inspectStorage();
      await resolvePositive(await sendHumanControlReview(localStorage, operation), operation);
    });
  }
  return (
    <section
      aria-label="Human control review"
      className="min-w-0 space-y-3 rounded-lg border border-slate-300 p-3"
    >
      <h3 className="font-semibold text-indigo-900">Record human control review</h3>
      <p className="text-sm">
        Review actual control questions against the saved evidence. Public declarations and field
        detection do not prove implementation. Omitted questions remain unknown; unsupported inputs
        stay unassessed. This records unverified human judgments, not an assessment score or
        released report.
      </p>
      {head?.estateId && (
        <PublicControlAssetSelection
          key={associationRevision}
          tenantId={source.tenantId}
          actorId={actorId}
          estateId={head.estateId}
          checkId={source.checkId}
          payloadSha256={source.projectionSha256}
          hint={assetHint}
          disabled={!canReview || busy || operations.length > 0}
          onConfirmed={associationChanged}
        />
      )}
      {associationRequired && !associationRef && (
        <p>
          Confirm a current matching saved website association before recording a linked review. The
          incoming link and earlier history do not establish new authority.
        </p>
      )}
      {!associationRef && !associationRequired && (
        <p>
          This legacy review records evidence without a registered website asset association. It
          does not establish estate/system ownership. Select and confirm a saved association above
          to record a new linked version explicitly.
        </p>
      )}
      {head?.review?.snapshot.version === 1 && (
        <p>
          Earlier version 1 review: no registered website association was frozen. Its exact history
          and requests remain unchanged.
        </p>
      )}
      {head?.review && (
        <p className="break-all text-sm">
          Latest recorded review
          {head.review.estate_id !== head.estateId ? ' (historical estate context)' : ''}:{' '}
          {head.review.id} ·{' '}
          <Link href={`/ledger?q=${head.review.receipt_id}`} className="underline">
            receipt {head.review.receipt_id}
          </Link>
          .
        </p>
      )}
      {canRun &&
        head?.review &&
        head.review.estate_id === head.estateId &&
        !dirty &&
        !busy &&
        storageReady &&
        operations.length === 0 && (
          <p className="text-sm">
            <Link
              href={`/assessment?${new URLSearchParams({
                engagement: source.engagementId,
                reviewId: head.review.id,
                requestSha256: head.review.request_sha256,
                snapshotSha256: head.review.snapshot_sha256,
              })}`}
              className="underline"
            >
              Request assessment from this recorded human review
            </Link>
            . On Assessment, confirm the exact saved review before submitting. No request starts
            from this link.
          </p>
        )}
      <button
        type="button"
        className={button}
        disabled={busy}
        onClick={() =>
          void task(async () => {
            ++headRevision.current;
            setHead(null);
            setConfirmed(false);
            inspectStorage();
            await readHead();
          })
        }
      >
        Refresh human review
      </button>
      {!validManifest && (
        <p role="alert">
          The displayed controls do not match the reviewed catalogue. Reload verified website
          evidence before recording.
        </p>
      )}
      {dirty && (
        <p role="status">
          Question edits are not in the review draft yet. Add judgment before confirming or
          recording.
        </p>
      )}
      {!head && <p role="status">Load the saved human-review context before recording.</p>}
      {head?.review && head.review.estate_id !== head.estateId && (
        <p>
          The earlier human review belongs to a different estate context. Its history is preserved;
          review new declarations explicitly.
        </p>
      )}
      {!canReview && (
        <p>
          You can read the evidence and recorded judgments. An authorised assessment reviewer
          records new judgments.
        </p>
      )}
      {error && (
        <p role="alert" className="break-words text-sm text-red-700">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="break-words text-sm">
          {notice}
        </p>
      )}
      {operations.map((operation) => {
        const retained = parsePublicControlReviewSetRequestText(operation.requestText);
        const cancellation = cancellations[retained.operationKey] ?? {
          reason: '',
          confirmed: false,
        };
        function updateCancellation(change: Partial<typeof cancellation>) {
          setCancellations((old) => ({
            ...old,
            [retained.operationKey]: { ...cancellation, ...change },
          }));
        }
        const sameSelection =
          retained.engagementId === source.engagementId && retained.checkId === source.checkId;
        return (
          <div
            key={retained.operationKey}
            className="space-y-2 rounded border border-amber-300 p-3 text-sm"
          >
            <p className="break-all">
              Retained human review request {retained.operationKey}. Engagement{' '}
              {retained.engagementId}; check {retained.checkId}. Reconcile this exact request before
              starting another.
            </p>
            {!sameSelection && (
              <p>
                Return to its engagement and saved check before retrying. Read-only reconciliation
                remains available.
              </p>
            )}
            <details>
              <summary>Inspect retained declarations</summary>
              <pre className="whitespace-pre-wrap break-all">{operation.requestText}</pre>
            </details>
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() =>
                void task(async () => {
                  await resolvePositive(await reconcileHumanControlReview(operation), operation);
                })
              }
            >
              Reconcile retained human review
            </button>
            {canReview && (
              <>
                <button
                  type="button"
                  className={button}
                  disabled={busy || !sameSelection || !storageReady}
                  onClick={() =>
                    void task(async () => {
                      await resolvePositive(
                        await sendHumanControlReview(localStorage, operation),
                        operation,
                      );
                    })
                  }
                >
                  Retry exact human review request
                </button>
                <label className="block">
                  Reason to cancel an unrecorded request
                  <textarea
                    className={field}
                    maxLength={2000}
                    value={cancellation.reason}
                    disabled={busy}
                    onChange={(e) => {
                      updateCancellation({ reason: e.target.value, confirmed: false });
                    }}
                  />
                </label>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={cancellation.confirmed}
                    disabled={busy}
                    onChange={(e) => updateCancellation({ confirmed: e.target.checked })}
                  />
                  Cancel only if this request has not recorded a judgment. An existing judgment and
                  all history must remain intact.
                </label>
                <button
                  type="button"
                  className={button}
                  disabled={
                    busy || !storageReady || !cancellation.confirmed || !cancellation.reason.trim()
                  }
                  onClick={() =>
                    void task(async () => {
                      await resolvePositive(
                        await sendHumanControlReview(
                          localStorage,
                          operation,
                          cancellation.reason.trim(),
                        ),
                        operation,
                      );
                    })
                  }
                >
                  Cancel unrecorded human review request
                </button>
              </>
            )}
          </div>
        );
      })}
      {canReview && (
        <fieldset
          disabled={busy || !validManifest || !head || !storageReady || operations.length > 0}
          className="min-w-0 space-y-3"
        >
          <legend className="font-medium">Unverified control declarations</legend>
          <label className="block">
            Control to review
            <select
              className={field}
              value={controlId}
              disabled={dirty}
              onChange={(e) => {
                const selected = manifest.controls.find(
                  (row) => row.control.id === e.target.value,
                )?.control;
                if (selected) selectQuestion(selected.id, selected.assessmentQuestions[0]!.id);
              }}
            >
              {manifest.controls.map(({ control: c }) => (
                <option key={c.id} value={c.id}>
                  {c.id}: {c.title}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            Control question
            <select
              className={field}
              value={questionId}
              disabled={dirty}
              onChange={(e) => selectQuestion(controlId, e.target.value)}
            >
              {control.assessmentQuestions.map((q) => (
                <option value={q.id} key={q.id}>
                  {q.id}: {q.prompt}
                </option>
              ))}
            </select>
          </label>
          <p className="text-sm">
            {question?.prompt}. Related public evidence:{' '}
            {disposition?.evidence.candidateOrdinals.map((n) => `#${n}`).join(', ') ||
              'none mapped; internal evidence may be required'}
            . These references do not establish a passing answer.
          </p>
          {question?.type !== 'boolean' ? (
            <p>
              This {question?.type ?? 'unsupported'} question stays unassessed here and requires its
              supported evidence workflow.
            </p>
          ) : (
            <>
              <label className="block">
                Human declaration
                <select
                  className={field}
                  value={draftAnswer}
                  onChange={(e) => editField(() => setDraftAnswer(e.target.value))}
                >
                  <option value="unknown">Unknown</option>
                  <option value="yes">Yes — unverified declaration</option>
                  <option value="no">No — unverified declaration</option>
                </select>
              </label>
              <label className="block">
                Judgment rationale
                <textarea
                  className={field}
                  maxLength={2000}
                  value={rationale}
                  onChange={(e) => editField(() => setRationale(e.target.value))}
                />
              </label>
              <label className="block">
                Evidence candidate numbers (optional, comma-separated)
                <input
                  className={field}
                  value={candidateText}
                  onChange={(e) => editField(() => setCandidateText(e.target.value))}
                />
              </label>
              <button type="button" className={button} onClick={editJudgment}>
                Add judgment to review draft
              </button>
            </>
          )}
          <p className="text-sm">
            {Object.values(judgments).reduce(
              (count, questions) => count + Object.keys(questions).length,
              0,
            )}{' '}
            explicit question judgments in this draft. Remaining questions stay unknown.
          </p>
          {(
            [
              ['sdfSelfAttested', 'Significant Data Fiduciary designation'],
              ['processesChildren', 'Processes children’s personal data'],
              ['processesHealth', 'Processes health-related personal data'],
            ] as const
          ).map(([id, label]) => (
            <label key={id} className="block">
              {label}
              <select
                className={field}
                value={choice(applicability[id])}
                onChange={(e) => {
                  setApplicability((old) => ({ ...old, [id]: answer(e.target.value) }));
                  setConfirmed(false);
                }}
              >
                <option value="unknown">Unknown</option>
                <option value="yes">Yes — unverified declaration</option>
                <option value="no">No — unverified declaration</option>
              </select>
            </label>
          ))}
          <label className="block">
            Applicability rationale
            <textarea
              className={field}
              maxLength={2000}
              value={applicability.rationale}
              onChange={(e) => {
                setApplicability((old) => ({ ...old, rationale: e.target.value }));
                setConfirmed(false);
              }}
            />
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={dirty}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            I reviewed these declarations and authorise recording a new immutable review revision.
            Public evidence remains qualified, omitted answers unknown, and internal proof
            unresolved.
          </label>
          <button
            type="button"
            className={button}
            disabled={
              dirty ||
              !confirmed ||
              !applicability.rationale.trim() ||
              (associationRequired && !associationRef)
            }
            onClick={record}
          >
            Record human control review
          </button>
          <p className="text-sm">
            Continue a recorded review in Assessment to request a run explicitly. Reports require a
            completed assessment and separate human review and release. Recording this review does
            not invoke Parikshan or release a report.
          </p>
        </fieldset>
      )}
    </section>
  );
}
