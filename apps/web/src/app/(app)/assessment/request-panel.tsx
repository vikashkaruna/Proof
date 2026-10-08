'use client';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import Link from 'next/link';
import { AssessmentRequestSchema, ASSESSMENT_REQUEST_MAX_BYTES } from '@axiom/types';
import { AssessmentQuestionnaireEditor, type ReviewedQuestionnaire } from './questionnaire';
import {
  ASSESSMENT_JOURNAL_CHANGED,
  assessmentJournalKey,
  retainedAssessmentSchema,
  readAssessmentJournal,
  retainAssessmentJournal,
  clearFinalizedAssessmentJournal,
  submitAssessmentRequest,
  cancelUnclaimedAssessmentRequest,
  readAssessmentRequest,
  type RetainedAssessment,
  type AssessmentJobReadout,
} from './request';

interface Props {
  tenantId: string;
  actorId: string;
  engagementId: string;
  libraryVersion: string;
  canRequest: boolean;
  hasSavedResults: boolean;
  onFinalized: () => void;
}
export function AssessmentRequestPanel(props: Props) {
  return (
    <RequestPanel
      key={`${props.tenantId}:${props.actorId}:${props.engagementId}:${props.libraryVersion}:${props.canRequest}`}
      {...props}
    />
  );
}
function RequestPanel({
  tenantId,
  actorId,
  engagementId,
  libraryVersion,
  canRequest,
  hasSavedResults,
  onFinalized,
}: Props) {
  const key = assessmentJournalKey(tenantId, actorId);
  const subscribe = useCallback(
    (notify: () => void) => {
      const storage = (event: StorageEvent) => {
        if (event.key === null || event.key === key) notify();
      };
      window.addEventListener('storage', storage);
      window.addEventListener(ASSESSMENT_JOURNAL_CHANGED, notify);
      return () => {
        window.removeEventListener('storage', storage);
        window.removeEventListener(ASSESSMENT_JOURNAL_CHANGED, notify);
      };
    },
    [key],
  );
  const read = useCallback(() => {
    try {
      return localStorage.getItem(key);
    } catch {
      return '__storage_unavailable__';
    }
  }, [key]);
  const raw = useSyncExternalStore(subscribe, read, () => '__unhydrated__');
  const journal = useMemo(() => {
    if (raw === '__unhydrated__') return { retained: null, ready: false, invalid: false };
    if (raw === null) return { retained: null, ready: true, invalid: false };
    try {
      if (new TextEncoder().encode(raw).length > ASSESSMENT_REQUEST_MAX_BYTES + 1024)
        throw new Error();
      const value = retainedAssessmentSchema.parse(JSON.parse(raw));
      if (value.tenantId !== tenantId || value.actorId !== actorId) throw new Error();
      return { retained: value, ready: true, invalid: false };
    } catch {
      return { retained: null, ready: false, invalid: true };
    }
  }, [raw, tenantId, actorId]);
  const { retained, ready } = journal;
  const [confirmedUnknown, setConfirmedUnknown] = useState(false);
  const [intake, setIntake] = useState(false);
  const [reviewed, setReviewed] = useState<ReviewedQuestionnaire | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; operationKey: string | null } | null>(
    null,
  );
  const [status, setStatus] = useState<AssessmentJobReadout | null>(null);
  const [completedHere, setCompletedHere] = useState(false);
  const [cancelAcknowledgement, setCancelAcknowledgement] = useState<string | null>(null);
  const displayedStatus =
    retained &&
    status?.jobId === retained.request.operationKey &&
    status.engagementId === retained.request.engagementId &&
    status.libraryVersion === retained.libraryVersion
      ? status
      : null;
  const displayedMessage =
    message?.operationKey === (retained?.request.operationKey ?? null) ? message.text : null;
  const recoveryGuidance = displayedStatus ? requestRecoveryGuidance(displayedStatus) : null;
  const active = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function start() {
    if (
      active.current ||
      !ready ||
      !canRequest ||
      retained ||
      hasSavedResults ||
      completedHere ||
      !confirmedUnknown ||
      (intake && !reviewed)
    )
      return;
    active.current = true;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (!navigator.locks)
        throw new Error(
          'This browser cannot safely coordinate assessment requests across tabs. Use a supported browser.',
        );
      await navigator.locks.request(assessmentJournalKey(tenantId, actorId), async () => {
        if (!mounted.current) return;
        const old = readAssessmentJournal(localStorage, tenantId, actorId);
        if (old) {
          throw new Error(
            'Another tab retained an assessment request. Check that request before continuing.',
          );
        }
        const value: RetainedAssessment = {
          tenantId,
          actorId,
          libraryVersion,
          request: AssessmentRequestSchema.parse({
            operationKey: crypto.randomUUID(),
            engagementId,
            ...(intake && reviewed
              ? {
                  answers: reviewed.answers,
                  applicability: reviewed.applicability,
                  expectedQuestionnaire: {
                    libraryVersion,
                    questionnaireDigest: reviewed.questionnaireDigest,
                  },
                }
              : {}),
          }),
          ...(intake && reviewed ? { questionnaireDigest: reviewed.questionnaireDigest } : {}),
        };
        retainAssessmentJournal(localStorage, value);
        await submitAssessmentRequest(value);
        if (mounted.current)
          setMessage({
            text: 'Request accepted. Results are pending; check its recorded status.',
            operationKey: value.request.operationKey,
          });
      });
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : 'The request could not be confirmed. Check its retained status.',
        );
    } finally {
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function check() {
    if (active.current || !retained) return;
    const expected = retained;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      const value = await readAssessmentRequest(expected);
      if (!mounted.current) return;
      const live = readAssessmentJournal(localStorage, tenantId, actorId);
      if (JSON.stringify(live) !== JSON.stringify(expected))
        throw new Error('Retained request changed. Reload before continuing.');
      setStatus(value);
      if (value.status === 'finalization_recorded') {
        setMessage({
          text: 'Assessment finalization is recorded. Review the saved findings and provisional estimates.',
          operationKey: expected.request.operationKey,
        });
        if (expected.request.engagementId === engagementId) {
          setCompletedHere(true);
          onFinalized();
        }
      } else if (value.status === 'resolution_recorded') {
        setMessage({
          text: 'Unclaimed request cancellation is recorded. Review its receipt before archiving this browser reference. This is not worker cleanup or completed assessment proof.',
          operationKey: expected.request.operationKey,
        });
      } else
        setMessage({
          text: `Assessment ${value.phase.replaceAll('_', ' ')}. Completion is not yet confirmed.`,
          operationKey: expected.request.operationKey,
        });
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : 'Recorded status is unavailable.');
    } finally {
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function retry() {
    if (
      active.current ||
      !ready ||
      !canRequest ||
      !retained ||
      retained.request.engagementId !== engagementId ||
      displayedStatus?.status === 'finalization_recorded' ||
      recoveryGuidance !== null
    )
      return;
    const expected = retained;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!navigator.locks)
        throw new Error(
          'This browser cannot safely coordinate assessment requests across tabs. Use a supported browser.',
        );
      await navigator.locks.request(assessmentJournalKey(tenantId, actorId), async () => {
        if (!mounted.current) return;
        const live = readAssessmentJournal(localStorage, tenantId, actorId);
        if (JSON.stringify(live) !== JSON.stringify(expected))
          throw new Error('Retained request changed. Reload before continuing.');
        await submitAssessmentRequest(expected);
        if (mounted.current)
          setMessage({
            text: 'Original request accepted. Check its recorded status; no new request key was created.',
            operationKey: expected.request.operationKey,
          });
      });
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error ? cause.message : 'The original request could not be confirmed.',
        );
    } finally {
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function archive() {
    if (
      busy ||
      !retained ||
      (displayedStatus?.status !== 'finalization_recorded' &&
        displayedStatus?.status !== 'resolution_recorded')
    )
      return;
    try {
      clearFinalizedAssessmentJournal(localStorage, retained, displayedStatus);
      setStatus(null);
      setConfirmedUnknown(false);
      setReviewed(null);
      setIntake(false);
      setCancelAcknowledgement(null);
      setMessage({
        text: 'Resolved request reference archived in this browser. Server records remain available.',
        operationKey: null,
      });
    } catch {
      setError('Retained request changed. Reload before continuing.');
    }
  }
  async function cancel() {
    if (
      active.current ||
      !canRequest ||
      !retained ||
      retained.request.engagementId !== engagementId ||
      cancelAcknowledgement !== retained.request.operationKey ||
      displayedStatus?.status !== 'unconfirmed' ||
      displayedStatus.recordedRunStatus !== 'queued' ||
      displayedStatus.phase !== 'queued' ||
      displayedStatus.claimedAt !== null
    )
      return;
    const expected = retained,
      recorded = displayedStatus;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!navigator.locks)
        throw new Error(
          'This browser cannot safely coordinate assessment requests across tabs. Use a supported browser.',
        );
      await navigator.locks.request(assessmentJournalKey(tenantId, actorId), async () => {
        if (!mounted.current) return;
        const live = readAssessmentJournal(localStorage, tenantId, actorId);
        if (JSON.stringify(live) !== JSON.stringify(expected))
          throw new Error('Retained request changed. Reload before continuing.');
        await cancelUnclaimedAssessmentRequest(expected, recorded);
        if (mounted.current) {
          setStatus(null);
          setCancelAcknowledgement(null);
          setMessage({
            text: 'Cancellation recorded. Check the retained request to verify its resolution before archiving.',
            operationKey: expected.request.operationKey,
          });
        }
      });
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Cancellation could not be confirmed. Keep the original reference.',
        );
    } finally {
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const sameEngagement = !retained || retained.request.engagementId === engagementId;
  return (
    <section
      aria-label="Request a saved assessment"
      className="mb-4 min-w-0 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-700"
    >
      <h2 className="font-semibold text-slate-900">Parikshan assessment request</h2>
      <p className="mt-2">
        Enter reviewed questionnaire declarations or request an unknown-answer draft. Answers and
        applicability flags stay unknown until you explicitly choose otherwise. Estimates are
        provisional and declarations remain unverified; neither establishes compliance. Discovery,
        evidence and reports run separately.
      </p>
      {retained ? (
        <div className="mt-3 space-y-3">
          <p className="break-all">
            Retained request: <span className="font-mono">{retained.request.operationKey}</span>.
            Check its status before starting another request.
          </p>
          {!sameEngagement && (
            <p>
              This request belongs to another assessment.{' '}
              <Link
                className="font-semibold text-teal-700 underline"
                href={`/assessment?engagement=${retained.request.engagementId}`}
              >
                Open that assessment
              </Link>
              .
            </p>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={check}
            className="rounded-lg border border-slate-300 px-3 py-2 font-semibold disabled:opacity-50"
          >
            {busy ? 'Checking request…' : 'Check retained request'}
          </button>
          {recoveryGuidance && <p role="note">{recoveryGuidance}</p>}
          {canRequest &&
            sameEngagement &&
            displayedStatus?.status === 'unconfirmed' &&
            displayedStatus.recordedRunStatus === 'queued' &&
            displayedStatus.phase === 'queued' &&
            displayedStatus.claimedAt === null && (
              <div className="space-y-2">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={cancelAcknowledgement === retained.request.operationKey}
                    onChange={(event) =>
                      setCancelAcknowledgement(
                        event.target.checked ? retained.request.operationKey : null,
                      )
                    }
                  />
                  <span>
                    I want to cancel this original request if it has never been claimed. The server
                    will refuse started work; cancellation does not establish worker cleanup.
                  </span>
                </label>
                <button
                  type="button"
                  disabled={busy || cancelAcknowledgement !== retained.request.operationKey}
                  onClick={cancel}
                  className="rounded-lg border border-slate-300 px-3 py-2 font-semibold disabled:opacity-50"
                >
                  Cancel if not claimed
                </button>
              </div>
            )}
          {canRequest &&
            sameEngagement &&
            displayedStatus?.status !== 'finalization_recorded' &&
            !recoveryGuidance && (
              <button
                type="button"
                disabled={busy || !ready}
                onClick={retry}
                className="ml-2 rounded-lg border border-slate-300 px-3 py-2 font-semibold disabled:opacity-50"
              >
                Retry original request
              </button>
            )}
          {displayedStatus?.status === 'finalization_recorded' && (
            <div>
              <p>
                Finalization receipt:{' '}
                <Link
                  className="font-mono text-teal-700 underline"
                  href={`/ledger?q=${displayedStatus.finalization.finalizedReceipt}`}
                >
                  #{displayedStatus.finalization.finalizedReceipt}
                </Link>
                .
              </p>
              <button
                type="button"
                onClick={archive}
                disabled={busy}
                className="mt-2 rounded-lg border border-slate-300 px-3 py-2 font-semibold"
              >
                Archive completed browser reference
              </button>
            </div>
          )}
          {displayedStatus?.status === 'resolution_recorded' && (
            <div>
              <p>
                Cancellation receipt:{' '}
                <Link
                  className="font-mono text-teal-700 underline"
                  href={`/ledger?q=${displayedStatus.resolution.cancellationReceipt}`}
                >
                  #{displayedStatus.resolution.cancellationReceipt}
                </Link>
                .
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={archive}
                className="mt-2 rounded-lg border border-slate-300 px-3 py-2 font-semibold"
              >
                Archive cancelled browser reference
              </button>
            </div>
          )}
        </div>
      ) : canRequest ? (
        <div className="mt-3 space-y-3">
          {hasSavedResults || completedHere ? (
            <p>
              This assessment already has saved results. Create a separate engagement for another
              assessment.
            </p>
          ) : (
            <>
              {!intake ? (
                <button
                  type="button"
                  disabled={busy || !ready}
                  className="rounded-lg border border-slate-300 px-3 py-2 font-semibold"
                  onClick={() => {
                    setIntake(true);
                    setConfirmedUnknown(false);
                  }}
                >
                  Enter questionnaire declarations
                </button>
              ) : (
                <>
                  <AssessmentQuestionnaireEditor
                    tenantId={tenantId}
                    engagementId={engagementId}
                    libraryVersion={libraryVersion}
                    disabled={busy}
                    onReviewed={(value) => {
                      setReviewed(value);
                      setConfirmedUnknown(false);
                    }}
                  />
                  <button
                    type="button"
                    disabled={busy || !ready}
                    onClick={() => {
                      setIntake(false);
                      setReviewed(null);
                      setConfirmedUnknown(false);
                    }}
                  >
                    Use unknown-answer draft instead
                  </button>
                </>
              )}
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={confirmedUnknown}
                  onChange={(e) => setConfirmedUnknown(e.target.checked)}
                  disabled={busy || !ready || (intake && !reviewed)}
                />
                <span>
                  {intake
                    ? 'I reviewed these exact declarations and understand they remain unverified; unknown answers and unsupported inputs require further review.'
                    : 'I understand that every answer and applicability flag will remain unknown and require review.'}
                </span>
              </label>
              <button
                type="button"
                onClick={start}
                disabled={busy || !ready || !confirmedUnknown || (intake && !reviewed)}
                className="rounded-lg bg-teal-700 px-3 py-2 font-semibold text-white disabled:opacity-50"
              >
                {busy
                  ? 'Submitting request…'
                  : intake
                    ? 'Submit reviewed questionnaire'
                    : 'Request unknown-answer assessment'}
              </button>
            </>
          )}
        </div>
      ) : (
        <p className="mt-3">An assessment owner can request this draft.</p>
      )}
      {displayedMessage && (
        <p role="status" className="mt-3">
          {displayedMessage}
        </p>
      )}
      {(error || journal.invalid) && (
        <p role="alert" className="mt-3 break-words text-red-700">
          {journal.invalid
            ? 'The retained request could not be verified. Ask your administrator to review it before continuing.'
            : error}
        </p>
      )}
    </section>
  );
}

/** These recorded states cannot be repaired by resubmitting the original body.
 * Keep the reference until the server can prove completion or resolution. */
function requestRecoveryGuidance(status: AssessmentJobReadout): string | null {
  if (status.status === 'finalization_recorded') return null;
  if (status.status === 'resolution_recorded')
    return 'This unclaimed request is cancelled. Its original key cannot start another execution. Server records and the cancellation receipt remain available.';
  if (['failed', 'cancelled', 'timed_out'].includes(status.recordedRunStatus))
    return `The saved run is ${status.recordedRunStatus.replaceAll('_', ' ')}. Keep this request reference and ask an assessment administrator to review the recorded run. Retrying cannot restart it; safe cancellation or resolution has not been confirmed.`;
  if (status.schedulingStatus === 'needs_review')
    return 'Dispatch requires administrator review. Keep this request reference and check its recorded status again after review. Retrying cannot repair the dispatch or establish completion.';
  if (status.phase === 'result_recorded' || status.recordedRunStatus === 'succeeded')
    return 'The recorded result still awaits verified controller finalization. Keep this request reference and check again. Retrying cannot finalize the result.';
  return null;
}
