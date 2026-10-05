'use client';

import { useEffect, useRef, useState } from 'react';
import {
  createPublicSourceReviewSchema,
  publicSourceReviewHistoryResponseSchema,
  publicSourceReviewRecordedResponseSchema,
  publicSourceReviewReconciliationResponseSchema,
  type PublicAgentObservation,
  type PublicSourceReview,
} from '@axiom/types';
import {
  clearReviewOperation,
  dispatchReviewRequest,
  loadReviewOperation,
  recordReviewRefusal,
  reviewOperationPath,
  reviewOperationSchema,
  ReviewRequestError,
  saveReviewOperation,
  type ReviewOperation,
} from './source-review-request';
import { sourceRequest, SourceWorkflowError, validateSourceObservation } from './source-request';
import {
  currentReviewTarget,
  observationBinding,
  reviewRowTarget,
  reviewTargetKey,
  reviewTargets,
  validateReviewContext,
  type ReviewTarget,
} from './source-review-context';

const button =
  'rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-[#1E2A4A] disabled:cursor-not-allowed disabled:opacity-50';
const field = 'mt-1 block w-full rounded-lg border border-slate-300 bg-white p-2 text-sm';
type History = { rows: PublicSourceReview[]; hasMore: boolean; cursor: string | null };

export function SourceReview({
  tenantId,
  actorId,
  canReview,
  observation,
  onWriteLock,
}: {
  tenantId: string;
  actorId: string;
  canReview: boolean;
  observation: PublicAgentObservation | null;
  onWriteLock: (locked: boolean) => void;
}) {
  const [pending, setPending] = useState<ReviewOperation | null>(null);
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const mutex = useRef(false),
    active = useRef(true),
    alert = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    active.current = true;
    void Promise.resolve().then(() => {
      if (!active.current) return;
      try {
        setPending(loadReviewOperation(localStorage, tenantId, actorId));
        setReady(true);
      } catch {
        setStorageError(
          'Review request storage is unavailable or invalid. Resolve it before recording a review.',
        );
      }
    });
    return () => {
      active.current = false;
    };
  }, [tenantId, actorId]);
  useEffect(() => {
    onWriteLock(!ready || !!pending || busy);
  }, [ready, pending, busy, onWriteLock]);
  useEffect(() => {
    if (error || storageError) alert.current?.focus();
  }, [error, storageError]);
  async function task(work: () => Promise<void>) {
    if (mutex.current) return;
    mutex.current = true;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (reason) {
      if (active.current)
        setError(
          reason instanceof SourceWorkflowError
            ? reason.message
            : 'Review could not be confirmed. Keep any retained request and reconcile it before continuing.',
        );
    } finally {
      mutex.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function originalObservation(op: ReviewOperation) {
    const result = await validateSourceObservation(
      await sourceRequest(
        op.tenantId,
        `/public-source-observations/${op.observationId}?engagementId=${op.engagementId}`,
      ),
      op,
    );
    if (result.observation_id !== op.observationId || result.output_sha256 !== op.outputSha256)
      throw new SourceWorkflowError(
        'The recovered observation differs from the original review request.',
      );
    return result;
  }
  function finish(op: ReviewOperation) {
    clearReviewOperation(localStorage, op);
    if (active.current) {
      setPending(null);
      setNotFound(false);
      setRefresh((value) => value + 1);
    }
  }
  async function dispatch(op: ReviewOperation) {
    setNotFound(false);
    try {
      const response = publicSourceReviewRecordedResponseSchema.parse(
        await dispatchReviewRequest(localStorage, op),
      );
      validateReviewContext(response.data, await originalObservation(op), tenantId, op);
      finish(op);
      setNotice('Human source judgment recorded. Assessment closure remains a separate action.');
    } catch (reason) {
      if (reason instanceof ReviewRequestError && reason.refusalCode) {
        recordReviewRefusal(localStorage, op, reason.refusalCode);
        setPending(loadReviewOperation(localStorage, tenantId, actorId));
      }
      throw reason;
    }
  }
  function start(
    target: ReviewTarget,
    decision: 'acknowledged' | 'disputed',
    justification: string,
    previousId: string | null,
  ) {
    void task(async () => {
      if (
        !canReview ||
        !ready ||
        pending ||
        !observation ||
        loadReviewOperation(localStorage, tenantId, actorId)
      )
        throw new SourceWorkflowError(
          'Reconcile any retained review before recording a new judgment.',
        );
      const source = observationBinding(observation);
      const body = createPublicSourceReviewSchema.parse({
        engagementId: source.engagement_id,
        expectedOutputSha256: observation.output_sha256,
        expectedProjectionSha256: source.projection_sha256,
        target,
        decision,
        justification,
        expectedPreviousReviewId: previousId,
      });
      const op = reviewOperationSchema.parse({
        version: 1,
        tenantId,
        actorId,
        operationKey: crypto.randomUUID(),
        engagementId: source.engagement_id,
        bindingId: observation.binding_id,
        observationId: observation.observation_id,
        checkId: source.check_id,
        agent: observation.agent,
        rootSha256: source.root_content_sha256,
        outputSha256: observation.output_sha256,
        projectionSha256: source.projection_sha256,
        bodyUtf8: JSON.stringify(body),
      });
      saveReviewOperation(localStorage, op);
      setPending(op);
      setNotice('');
      await dispatch(op);
    });
  }
  function reconcile() {
    void task(async () => {
      if (!pending) return;
      setNotFound(false);
      const op = loadReviewOperation(localStorage, tenantId, actorId);
      if (!op || JSON.stringify(op) !== JSON.stringify(pending))
        throw new SourceWorkflowError('The retained review changed. Reload before reconciliation.');
      const result = publicSourceReviewReconciliationResponseSchema.parse(
        await sourceRequest(
          op.tenantId,
          `${reviewOperationPath(op)}/request?engagementId=${op.engagementId}`,
          { requestKey: op.operationKey },
        ),
      ).data;
      if (
        result.tenant_id !== op.tenantId ||
        result.actor_id !== op.actorId ||
        result.operation_key !== op.operationKey ||
        result.engagement_id !== op.engagementId ||
        result.binding_id !== op.bindingId ||
        result.observation_id !== op.observationId
      )
        throw new SourceWorkflowError('Reconciliation differs from the original review request.');
      if (result.outcome.state === 'retained') {
        validateReviewContext(result.outcome.review, await originalObservation(op), tenantId, op);
        finish(op);
        setNotice(
          'Original human source judgment recovered. Assessment closure remains a separate action.',
        );
      } else {
        setNotFound(true);
        setNotice(
          op.refusalCode
            ? 'The refused original request has no retained review. You may explicitly discard it and reload current review history.'
            : 'No review is recorded for this original request. An earlier attempt may still finish; any retry uses its exact key and body.',
        );
      }
    });
  }
  return (
    <section
      aria-label="Human source review"
      className="w-full min-w-0 space-y-3 rounded-xl border border-slate-200 p-3 sm:p-4"
    >
      <h3 className="text-lg font-semibold text-[#1E2A4A]">Human source review</h3>
      <p className="text-sm text-slate-600">
        Record a judgment on saved public HTML facts. Whole observation and individual indicator
        judgments have separate histories. Private hosting, backend personal data and cross-border
        processing remain unknown. A judgment does not complete an assessment.
      </p>
      {!canReview && (
        <p className="text-sm">
          Read-only review history. An authorized reviewer can record a judgment.
        </p>
      )}
      {(storageError || error) && (
        <p ref={alert} tabIndex={-1} role="alert" className="text-sm text-[#D9534F]">
          {storageError || error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {busy && (
        <p role="status" className="text-sm">
          Confirming review state…
        </p>
      )}
      {pending && (
        <section
          aria-label="Retained human review request"
          className="space-y-2 rounded-lg border border-slate-300 bg-slate-50 p-3 text-sm"
        >
          <p>
            {pending.refusalCode
              ? `Refused request (${pending.refusalCode}) remains retained until reconciliation.`
              : 'A human review request remains unconfirmed. Reconcile before another judgment.'}
          </p>
          <p className="break-all">
            Original observation: <code>{pending.observationId}</code> · engagement:{' '}
            <code>{pending.engagementId}</code>
          </p>
          <p className="break-all">
            Operation key: <code>{pending.operationKey}</code>
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={button} disabled={busy} onClick={reconcile}>
              Reconcile retained review
            </button>
            {notFound && !pending.refusalCode && canReview && (
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() => void task(() => dispatch(pending))}
              >
                Retry exact retained review
              </button>
            )}
            {notFound && pending.refusalCode && canReview && (
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() =>
                  void task(async () => {
                    finish(pending);
                    setNotice(
                      'Refused request discarded. Load the current target history before recording another judgment.',
                    );
                  })
                }
              >
                Discard refused request and reload current review
              </button>
            )}
          </div>
        </section>
      )}
      {observation ? (
        <ReviewHistory
          key={`${observation.observation_id}/${refresh}`}
          observation={observation}
          tenantId={tenantId}
          canReview={canReview}
          locked={!ready || busy || !!pending}
          onStart={start}
        />
      ) : (
        <p className="text-sm">Select a retained observation to inspect its judgment history.</p>
      )}
    </section>
  );
}

function ReviewHistory({
  observation,
  tenantId,
  canReview,
  locked,
  onStart,
}: {
  observation: PublicAgentObservation;
  tenantId: string;
  canReview: boolean;
  locked: boolean;
  onStart: (
    target: ReviewTarget,
    decision: 'acknowledged' | 'disputed',
    reason: string,
    previousId: string | null,
  ) => void;
}) {
  const targets = reviewTargets(observation);
  const [targetKey, setTarget] = useState('whole_observation');
  const [history, setHistory] = useState<History | null>(null);
  const [busy, setBusy] = useState(true),
    [error, setError] = useState('');
  const [decision, setDecision] = useState<'acknowledged' | 'disputed'>('acknowledged');
  const [reason, setReason] = useState('');
  const active = useRef(true),
    mutex = useRef(false),
    alert = useRef<HTMLParagraphElement>(null);
  const target = targets.find((item) => reviewTargetKey(item.target) === targetKey)!.target;
  const head = currentReviewTarget(history?.rows ?? [], target, history?.hasMore ?? true);
  const rows =
    history?.rows.filter((row) => reviewTargetKey(reviewRowTarget(row)) === targetKey) ?? [];
  const validReason = /\S/u.test(reason) && [...reason].length <= 2000;
  async function read(append = false) {
    if (mutex.current) return;
    mutex.current = true;
    setBusy(true);
    setError('');
    if (!append) setHistory(null);
    try {
      const source = observationBinding(observation);
      const parsed = publicSourceReviewHistoryResponseSchema.parse(
        await sourceRequest(
          tenantId,
          `/public-source-bindings/${observation.binding_id}/observations/${observation.observation_id}/reviews?engagementId=${source.engagement_id}&limit=20${append && history?.cursor ? `&cursor=${encodeURIComponent(history.cursor)}` : ''}`,
        ),
      );
      const next = parsed.data.map((row) => validateReviewContext(row, observation, tenantId));
      const rows = append ? [...(history?.rows ?? []), ...next] : next;
      if (
        rows.length > 10000 ||
        new Set(rows.map((row) => row.review_id)).size !== rows.length ||
        parsed.data.length > parsed.meta.limit ||
        (parsed.meta.hasMore &&
          (!parsed.meta.nextCursor || parsed.data.length !== parsed.meta.limit)) ||
        (!parsed.meta.hasMore && parsed.meta.nextCursor !== null) ||
        (append && parsed.meta.nextCursor === history?.cursor)
      )
        throw new SourceWorkflowError(
          'Review history is inconsistent. Refresh before recording a judgment.',
        );
      if (active.current)
        setHistory({ rows, hasMore: parsed.meta.hasMore, cursor: parsed.meta.nextCursor });
    } catch (failure) {
      if (active.current)
        setError(
          failure instanceof SourceWorkflowError
            ? failure.message
            : 'Review history could not be validated. Refresh before recording a judgment.',
        );
    } finally {
      mutex.current = false;
      if (active.current) setBusy(false);
    }
  }
  useEffect(() => {
    active.current = true;
    void Promise.resolve().then(() => {
      if (active.current) return read();
    });
    return () => {
      active.current = false;
    };
    // The observation-keyed component remounts for source changes and successful writes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (error) alert.current?.focus();
  }, [error]);
  return (
    <div className="min-w-0 space-y-3 text-sm">
      <label>
        Review target
        <select
          className={field}
          value={targetKey}
          onChange={(event) => {
            setTarget(event.target.value);
            setReason('');
          }}
        >
          {targets.map((item) => (
            <option key={reviewTargetKey(item.target)} value={reviewTargetKey(item.target)}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      {busy && <p role="status">Loading human review history…</p>}
      {error && (
        <p ref={alert} role="alert" tabIndex={-1} className="text-[#D9534F]">
          {error}
        </p>
      )}
      <p>
        {head.head
          ? `Current ${head.head.target_kind === 'whole_observation' ? 'whole observation' : 'indicator'} judgment: ${head.head.decision}`
          : head.resolved && history
            ? 'No judgment recorded for this target.'
            : 'Current judgment is unresolved. Load more history or refresh before recording a judgment.'}
      </p>
      <ul className="space-y-2" aria-label="Selected target review history">
        {rows.map((row) => (
          <li key={row.review_id} className="space-y-1 rounded-lg border border-slate-200 p-3">
            <p>
              {row.decision} · {row.is_current ? 'current judgment' : 'superseded judgment'} ·{' '}
              {row.created_at}
            </p>
            <p className="whitespace-pre-wrap break-words">{row.justification}</p>
            <p className="break-all text-xs">
              Reviewer: {row.reviewed_by} · review: {row.review_id} · receipt: {row.review_receipt}{' '}
              · predecessor: {row.previous_review_id ?? 'none'}
            </p>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={busy} onClick={() => void read()}>
          Refresh review history
        </button>
        <button
          type="button"
          className={button}
          disabled={busy || !history?.hasMore}
          onClick={() => void read(true)}
        >
          Load more review history
        </button>
      </div>
      {canReview && (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!locked && !busy && !error && history && head.resolved && validReason)
              onStart(target, decision, reason, head.previousId);
          }}
        >
          <label>
            Human judgment
            <select
              className={field}
              value={decision}
              disabled={locked || busy}
              onChange={(event) => setDecision(event.target.value as 'acknowledged' | 'disputed')}
            >
              <option value="acknowledged">Acknowledge saved facts</option>
              <option value="disputed">Dispute saved facts</option>
            </select>
          </label>
          <label>
            Reason (required)
            <textarea
              className={field}
              required
              aria-describedby="source-review-reason-help"
              disabled={locked || busy}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <p id="source-review-reason-help" className="text-xs text-slate-600">
            Explain your judgment in 1–2000 characters. Original spaces and line breaks are
            retained. {[...reason].length}/2000 characters.
          </p>
          <button
            type="submit"
            className={button}
            disabled={locked || busy || !!error || !history || !head.resolved || !validReason}
          >
            Record human judgment
          </button>
        </form>
      )}
    </div>
  );
}
