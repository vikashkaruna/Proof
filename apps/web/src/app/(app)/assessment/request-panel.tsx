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
import { AssessmentRequestSchema } from '@axiom/types';
import {
  ASSESSMENT_JOURNAL_CHANGED,
  assessmentJournalKey,
  retainedAssessmentSchema,
  readAssessmentJournal,
  retainAssessmentJournal,
  clearFinalizedAssessmentJournal,
  submitUnknownAssessment,
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
      if (raw.length > 4096) throw new Error();
      const value = retainedAssessmentSchema.parse(JSON.parse(raw));
      if (value.tenantId !== tenantId || value.actorId !== actorId) throw new Error();
      return { retained: value, ready: true, invalid: false };
    } catch {
      return { retained: null, ready: false, invalid: true };
    }
  }, [raw, tenantId, actorId]);
  const { retained, ready } = journal;
  const [confirmedUnknown, setConfirmedUnknown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; operationKey: string | null } | null>(
    null,
  );
  const [status, setStatus] = useState<AssessmentJobReadout | null>(null);
  const [completedHere, setCompletedHere] = useState(false);
  const displayedStatus =
    retained &&
    status?.jobId === retained.request.operationKey &&
    status.engagementId === retained.request.engagementId &&
    status.libraryVersion === retained.libraryVersion
      ? status
      : null;
  const displayedMessage =
    message?.operationKey === (retained?.request.operationKey ?? null) ? message.text : null;
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
      !confirmedUnknown
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
          }),
        };
        retainAssessmentJournal(localStorage, value);
        await submitUnknownAssessment(value);
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
      displayedStatus?.status === 'finalization_recorded'
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
        await submitUnknownAssessment(expected);
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
    if (busy || !retained || displayedStatus?.status !== 'finalization_recorded') return;
    try {
      clearFinalizedAssessmentJournal(localStorage, retained, displayedStatus);
      setStatus(null);
      setMessage({
        text: 'Completed request reference cleared from this browser. Saved results remain available.',
        operationKey: null,
      });
    } catch {
      setError('Retained request changed. Reload before continuing.');
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
        An unknown-answer draft keeps all questionnaire answers and applicability flags unknown. It
        produces provisional estimates for review; it does not establish compliance. Discovery,
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
          {canRequest && sameEngagement && displayedStatus?.status !== 'finalization_recorded' && (
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
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={confirmedUnknown}
                  onChange={(e) => setConfirmedUnknown(e.target.checked)}
                  disabled={busy || !ready}
                />
                <span>
                  I understand that every answer and applicability flag will remain unknown and
                  require review.
                </span>
              </label>
              <button
                type="button"
                onClick={start}
                disabled={busy || !ready || !confirmedUnknown}
                className="rounded-lg bg-teal-700 px-3 py-2 font-semibold text-white disabled:opacity-50"
              >
                {busy ? 'Submitting request…' : 'Request unknown-answer assessment'}
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
