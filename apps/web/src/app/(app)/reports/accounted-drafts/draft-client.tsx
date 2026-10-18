'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import {
  prativedanAssessmentPreviewSchema,
  prativedanAssessmentReadbackSchema,
  prativedanAssessmentSourceSchema,
} from '@axiom/types';
import { reportRequest, prepareReportOperationKey } from '../report-request';
import { button, panel, field } from '../report-ui';

const optionsSchema = z.object({
  assessments: z.array(
    z.object({ assessmentRunId: z.uuid(), engagementId: z.uuid(), engagementTitle: z.string() }),
  ),
});
type Preview = z.infer<typeof prativedanAssessmentPreviewSchema>;
type Journal = z.infer<typeof prativedanAssessmentReadbackSchema>;
export function AccountedDraftClient({ tenantId, actorId }: { tenantId: string; actorId: string }) {
  const key = `axiom:accounted-draft:${tenantId}:${actorId}`;
  const [enabled, setEnabled] = useState(false),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<z.infer<typeof optionsSchema>['assessments']>([]),
    [selected, setSelected] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null),
    [reviewed, setReviewed] = useState(false);
  const [intent, setIntent] = useState(''),
    [journal, setJournal] = useState<Journal | null>(null),
    [error, setError] = useState('');
  const [reason, setReason] = useState(''),
    [contentReviewed, setContentReviewed] = useState(false);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await reportRequest(tenantId, '/reports/accounted-drafts/configuration');
        const config = z
          .object({ data: z.object({ enabled: z.boolean() }) })
          .parse(await response.json());
        if (!active) return;
        setIntent(localStorage.getItem(key) ?? '');
        setEnabled(config.data.enabled);
        if (config.data.enabled) {
          const rows = optionsSchema.parse(
            await (
              await reportRequest(tenantId, '/reports/board/assessment-options?limit=100&offset=0')
            ).json(),
          );
          if (active) setOptions(rows.assessments);
        }
      } catch {
        if (active) setError('Unable to check the dedicated draft controller.');
      } finally {
        if (active) setReady(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [key, tenantId]);
  const post = async (step: string, body: unknown) => {
    const response = await reportRequest(tenantId, `/reports/accounted-drafts/${step}`, {
      body,
      expectedActorId: actorId,
    });
    return z.object({ data: z.unknown() }).parse(await response.json()).data;
  };
  const action = async (run: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await run();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Keep the original request and reconcile its status.',
      );
    } finally {
      setBusy(false);
    }
  };
  const record = (raw: unknown) => {
    const value = z
      .object({
        journal: z.unknown(),
        outcome: z.string().optional(),
        failureCode: z.string().nullable().optional(),
      })
      .safeParse(raw);
    if (value.success && value.data.outcome === 'recorded_failure')
      setError(
        `The original computation has a recorded terminal failure (${value.data.failureCode ?? 'unknown'}). Reconciliation cannot start a replacement computation.`,
      );
    setJournal(prativedanAssessmentReadbackSchema.parse(value.success ? value.data.journal : raw));
  };
  const frozenSource = preview
    ? prativedanAssessmentSourceSchema.parse(JSON.parse(preview.source_text))
    : null;
  const frozenResult = frozenSource
    ? z
        .object({
          findings: z.array(
            z.object({ control_id: z.string(), score: z.number(), rationale: z.string() }),
          ),
          questionnaire_provenance: z.object({
            controls: z.array(
              z.object({
                control_id: z.string(),
                answer_state: z.string(),
                applicability_state: z.string(),
              }),
            ),
          }),
        })
        .parse(JSON.parse(frozenSource.result_text))
    : null;
  const selectedOption = options.find((o) => o.assessmentRunId === selected);
  const unpublished =
    journal && 'state' in journal && journal.state === 'unpublished' ? journal : null;
  return (
    <main className="space-y-6">
      <Link href="/reports">Back to reports</Link>
      <h1 className="text-2xl font-semibold">Accounted assessment draft</h1>
      <p>
        Review a frozen assessment source, then generate an unpublished draft. The deterministic
        renderer uses no model inference. Its recorded empty call journal is verified independently;
        it is not a provider invoice or a compliance attestation.
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
          {!intent ? (
            <section className={panel}>
              <h2 className="font-semibold">1. Review the assessment source</h2>
              <label>
                Finalized assessment
                <select
                  className={field}
                  value={selected}
                  disabled={busy}
                  onChange={(e) => {
                    setSelected(e.target.value);
                    setPreview(null);
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
                disabled={busy || !selectedOption}
                onClick={() =>
                  void action(async () => {
                    if (!selectedOption) return;
                    setPreview(
                      prativedanAssessmentPreviewSchema.parse(
                        await post('preview', {
                          engagementId: selectedOption.engagementId,
                          assessmentRunId: selectedOption.assessmentRunId,
                        }),
                      ),
                    );
                  })
                }
              >
                Load frozen source
              </button>
              {preview && (
                <div className="space-y-3">
                  <dl>
                    <dt>Source commitment</dt>
                    <dd className="break-all font-mono text-xs">{preview.source_sha256}</dd>
                    <dt>Publication</dt>
                    <dd>Unpublished human review only</dd>
                  </dl>
                  <p>
                    Questionnaire declarations remain provisional. Unknown answers and unverified
                    evidence do not establish compliance or corrective closure.
                  </p>
                  {frozenSource && frozenResult && (
                    <div>
                      <p>
                        Frozen source: {frozenSource.title}; catalogue{' '}
                        {frozenSource.library_version}; {frozenResult.findings.length} findings.
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
                            {frozenResult.findings.map((f) => {
                              const d = frozenResult.questionnaire_provenance.controls.find(
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
                    </div>
                  )}
                  <label>
                    <input
                      type="checkbox"
                      checked={reviewed}
                      onChange={(e) => setReviewed(e.target.checked)}
                    />{' '}
                    I reviewed this exact frozen source commitment and its limitations.
                  </label>
                  <button
                    className={button}
                    disabled={busy || !reviewed}
                    onClick={() =>
                      void action(async () => {
                        if (!selectedOption) return;
                        const text = JSON.stringify({
                          operationKey: prepareReportOperationKey(),
                          engagementId: selectedOption.engagementId,
                          assessmentRunId: selectedOption.assessmentRunId,
                          expectedSourceSha256: preview.source_sha256,
                          sourceReviewed: true,
                        });
                        localStorage.setItem(key, text);
                        setIntent(text);
                        record(await post('request', { reviewedRequestText: text }));
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
                The same original request stays in this browser until its outcome is confirmed. A
                lost reply never starts another computation.
              </p>
              <button
                className={button}
                disabled={busy}
                onClick={() =>
                  void action(async () =>
                    record(await post('reconcile', { reviewedRequestText: intent })),
                  )
                }
              >
                Reconcile original request
              </button>
              <button
                className={button}
                disabled={busy || Boolean(unpublished)}
                onClick={() =>
                  void action(async () =>
                    record(await post('generate', { reviewedRequestText: intent })),
                  )
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
          {unpublished && (
            <section className={panel}>
              <h2 className="font-semibold">3. Review unpublished content</h2>
              <p>
                Content commitment:{' '}
                <span className="break-all font-mono text-xs">
                  {unpublished.response_output_sha256}
                </span>
              </p>
              <div className="whitespace-pre-wrap">
                {unpublished.output.sections.map((s, i) => (
                  <section key={i}>
                    <h3 className="font-semibold">{String(s.title)}</h3>
                    {'body' in s && <p>{String(s.body)}</p>}
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
              </div>
              {unpublished.review ? (
                <p role="status">Recorded human decision: {unpublished.review.decision}</p>
              ) : (
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
                        busy ||
                        !contentReviewed ||
                        reason.trim().length < 20 ||
                        reason.trim().length > 2000
                      }
                      onClick={() =>
                        void action(async () =>
                          record(
                            await post('review', {
                              reviewedRequestText: intent,
                              reviewKey: prepareReportOperationKey(),
                              expectedHash: unpublished.response_output_sha256,
                              decision,
                              reason: reason.trim(),
                            }),
                          ),
                        )
                      }
                    >
                      {decision === 'accepted'
                        ? 'Accept unpublished draft'
                        : 'Reject unpublished draft'}
                    </button>
                  ))}
                </>
              )}
              <p>
                This review does not publish, retain or release a board report. Use the separate
                report custody workflow for those decisions.
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
