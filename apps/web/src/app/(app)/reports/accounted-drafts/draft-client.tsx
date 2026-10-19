'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import { canonicalJson } from '@axiom/ledger';
import type { PrativedanAssessmentReadback } from '@axiom/types';
import { prepareReportOperationKey } from '../report-request';
import { button, panel, field } from '../report-ui';
import {
  assertDraftIntent,
  intentKey,
  readDraftJournal,
  retainDraftRequest,
  retainDraftReview,
  withDraftJournalLock,
  type DraftRequestIntent,
  type DraftReviewIntent,
} from './draft-journal';
import { requestDraft } from './draft-transport';
import { parseDraftPreview, parseRecordedDraft } from './draft-view';
const optionsSchema = z.object({
  assessments: z
    .array(
      z.object({
        assessmentRunId: z.uuid(),
        engagementId: z.uuid(),
        engagementTitle: z.string().max(1000),
      }),
    )
    .max(100),
});
type SourceView = Awaited<ReturnType<typeof parseDraftPreview>>;
export function AccountedDraftClient({ tenantId, actorId }: { tenantId: string; actorId: string }) {
  const scope = `${tenantId}:${actorId}`;
  const active = useRef<string | null>(scope),
    inFlight = useRef(false),
    observed = useRef(new Map<string, string>());
  const [enabled, setEnabled] = useState(false),
    [ready, setReady] = useState(false),
    [storageReady, setStorageReady] = useState(false),
    [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<z.infer<typeof optionsSchema>['assessments']>([]),
    [selected, setSelected] = useState('');
  const [source, setSource] = useState<SourceView | null>(null),
    [reviewed, setReviewed] = useState(false);
  const [request, setRequest] = useState<DraftRequestIntent | null>(null),
    [review, setReview] = useState<DraftReviewIntent | null>(null);
  const [journal, setJournal] = useState<PrativedanAssessmentReadback | null>(null),
    [error, setError] = useState('');
  const [reason, setReason] = useState(''),
    [contentReviewed, setContentReviewed] = useState(false);
  useLayoutEffect(() => {
    active.current = scope;
    return () => {
      active.current = null;
    };
  }, [scope]);
  const current = () => {
    if (active.current !== scope)
      throw new Error('Current organization or account changed. Keep the original request.');
  };
  const read = () => {
    const state = readDraftJournal(localStorage, tenantId, actorId);
    for (const value of [state.request, state.review])
      if (value) {
        const key = intentKey(value),
          text = canonicalJson(value),
          previous = observed.current.get(key);
        if (previous !== undefined && previous !== text)
          throw new Error(
            'Retained intent changed in another tab. Preserve the original and reload before continuing.',
          );
        observed.current.set(key, text);
      }
    return state;
  };
  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const config = z
          .object({ data: z.object({ enabled: z.boolean() }) })
          .parse(await requestDraft(tenantId, actorId, '/reports/accounted-drafts/configuration'));
        if (!mounted) return;
        setEnabled(config.data.enabled);
        if (config.data.enabled) {
          const [state, rows] = await Promise.all([
            withDraftJournalLock(tenantId, actorId, async () => read()),
            requestDraft(tenantId, actorId, '/reports/board/assessment-options?limit=100&offset=0'),
          ]);
          if (!mounted) return;
          setRequest(state.request);
          setReview(state.review);
          setOptions(optionsSchema.parse(rows).assessments);
          setStorageReady(true);
        }
      } catch (cause) {
        if (mounted) {
          setStorageReady(false);
          setError(
            cause instanceof Error
              ? cause.message
              : 'Browser storage is unavailable. Nothing was sent.',
          );
        }
      } finally {
        if (mounted) setReady(true);
      }
    };
    const changed = () => {
      void withDraftJournalLock(tenantId, actorId, async () => {
        const state = read();
        if (mounted) {
          setRequest(state.request);
          setReview(state.review);
        }
      }).catch(() => {
        if (mounted) {
          setStorageReady(false);
          setError(
            'Retained intent changed or storage is unavailable. Preserve the original request and reload.',
          );
        }
      });
    };
    void load();
    window.addEventListener('storage', changed);
    return () => {
      mounted = false;
      window.removeEventListener('storage', changed);
    };
    // Scope is fixed by the server's actor+tenant component key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, actorId]);
  const action = async (run: (state: ReturnType<typeof readDraftJournal>) => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await withDraftJournalLock(tenantId, actorId, async () => {
        current();
        const state = read();
        if (request) {
          assertDraftIntent(localStorage, request);
          if (review) assertDraftIntent(localStorage, review);
        } else if (state.request)
          throw new Error('Another tab retained a request. Reload and reconcile it first.');
        await run(state);
      });
    } catch (cause) {
      if (active.current === scope)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Keep the original request and reconcile its recorded state.',
        );
    } finally {
      inFlight.current = false;
      if (active.current === scope) setBusy(false);
    }
  };
  const post = async (
    step: string,
    body: unknown,
    intent?: DraftRequestIntent | DraftReviewIntent,
  ) => {
    current();
    if (intent) assertDraftIntent(localStorage, intent);
    const result = await requestDraft(tenantId, actorId, `/reports/accounted-drafts/${step}`, body);
    current();
    if (intent) assertDraftIntent(localStorage, intent);
    return z.object({ data: z.unknown() }).parse(result).data;
  };
  const record = (
    raw: unknown,
    original: DraftRequestIntent,
    retainedReview: DraftReviewIntent | null,
  ) => {
    current();
    const result = parseRecordedDraft(raw, original, retainedReview);
    setJournal(result.journal);
    if (result.outcome === 'recorded_failure')
      setError(
        `The original computation has a recorded terminal failure (${result.failureCode ?? 'unknown'}). Reconciliation cannot start a replacement computation.`,
      );
  };
  const selectedOption = options.find((o) => o.assessmentRunId === selected);
  const unpublished =
    journal && 'state' in journal && journal.state === 'unpublished' ? journal : null;
  const blocked = busy || !storageReady;
  const reconcile = async () =>
    action(async (state) => {
      if (!state.request) throw new Error('Original request is unavailable.');
      record(
        await post(
          'reconcile',
          { reviewedRequestText: state.request.reviewedRequestText },
          state.request,
        ),
        state.request,
        state.review,
      );
    });
  const submitReview = async (
    state: ReturnType<typeof readDraftJournal>,
    decision?: 'accepted' | 'rejected',
  ) => {
    if (!state.request || !unpublished)
      throw new Error('Read the exact unpublished draft before reviewing it.');
    const retained =
      state.review ??
      retainDraftReview(localStorage, state.request, {
        version: 1,
        kind: 'review',
        tenantId,
        actorId,
        reviewedRequestText: state.request.reviewedRequestText,
        reviewKey: prepareReportOperationKey(),
        expectedHash: unpublished.response_output_sha256,
        decision: decision!,
        reason: reason.trim(),
      });
    if (decision && state.review)
      throw new Error('A review decision is retained. Reconcile or retry that exact decision.');
    setReview(retained);
    observed.current.set(intentKey(retained), canonicalJson(retained));
    const {
      version: _version,
      kind: _kind,
      tenantId: _tenant,
      actorId: _actor,
      ...body
    } = retained;
    record(await post('review', body, retained), state.request, retained);
  };
  return (
    <main className="space-y-6">
      <Link href="/reports">Back to reports</Link>
      <h1 className="text-2xl font-semibold">Accounted assessment draft</h1>
      <p>
        Review a frozen assessment source, then generate an unpublished deterministic draft. Its
        real empty model-call journal is verified independently; it is not a provider invoice or
        compliance attestation.
      </p>
      {!ready ? (
        <p>Checking controller…</p>
      ) : !enabled ? (
        <p role="status">
          The dedicated draft controller is not configured. Existing board and auditor reports
          remain available from Reports.
        </p>
      ) : (
        <>
          {!request ? (
            <section className={panel}>
              <h2 className="font-semibold">1. Review the assessment source</h2>
              <label>
                Finalized assessment
                <select
                  className={field}
                  value={selected}
                  disabled={blocked}
                  onChange={(e) => {
                    setSelected(e.target.value);
                    setSource(null);
                    setReviewed(false);
                  }}
                >
                  <option value="">Choose an assessment</option>
                  {options.map((o) => (
                    <option key={o.assessmentRunId} value={o.assessmentRunId}>
                      {o.engagementTitle}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className={button}
                disabled={blocked || !selectedOption}
                onClick={() =>
                  void action(async () => {
                    if (!selectedOption) return;
                    const raw = await post('preview', {
                      engagementId: selectedOption.engagementId,
                      assessmentRunId: selectedOption.assessmentRunId,
                    });
                    setSource(
                      await parseDraftPreview(
                        raw,
                        tenantId,
                        selectedOption.engagementId,
                        selectedOption.assessmentRunId,
                      ),
                    );
                  })
                }
              >
                Load frozen source
              </button>
              {source && (
                <div className="space-y-3">
                  <p>
                    {source.source.title}; catalogue {source.source.library_version};{' '}
                    {source.result.findings.length} findings.
                  </p>
                  <p className="break-all font-mono text-xs">
                    Source commitment: {source.preview.source_sha256}
                  </p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr>
                          <th>Control</th>
                          <th>Answer declaration</th>
                          <th>Applicability</th>
                          <th>Source score (provisional)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {source.result.findings.map((f) => {
                          const d = source.result.questionnaire_provenance.controls.find(
                            (x) => x.control_id === f.control_id,
                          );
                          return (
                            <tr key={f.control_id}>
                              <td>{f.control_id}</td>
                              <td>{d?.answer_state.replaceAll('_', ' ')}</td>
                              <td>{d?.applicability_state.replaceAll('_', ' ')}</td>
                              <td>{f.score}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <p>
                    Source scores record questionnaire computation. Unknown declarations remain
                    unknown; evidence is unverified.
                  </p>
                  <label>
                    <input
                      type="checkbox"
                      checked={reviewed}
                      onChange={(e) => setReviewed(e.target.checked)}
                    />{' '}
                    I reviewed this exact frozen source and its limitations.
                  </label>
                  <button
                    className={button}
                    disabled={blocked || !reviewed}
                    onClick={() =>
                      void action(async () => {
                        if (!selectedOption) return;
                        const text = canonicalJson({
                          operationKey: prepareReportOperationKey(),
                          engagementId: selectedOption.engagementId,
                          assessmentRunId: selectedOption.assessmentRunId,
                          expectedSourceSha256: source.preview.source_sha256,
                          sourceReviewed: true,
                        });
                        const retained = retainDraftRequest(localStorage, {
                          version: 1,
                          kind: 'request',
                          tenantId,
                          actorId,
                          reviewedRequestText: text,
                        });
                        observed.current.set(intentKey(retained), canonicalJson(retained));
                        setRequest(retained);
                        record(
                          await post('request', { reviewedRequestText: text }, retained),
                          retained,
                          null,
                        );
                      })
                    }
                  >
                    Record reviewed draft request
                  </button>
                </div>
              )}
            </section>
          ) : (
            <section className={panel}>
              <h2 className="font-semibold">2. Generate or reconcile the retained request</h2>
              <p>
                The same original request stays retained across reloads. A lost reply never
                authorizes another computation.
              </p>
              <button className={button} disabled={blocked} onClick={() => void reconcile()}>
                Reconcile original request
              </button>
              <button
                className={button}
                disabled={blocked || Boolean(unpublished)}
                onClick={() =>
                  void action(async (state) => {
                    if (!state.request) throw new Error('Original request unavailable.');
                    record(
                      await post(
                        'generate',
                        { reviewedRequestText: state.request.reviewedRequestText },
                        state.request,
                      ),
                      state.request,
                      state.review,
                    );
                  })
                }
              >
                Generate or recover original draft
              </button>
              {journal && (
                <p role="status">
                  Recorded state: {'state' in journal ? journal.state : 'request not found'}
                </p>
              )}
            </section>
          )}
          {review && !unpublished?.review && (
            <section className={panel}>
              <h2 className="font-semibold">Retained original review decision</h2>
              <p>
                {review.decision}: {review.reason}
              </p>
              <p>
                Reconcile the recorded draft first. If the exact decision is absent, retry only this
                same retained review.
              </p>
              {unpublished && (
                <button
                  className={button}
                  disabled={blocked}
                  onClick={() => void action((state) => submitReview(state))}
                >
                  Retry original review decision
                </button>
              )}
            </section>
          )}
          {unpublished && (
            <section className={panel}>
              <h2 className="font-semibold">3. Review unpublished content</h2>
              <p className="break-all font-mono text-xs">
                Content commitment: {unpublished.response_output_sha256}
              </p>
              {unpublished.output.sections.map((s, i) => (
                <section key={i}>
                  <h3 className="font-semibold">{s.title}</h3>
                  {'body' in s && <p>{s.body}</p>}
                  {'items' in s && (
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr>
                          <th>Control</th>
                          <th>Finding</th>
                          <th>Severity</th>
                          <th>Provisional source score</th>
                          <th>Rationale</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.items.map((f) => (
                          <tr key={f.control_id}>
                            <td>{f.control_id}</td>
                            <td>{f.title}</td>
                            <td>{f.severity}</td>
                            <td>{f.score}</td>
                            <td>{f.rationale}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </section>
              ))}
              {unpublished.review ? (
                <p role="status">Recorded human decision: {unpublished.review.decision}</p>
              ) : (
                !review && (
                  <>
                    <label>
                      <input
                        type="checkbox"
                        checked={contentReviewed}
                        onChange={(e) => setContentReviewed(e.target.checked)}
                      />{' '}
                      I reviewed this exact unpublished content.
                    </label>
                    <label>
                      Review reason (20–2,000 characters)
                      <textarea
                        className={field}
                        maxLength={2000}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                      />
                    </label>
                    {(['accepted', 'rejected'] as const).map((decision) => (
                      <button
                        key={decision}
                        className={button}
                        disabled={
                          blocked ||
                          !contentReviewed ||
                          reason.trim().length < 20 ||
                          reason.trim().length > 2000
                        }
                        onClick={() => void action((state) => submitReview(state, decision))}
                      >
                        {decision === 'accepted'
                          ? 'Accept unpublished draft'
                          : 'Reject unpublished draft'}
                      </button>
                    ))}
                  </>
                )
              )}
              <p>
                This review does not retain, publish or release a working report. Use its separate
                custody workflow.
              </p>
            </section>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </main>
  );
}
