'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentLabel } from '@axiom/ui';
import { z } from 'zod';
import { detailSchema, type ReportDetail } from './report-contract';
import { reportRequest } from './report-request';
import { button, field, panel, failure } from './report-ui';

const uuid = z.uuid();
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const assessmentSchema = z.object({
  assessmentRunId: uuid,
  engagementId: uuid,
  engagementTitle: z.string(),
  finalizedAt: z.string(),
  libraryVersion: z.string(),
});
const assessmentsSchema = z.object({
  assessments: z.array(assessmentSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
const requestSchema = z.object({
  id: uuid,
  engagementId: uuid,
  assessmentRunId: uuid,
  reportId: uuid.nullable(),
  title: z.string(),
  status: z.enum(['requested', 'drafted', 'reviewed', 'released', 'rejected']),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const requestsSchema = z.object({
  requests: z.array(requestSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
const versionSchema = z.object({
  sha256: hash,
  versionId: z.string().min(1),
  byteSize: z.number().int().positive(),
  retainUntil: z.string(),
});
const artifactSchema = z.object({
  reportId: uuid,
  reportStatus: z.enum(['draft', 'approved', 'rejected', 'published', 'archived']),
  status: z.enum(['not_started', 'pending', 'settled']),
  buildId: uuid.nullable(),
  operationKey: uuid.nullable(),
  retainUntil: z.string().nullable(),
  lastErrorCode: z.string().nullable(),
  source: versionSchema.nullable(),
  pdf: versionSchema.nullable(),
});
type Assessment = z.infer<typeof assessmentSchema>;
type BoardRequest = z.infer<typeof requestSchema>;
type Artifact = z.infer<typeof artifactSchema>;

const pageSize = 20;
const date = (value: string) => new Date(value).toLocaleString();

type BoardWorkflowProps = {
  tenantId: string;
  canRequest: boolean;
  canManage: boolean;
  onOpenReport: (reportId: string) => void;
  onChanged: () => void;
};

export function BoardWorkflow(props: BoardWorkflowProps) {
  return <TenantBoardWorkflow key={props.tenantId} {...props} />;
}

function TenantBoardWorkflow({
  tenantId,
  canRequest,
  canManage,
  onOpenReport,
  onChanged,
}: BoardWorkflowProps) {
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [assessmentTotal, setAssessmentTotal] = useState(0);
  const [assessmentOffset, setAssessmentOffset] = useState(0);
  const [requests, setRequests] = useState<BoardRequest[]>([]);
  const [requestTotal, setRequestTotal] = useState(0);
  const [requestOffset, setRequestOffset] = useState(0);
  const [selectedRun, setSelectedRun] = useState('');
  const [selectedRequest, setSelectedRequest] = useState('');
  const [title, setTitle] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [releaseConfirmed, setReleaseConfirmed] = useState(false);
  const [detailState, setDetailState] = useState<{
    reportId: string;
    report: ReportDetail | null;
    artifact: Artifact;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [revision, setRevision] = useState(0);
  const requestKey = useRef<string | null>(null);
  const buildKey = useRef<string | null>(null);
  const selected = requests.find((item) => item.id === selectedRequest) ?? null;
  const report =
    detailState && detailState.reportId === selected?.reportId ? detailState.report : null;
  const artifact =
    detailState && detailState.reportId === selected?.reportId ? detailState.artifact : null;
  const chosen = assessments.find((item) => item.assessmentRunId === selectedRun) ?? null;
  const refresh = useCallback(() => {
    setLoading(true);
    setDetailState(null);
    setRevision((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!canRequest) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const [assessmentResponse, requestResponse] = await Promise.all([
          reportRequest(
            tenantId,
            `/reports/board/assessment-options?limit=${pageSize}&offset=${assessmentOffset}`,
            { signal: controller.signal },
          ),
          reportRequest(
            tenantId,
            `/reports/board/requests?limit=${pageSize}&offset=${requestOffset}`,
            { signal: controller.signal },
          ),
        ]);
        const options = assessmentsSchema.parse(await assessmentResponse.json());
        const listed = requestsSchema.parse(await requestResponse.json());
        if (controller.signal.aborted) return;
        setAssessments(options.assessments);
        setAssessmentTotal(options.total);
        setRequests(listed.requests);
        setRequestTotal(listed.total);
      } catch (cause) {
        if (!controller.signal.aborted) setError(failure(cause));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [tenantId, canRequest, assessmentOffset, requestOffset, revision]);

  useEffect(() => {
    if (!selected?.reportId) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const artifactResponse = await reportRequest(
          tenantId,
          `/reports/board/${selected.reportId}/artifacts/status`,
          { signal: controller.signal },
        );
        const versions = artifactSchema.parse(await artifactResponse.json());
        const detail =
          canManage || versions.reportStatus === 'published'
            ? z.object({ data: detailSchema }).parse(
                await (
                  await reportRequest(tenantId, `/reports/${selected.reportId}`, {
                    signal: controller.signal,
                  })
                ).json(),
              ).data
            : null;
        if (!controller.signal.aborted) {
          setDetailState({ reportId: selected.reportId!, report: detail, artifact: versions });
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(failure(cause));
      }
    };
    void load();
    return () => controller.abort();
  }, [tenantId, canManage, selected?.reportId, revision]);

  async function act(path: string, body: unknown) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await reportRequest(tenantId, path, { body });
      const result = await response.json();
      setMessage(
        response.status === 202
          ? 'The retained-object outcome is pending. Reconcile the same recorded build before considering an explicit missing-object retry.'
          : 'The recorded board state has been updated.',
      );
      refresh();
      onChanged();
      return result as unknown;
    } catch (cause) {
      setError(failure(cause));
      return null;
    } finally {
      setBusy(false);
    }
  }

  if (!canRequest) return null;
  return (
    <section aria-label="Board report workflow" className={`${panel} space-y-5`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div>
            <AgentLabel agent="prativedan" />
            <h2 className="text-lg font-semibold text-[#1E2A4A]">Board reports</h2>
            <p className="text-sm text-slate-600">
              Request a draft from a finalized assessment. A founder reviews the exact content,
              retains its source and PDF versions, then releases the reviewed PDF.
            </p>
          </div>
        </div>
        <button type="button" className={button} disabled={loading || busy} onClick={refresh}>
          Refresh board state
        </button>
      </div>
      {error && (
        <p role="alert" className="text-[#D9534F]">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-teal-800">
          {message}
        </p>
      )}
      <form
        aria-label="Request board report"
        className="grid gap-3 rounded-lg border border-slate-200 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!chosen || !confirmed || !title.trim()) return;
          requestKey.current ??= crypto.randomUUID();
          void act('/reports/board/request', {
            engagementId: chosen.engagementId,
            assessmentRunId: chosen.assessmentRunId,
            title: title.trim(),
            operationKey: requestKey.current,
          }).then((result) => {
            if (!result) return;
            requestKey.current = null;
            setTitle('');
            setSelectedRun('');
            setConfirmed(false);
          });
        }}
      >
        <h3 className="font-semibold">Request from a finalized assessment</h3>
        <div className="text-sm">
          <label htmlFor="board-assessment" className="block">
            Assessment
          </label>
          <select
            id="board-assessment"
            className={`${field} mt-1 w-full`}
            value={selectedRun}
            disabled={busy || loading}
            onChange={(event) => {
              setSelectedRun(event.target.value);
              setConfirmed(false);
            }}
          >
            <option value="">Choose a finalized assessment</option>
            {assessments.map((item) => (
              <option key={item.assessmentRunId} value={item.assessmentRunId}>
                {item.engagementTitle} · {date(item.finalizedAt)} · {item.libraryVersion}
              </option>
            ))}
          </select>
        </div>
        {assessments.length === 0 && !loading && (
          <p className="text-sm text-slate-600">
            No finalized assessments are available in this tenant yet. Complete and confirm an
            assessment before requesting a board draft.
          </p>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            className={button}
            disabled={assessmentOffset === 0 || loading}
            onClick={() => {
              setLoading(true);
              setAssessmentOffset(Math.max(0, assessmentOffset - pageSize));
            }}
          >
            Previous assessments
          </button>
          <button
            type="button"
            className={button}
            disabled={assessmentOffset + pageSize >= assessmentTotal || loading}
            onClick={() => {
              setLoading(true);
              setAssessmentOffset(assessmentOffset + pageSize);
            }}
          >
            Next assessments
          </button>
        </div>
        <label className="text-sm">
          Report title
          <input
            className={`${field} mt-1 w-full`}
            value={title}
            maxLength={300}
            required
            disabled={busy}
            onChange={(event) => {
              setTitle(event.target.value);
              setConfirmed(false);
            }}
          />
        </label>
        <label className="flex gap-2 text-sm">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={busy || !chosen}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          I request a draft bound to this finalized assessment and its recorded control library.
        </label>
        <button
          type="submit"
          className={button}
          disabled={busy || !chosen || !confirmed || !title.trim()}
        >
          Request board draft
        </button>
      </form>
      <div aria-label="Board report requests" className="space-y-3">
        <h3 className="font-semibold">Recorded requests</h3>
        {loading && <p role="status">Loading board requests…</p>}
        {!loading && requests.length === 0 && (
          <p className="text-sm text-slate-600">
            No board report requests are recorded for this view.
          </p>
        )}
        <ul className="space-y-2">
          {requests.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="w-full rounded-lg border border-slate-200 p-3 text-left hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-teal-600"
                aria-pressed={selectedRequest === item.id}
                onClick={() => {
                  setSelectedRequest(item.id);
                  setDetailState(null);
                  setReleaseConfirmed(false);
                  buildKey.current = null;
                  setError('');
                  setMessage('');
                }}
              >
                <span className="block font-medium">{item.title}</span>
                <span className="block text-sm text-slate-600">
                  {item.status} · Requested {date(item.createdAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <button
            type="button"
            className={button}
            disabled={requestOffset === 0 || loading}
            onClick={() => {
              setLoading(true);
              setRequestOffset(Math.max(0, requestOffset - pageSize));
            }}
          >
            Previous requests
          </button>
          <button
            type="button"
            className={button}
            disabled={requestOffset + pageSize >= requestTotal || loading}
            onClick={() => {
              setLoading(true);
              setRequestOffset(requestOffset + pageSize);
            }}
          >
            Next requests
          </button>
        </div>
      </div>
      {selected && (
        <div
          aria-label="Selected board request"
          className="space-y-3 rounded-lg border border-slate-200 p-4"
        >
          <h3 className="font-semibold">{selected.title}</h3>
          <p className="text-sm text-slate-600">
            Assessment run {selected.assessmentRunId} · Request {selected.id}
          </p>
          {canManage && !selected.reportId && selected.status === 'requested' && (
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() => void act(`/reports/board/${selected.id}/generate`, {})}
            >
              Generate source-bound draft
            </button>
          )}
          {selected.reportId && (
            <>
              {(canManage || artifact?.reportStatus === 'published') && (
                <button
                  type="button"
                  className={button}
                  onClick={() => onOpenReport(selected.reportId!)}
                >
                  Open report for review
                </button>
              )}
              {!canManage && artifact?.reportStatus !== 'published' && (
                <p className="text-sm text-slate-600">
                  The draft is private to the internal founder until reviewed and released.
                </p>
              )}
              {report && (
                <p className="text-sm">
                  Report status: {report.status} · Content SHA-256:{' '}
                  <code className="break-all">{report.contentHash}</code>
                </p>
              )}
              {artifact && (
                <div className="space-y-2 text-sm">
                  <p>Retained artifact build: {artifact.status}</p>
                  {artifact.lastErrorCode && (
                    <p className="text-[#D9534F]">
                      Last recorded storage outcome: {artifact.lastErrorCode}
                    </p>
                  )}
                  {artifact.source && (
                    <p>
                      Source SHA-256: <code className="break-all">{artifact.source.sha256}</code> ·
                      Version {artifact.source.versionId}
                    </p>
                  )}
                  {artifact.pdf && (
                    <p>
                      PDF SHA-256: <code className="break-all">{artifact.pdf.sha256}</code> ·
                      Version {artifact.pdf.versionId} · Retain until{' '}
                      {date(artifact.pdf.retainUntil)}
                    </p>
                  )}
                </div>
              )}
              {canManage && report?.status === 'approved' && artifact?.status === 'not_started' && (
                <button
                  type="button"
                  className={button}
                  disabled={busy}
                  onClick={() => {
                    buildKey.current ??= crypto.randomUUID();
                    void act(`/reports/board/${selected.reportId}/artifacts`, {
                      operationKey: buildKey.current,
                    });
                  }}
                >
                  Build and retain reviewed source and PDF
                </button>
              )}
              {canManage && artifact?.status === 'pending' && artifact.operationKey && (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={button}
                    disabled={busy}
                    onClick={() =>
                      void act(`/reports/board/${selected.reportId}/artifacts/reconcile`, {
                        operationKey: artifact.operationKey,
                      })
                    }
                  >
                    Reconcile recorded build
                  </button>
                  <button
                    type="button"
                    className={button}
                    disabled={busy}
                    onClick={() =>
                      void act(`/reports/board/${selected.reportId}/artifacts/retry-missing`, {
                        operationKey: artifact.operationKey,
                      })
                    }
                  >
                    Retry only provider-confirmed missing object
                  </button>
                </div>
              )}
              {artifact?.status === 'settled' && artifact.pdf && (
                <a
                  className={button}
                  href={`/api/bff/v1/reports/board/${selected.reportId}/pdf`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Preview retained PDF
                </a>
              )}
              {canManage &&
                report?.status === 'approved' &&
                report.contentHash &&
                artifact?.status === 'settled' &&
                artifact.pdf && (
                  <div className="space-y-2">
                    <label className="flex gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={releaseConfirmed}
                        disabled={busy}
                        onChange={(event) => setReleaseConfirmed(event.target.checked)}
                      />
                      I reviewed the exact content and retained PDF hash and authorize tenant
                      release.
                    </label>
                    <button
                      type="button"
                      className={button}
                      disabled={busy || !releaseConfirmed}
                      onClick={() =>
                        void act(`/reports/${selected.reportId}/release`, {
                          expectedContentHash: report.contentHash,
                          expectedArchiveHash: artifact.pdf!.sha256,
                        })
                      }
                    >
                      Release retained board report
                    </button>
                  </div>
                )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
