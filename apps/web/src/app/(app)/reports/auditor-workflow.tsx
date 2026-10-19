'use client';
import { requestReviewGuidance } from './report-review-guidance';

import { formatDateTime } from '@/lib/display-time';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { ReportRequestRecovery, useReportRequestRecovery } from './report-request-journal';
import { prepareReportOperationKey, reportRequest } from './report-request';
import { button, primaryButton, approvalButton, field, panel, failure } from './report-ui';
import { detailSchema } from './report-contract';

const uuid = z.uuid();
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const assessmentSchema = z.object({
  assessmentRunId: uuid,
  engagementId: uuid,
  engagementTitle: z.string(),
  finalizedAt: z.string(),
  libraryVersion: z.string(),
});
const optionsSchema = z.object({
  assessments: z.array(assessmentSchema),
  total: z.number().int().nonnegative(),
});
const requestSchema = z.object({
  id: uuid,
  engagementId: uuid,
  assessmentRunId: uuid,
  reportId: uuid.nullable(),
  title: z.string(),
  status: z.enum(['requested', 'drafted', 'reviewed', 'released', 'rejected']),
  createdAt: z.string(),
});
const requestsSchema = z.object({
  requests: z.array(requestSchema),
  total: z.number().int().nonnegative(),
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
  operationKey: uuid.nullable(),
  lastErrorCode: z.string().nullable(),
  source: versionSchema.nullable(),
  pdf: versionSchema.nullable(),
});
type Assessment = z.infer<typeof assessmentSchema>;
type Request = z.infer<typeof requestSchema>;
type Artifact = z.infer<typeof artifactSchema>;
const pageSize = 20;
const date = (value: string) => formatDateTime(value);

type AuditorWorkflowProps = {
  tenantId: string;
  actorId?: string;
  canRequest: boolean;
  canManage: boolean;
  existingRequestsOnly?: boolean;
  refreshSignal?: number;
  onOpenReport: (reportId: string) => void;
  onChanged: () => void;
};
export function AuditorWorkflow(props: AuditorWorkflowProps) {
  return (
    <TenantAuditorWorkflow key={`${props.tenantId}/${props.actorId ?? 'unknown'}`} {...props} />
  );
}
function TenantAuditorWorkflow({
  tenantId,
  actorId,
  canRequest,
  canManage,
  existingRequestsOnly = false,
  refreshSignal = 0,
  onOpenReport,
  onChanged,
}: AuditorWorkflowProps) {
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [assessmentTotal, setAssessmentTotal] = useState(0);
  const [assessmentOffset, setAssessmentOffset] = useState(0);
  const [requests, setRequests] = useState<Request[]>([]);
  const [requestTotal, setRequestTotal] = useState(0);
  const [requestOffset, setRequestOffset] = useState(0);
  const [selectedRun, setSelectedRun] = useState('');
  const [selectedRequest, setSelectedRequest] = useState('');
  const [title, setTitle] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [releaseConfirmed, setReleaseConfirmed] = useState(false);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [report, setReport] = useState<z.infer<typeof detailSchema> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [revision, setRevision] = useState(0);
  const buildKey = useRef<string | null>(null);
  const chosen = assessments.find((item) => item.assessmentRunId === selectedRun) ?? null;
  const selected = requests.find((item) => item.id === selectedRequest) ?? null;
  const refresh = useCallback(() => {
    setError('');
    setLoading(true);
    setArtifact(null);
    setReport(null);
    setRevision((value) => value + 1);
  }, []);

  const recovery = useReportRequestRecovery({
    tenantId,
    actorId,
    kind: 'auditor',
    canRequest: canRequest && !existingRequestsOnly,
    onConfirmed: () => {
      setTitle('');
      setSelectedRun('');
      setConfirmed(false);
      refresh();
      onChanged();
    },
  });

  useEffect(() => {
    if (!canRequest) return;
    const controller = new AbortController();
    void Promise.all([
      existingRequestsOnly
        ? Promise.resolve(null)
        : reportRequest(
            tenantId,
            `/reports/board/assessment-options?limit=${pageSize}&offset=${assessmentOffset}`,
            { signal: controller.signal },
          ),
      reportRequest(
        tenantId,
        `/reports/statutory/auditor/requests?limit=${pageSize}&offset=${requestOffset}`,
        { signal: controller.signal },
      ),
    ])
      .then(async ([options, listed]) => {
        const assessmentsResult = options ? optionsSchema.parse(await options.json()) : null;
        const requestsResult = requestsSchema.parse(await listed.json());
        if (controller.signal.aborted) return;
        setAssessments(assessmentsResult?.assessments ?? []);
        setAssessmentTotal(assessmentsResult?.total ?? 0);
        setRequests(requestsResult.requests);
        setRequestTotal(requestsResult.total);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(failure(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [
    tenantId,
    canRequest,
    existingRequestsOnly,
    assessmentOffset,
    requestOffset,
    revision,
    refreshSignal,
  ]);

  useEffect(() => {
    if (!selected?.reportId) return;
    const controller = new AbortController();
    void (async () => {
      const artifactResponse = await reportRequest(
        tenantId,
        `/reports/statutory/${selected.reportId}/artifacts/status`,
        { signal: controller.signal },
      );
      const nextArtifact = artifactSchema.parse(await artifactResponse.json());
      const nextReport =
        canManage || nextArtifact.reportStatus === 'published'
          ? z.object({ data: detailSchema }).parse(
              await (
                await reportRequest(tenantId, `/reports/${selected.reportId}`, {
                  signal: controller.signal,
                })
              ).json(),
            ).data
          : null;
      if (!controller.signal.aborted) {
        setArtifact(nextArtifact);
        setReport(nextReport);
      }
    })().catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(failure(cause));
    });
    return () => controller.abort();
  }, [tenantId, canManage, selected?.reportId, revision, refreshSignal]);

  async function act(path: string, body: unknown | (() => unknown)) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await reportRequest(tenantId, path, {
        body: typeof body === 'function' ? body() : body,
      });
      const result = await response.json();
      setMessage(
        response.status === 202
          ? 'Storage outcome is pending. Reconcile this recorded build before retrying a provider-confirmed missing object.'
          : 'The recorded auditor pack state was updated.',
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
    <section aria-label="Auditor pack workflow" className={`${panel} space-y-5`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[#1E2A4A]">
            Assessment-derived auditor review packs
          </h2>
          <p className="text-sm text-slate-600">
            {existingRequestsOnly
              ? 'Review existing auditor-pack requests for the selected organization. This is an assessment-derived review pack, not an independent audit or evidence attestation.'
              : 'A founder can prepare and release a retained pack from a finalized assessment. This is not an independent audit or evidence attestation.'}
          </p>
        </div>
        <button type="button" className={button} disabled={busy || loading} onClick={refresh}>
          Refresh auditor packs
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
      {!existingRequestsOnly && <ReportRequestRecovery recovery={recovery} />}
      {!existingRequestsOnly && (
        <form
          aria-label="Request auditor review pack"
          className="grid gap-3 rounded-lg border border-slate-200 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!chosen || !confirmed || !title.trim() || recovery.blocked) return;
            void recovery.send({
              engagementId: chosen.engagementId,
              assessmentRunId: chosen.assessmentRunId,
              title: title.trim(),
            });
          }}
        >
          <h3 className="font-semibold">Request from a finalized assessment</h3>
          <label className="text-sm">
            Assessment
            <select
              className={`${field} mt-1 w-full`}
              value={selectedRun}
              disabled={busy || loading || recovery.blocked}
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
          </label>
          {!loading && assessments.length === 0 && (
            <p className="text-sm text-slate-600">
              No finalized assessment is available in this tenant.
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              className={button}
              disabled={loading || assessmentOffset === 0}
              onClick={() => setAssessmentOffset(Math.max(0, assessmentOffset - pageSize))}
            >
              Previous assessments
            </button>
            <button
              type="button"
              className={button}
              disabled={loading || assessmentOffset + pageSize >= assessmentTotal}
              onClick={() => setAssessmentOffset(assessmentOffset + pageSize)}
            >
              Next assessments
            </button>
          </div>
          <label className="text-sm">
            Internal request reference
            <input
              className={`${field} mt-1 w-full`}
              value={title}
              maxLength={300}
              required
              disabled={busy || recovery.blocked}
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
              disabled={busy || !chosen || recovery.blocked}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I understand this pack contains recorded assessment findings, not an independent auditor
            attestation.
          </label>
          <button
            type="submit"
            className={primaryButton}
            disabled={busy || !chosen || !confirmed || !title.trim() || recovery.blocked}
          >
            Request review pack
          </button>
        </form>
      )}
      <div aria-label="Auditor pack requests" className="space-y-3">
        <h3 className="font-semibold">Recorded requests</h3>
        {loading && <p role="status">Loading auditor requests…</p>}
        {!loading && !error && requests.length === 0 && (
          <p className="text-sm text-slate-600">No auditor review pack requests are recorded.</p>
        )}
        <ul className="space-y-2">
          {requests.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="w-full rounded-lg border border-slate-200 p-3 text-left hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-teal-600"
                aria-pressed={selectedRequest === item.id}
                onClick={() => {
                  if (selectedRequest === item.id) {
                    setReleaseConfirmed(false);
                    setError('');
                    setMessage('');
                    refresh();
                    return;
                  }
                  setSelectedRequest(item.id);
                  setArtifact(null);
                  setReport(null);
                  setReleaseConfirmed(false);
                  buildKey.current = null;
                  setError('');
                }}
              >
                <span className="block font-medium">{item.title}</span>
                <span className="block text-sm text-slate-600">
                  {item.status} · Requested {date(item.createdAt)}
                </span>
                {existingRequestsOnly && (
                  <span className="block text-sm text-slate-600">
                    Next: {requestReviewGuidance(item.status)}
                    <span className="mt-1 block font-medium text-teal-700">View next action →</span>
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <button
            type="button"
            className={button}
            disabled={loading || requestOffset === 0}
            onClick={() => setRequestOffset(Math.max(0, requestOffset - pageSize))}
          >
            Previous requests
          </button>
          <button
            type="button"
            className={button}
            disabled={loading || requestOffset + pageSize >= requestTotal}
            onClick={() => setRequestOffset(requestOffset + pageSize)}
          >
            Next requests
          </button>
        </div>
      </div>
      {selected && (!existingRequestsOnly || !error) && (
        <div
          aria-label="Selected auditor request"
          className="space-y-3 rounded-lg border border-slate-200 p-4"
        >
          <h3 className="font-semibold">{selected.title}</h3>
          <details className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
            <summary className="cursor-pointer font-medium focus-visible:outline-2 focus-visible:outline-teal-600">
              Source and version details
            </summary>
            <div className="mt-3 space-y-2 [overflow-wrap:anywhere]">
              <p>
                Assessment run <code>{selected.assessmentRunId}</code>
              </p>
              <p>
                Request <code>{selected.id}</code>
              </p>
              {selected.reportId && (
                <p>
                  Report <code>{selected.reportId}</code>
                </p>
              )}
              {report?.contentHash && (
                <p>
                  Content SHA-256: <code>{report.contentHash}</code>
                </p>
              )}
              {artifact?.operationKey && (
                <p>
                  Original operation <code>{artifact.operationKey}</code>
                </p>
              )}
              {artifact?.source && (
                <p>
                  Source SHA-256: <code>{artifact.source.sha256}</code> · Version{' '}
                  {artifact.source.versionId}
                </p>
              )}
              {artifact?.pdf && (
                <p>
                  PDF SHA-256: <code>{artifact.pdf.sha256}</code> · Version {artifact.pdf.versionId}{' '}
                  · Retain until {date(artifact.pdf.retainUntil)}
                </p>
              )}
            </div>
          </details>
          {canManage && !selected.reportId && selected.status === 'requested' && (
            <button
              type="button"
              className={primaryButton}
              disabled={busy}
              onClick={() =>
                void act(`/reports/statutory/auditor/requests/${selected.id}/draft`, {})
              }
            >
              Generate source-bound draft
            </button>
          )}
          {selected.reportId && (
            <>
              {(canManage || artifact?.reportStatus === 'published') && (
                <button
                  type="button"
                  className={primaryButton}
                  onClick={() => onOpenReport(selected.reportId!)}
                >
                  Open report for review
                </button>
              )}
              {!canManage && artifact?.reportStatus !== 'published' && (
                <p className="text-sm text-slate-600">
                  The draft is private to the internal founder until release.
                </p>
              )}
              {report && <p className="text-sm">Report: {report.status}</p>}
              {artifact && (
                <div className="space-y-1 text-sm">
                  <p>
                    Retention:{' '}
                    {artifact.status === 'not_started'
                      ? 'Not built yet'
                      : artifact.status === 'pending'
                        ? 'Outcome pending — reconcile original build'
                        : artifact.source && artifact.pdf
                          ? 'Source and PDF retained'
                          : 'Build settled; source or PDF details unavailable'}
                  </p>
                  {artifact.lastErrorCode && (
                    <p className="text-[#D9534F]">Storage outcome: {artifact.lastErrorCode}</p>
                  )}
                </div>
              )}
              {canManage && report?.status === 'approved' && artifact?.status === 'not_started' && (
                <button
                  type="button"
                  className={primaryButton}
                  disabled={busy}
                  onClick={() => {
                    void act(`/reports/statutory/${selected.reportId}/artifacts`, () => {
                      buildKey.current ??= prepareReportOperationKey();
                      return { operationKey: buildKey.current };
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
                      void act(`/reports/statutory/${selected.reportId}/artifacts/reconcile`, {
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
                      void act(`/reports/statutory/${selected.reportId}/artifacts/retry-missing`, {
                        operationKey: artifact.operationKey,
                      })
                    }
                  >
                    Retry provider-confirmed missing object
                  </button>
                </div>
              )}
              {artifact?.status === 'settled' && artifact.pdf && (
                <a
                  className={primaryButton}
                  href={`/api/bff/v1/reports/statutory/${selected.reportId}/pdf`}
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
                      I reviewed the exact assessment-derived content and retained PDF hash and
                      authorize tenant release.
                    </label>
                    <button
                      type="button"
                      className={approvalButton}
                      disabled={busy || !releaseConfirmed}
                      onClick={() =>
                        void act(`/reports/${selected.reportId}/release`, {
                          expectedContentHash: report.contentHash,
                          expectedArchiveHash: artifact.pdf!.sha256,
                        })
                      }
                    >
                      Release retained review pack
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
