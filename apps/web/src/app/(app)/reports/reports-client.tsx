'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { PackPreparation } from './pack-preparation';
import { button, field, panel, failure } from './report-ui';
import { z } from 'zod';
import {
  detailSchema,
  listSchema,
  manifestPreviewSchema,
  type ReportDetail,
  type ReportSummary,
} from './report-contract';
import { reportRequest, readReleasedArchive } from './report-request';
import { ClosureDossiersTab } from './closure-dossiers-tab';
import { AgentIcon } from '@axiom/ui';

const date = (value: string) => new Date(value).toLocaleString();

type Access = {
  tenantId: string;
  canPrepare: boolean;
  canReview: boolean;
  canRelease: boolean;
  canExport: boolean;
};

export function ReportsClient(access: Access) {
  const { tenantId, canPrepare } = access;
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState('');
  const [more, setMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const activeTab: 'pramaan' | 'prativedan' =
    access.canRelease && tabParam === 'pramaan' ? 'pramaan' : 'prativedan';

  const handleSelectTab = (tab: 'pramaan' | 'prativedan') => {
    setSelectedId(null);
    if (tab === 'pramaan') {
      router.replace('/reports?tab=pramaan');
    } else {
      router.replace('/reports');
    }
  };
  const preparation = useRef<HTMLDetailsElement>(null);
  const refresh = useCallback(() => {
    setLoading(true);
    setReports([]);
    setError('');
    setRevision((v) => v + 1);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void reportRequest(
      tenantId,
      `/reports?limit=20&offset=${offset}${status ? `&status=${status}` : ''}`,
      { signal: controller.signal },
    )
      .then((response) => response.json())
      .then((value) => {
        if (controller.signal.aborted) return;
        const result = listSchema.parse(value);
        setReports(result.data);
        setMore(result.meta.hasMore);
        setTotal(result.meta.total);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(failure(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [tenantId, offset, status, revision]);
  function changePage(next: number) {
    setOffset(next);
    refresh();
  }
  return (
    <div className="min-w-0 space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-[#1E2A4A]">Reports and evidence</h1>
        <p className="text-sm text-slate-600">
          Review recorded reports and evidence packs. A content hash alone does not establish a
          retained PDF, source provenance, or a released proof artifact.
        </p>
        <p className="text-sm text-slate-600">
          Report email dispatch is unavailable while source-bound delivery is being rebuilt.
        </p>
      </header>

      <div className="flex gap-2 border-b border-slate-200" aria-label="Report views">
        {access.canRelease && (
          <button
            type="button"
            onClick={() => handleSelectTab('pramaan')}
            aria-current={activeTab === 'pramaan' ? 'page' : undefined}
            className={`flex items-center gap-2 pb-3 px-3 text-xs font-bold border-b-2 transition-colors ${
              activeTab === 'pramaan'
                ? 'border-teal-600 text-slate-900'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <AgentIcon agent="pramaan" size="sm" state="idle" />
            Historical dossiers
          </button>
        )}
        <button
          type="button"
          onClick={() => handleSelectTab('prativedan')}
          aria-current={activeTab === 'prativedan' ? 'page' : undefined}
          className={`flex items-center gap-2 pb-3 px-3 text-xs font-bold border-b-2 transition-colors ${
            activeTab === 'prativedan'
              ? 'border-indigo-600 text-slate-900'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <AgentIcon agent="prativedan" size="sm" state="idle" />
          Working reports and registers
        </button>
      </div>

      {activeTab === 'pramaan' ? (
        <ClosureDossiersTab tenantId={tenantId} />
      ) : (
        <>
          {/* Statutory Formats Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold px-2 py-0.5 rounded bg-indigo-50 text-indigo-700">
                  BOARD REPORT
                </span>
                <span className="text-xs text-slate-500">Prativedan</span>
              </div>
              <h3 className="text-sm font-semibold text-slate-900 mb-1">Executive Board Summary</h3>
              <p className="text-xs text-slate-600 mb-3">
                Automated drafts can use finalized assessment results. Source and PDF retention are
                required before release.
              </p>
              <div className="text-xs text-slate-500 font-medium">Draft preview only</div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold px-2 py-0.5 rounded bg-teal-50 text-teal-700">
                  AUDITOR PACK
                </span>
                <span className="text-xs text-slate-500">Prativedan / Saakshi</span>
              </div>
              <h3 className="text-sm font-semibold text-slate-900 mb-1">Statutory Auditor Pack</h3>
              <p className="text-xs text-slate-600 mb-3">
                Planned format. Source-bound evidence receipts and independent review are not yet
                available here.
              </p>
              <div className="text-xs text-slate-500 font-medium">Release unavailable</div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold px-2 py-0.5 rounded bg-amber-50 text-amber-700">
                  DPB SUBMISSION
                </span>
                <span className="text-xs text-slate-500">Prativedan</span>
              </div>
              <h3 className="text-sm font-semibold text-slate-900 mb-1">Data Protection Board</h3>
              <p className="text-xs text-slate-600 mb-3">
                Planned submission format. Verified sources and an approved release workflow are
                still required.
              </p>
              <div className="text-xs text-slate-500 font-medium">Release unavailable</div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold px-2 py-0.5 rounded bg-blue-50 text-blue-700">
                  TECH REGISTER
                </span>
                <span className="text-xs text-slate-500">Sudhaar / Karya</span>
              </div>
              <h3 className="text-sm font-semibold text-slate-900 mb-1">Technical Remediation</h3>
              <p className="text-xs text-slate-600 mb-3">
                Planned register. Mutation, dry-run and rollback records must be bound to their
                original receipts before export.
              </p>
              <div className="text-xs text-slate-500 font-medium">Release unavailable</div>
            </div>
          </div>

          {/* Approval History Export Banner */}
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                Tenant Approval History Audit Export
              </h3>
              <p className="text-xs text-slate-600">
                Download stored approval tokens for this tenant. Exports over 200 records are
                refused; use a plan-specific export to narrow the history. This download is not a
                sealed evidence package or a verification of token signatures.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <a
                href={`/api/bff/v1/approvals/export?format=pdf`}
                target="_blank"
                rel="noopener noreferrer"
                download={`approval-history-${tenantId.slice(0, 8)}.pdf`}
                className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 shadow-sm"
              >
                Export PDF
              </a>
              <a
                href={`/api/bff/v1/approvals/export?format=json`}
                target="_blank"
                rel="noopener noreferrer"
                download={`approval-history-${tenantId.slice(0, 8)}.json`}
                className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 shadow-sm"
              >
                Export JSON
              </a>
              <a
                href={`/api/bff/v1/approvals/export?format=csv`}
                target="_blank"
                rel="noopener noreferrer"
                download={`approval-history-${tenantId.slice(0, 8)}.csv`}
                className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 shadow-sm"
              >
                Export CSV
              </a>
            </div>
          </div>
          {canPrepare && (
            <details ref={preparation} className="space-y-3">
              <summary className="cursor-pointer rounded-lg border border-slate-200 p-4 font-semibold text-[#1E2A4A] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600">
                Prepare evidence pack
              </summary>
              <PackPreparation
                tenantId={tenantId}
                onPrepared={(reportId) => {
                  if (preparation.current) preparation.current.open = false;
                  setSelectedId(reportId);
                  refresh();
                }}
              />
            </details>
          )}
          <section aria-label="Recorded reports" className={panel} aria-busy={loading}>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <h2 className="text-lg font-semibold">Recorded reports</h2>
              <label className="text-sm">
                Status
                <select
                  className={`${field} mt-1`}
                  value={status}
                  onChange={(event) => {
                    setStatus(event.target.value);
                    setOffset(0);
                    setSelectedId(null);
                    refresh();
                  }}
                >
                  <option value="">All visible reports</option>
                  {['draft', 'approved', 'rejected', 'published', 'archived'].map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className={button} disabled={loading} onClick={refresh}>
                Refresh reports
              </button>
            </div>
            {loading ? (
              <p role="status">Loading recorded reports…</p>
            ) : error ? (
              <p role="alert" className="text-[#D9534F]">
                {error}
              </p>
            ) : (
              <>
                <p className="text-sm text-slate-600">{total} visible reports</p>
                {reports.length === 0 ? (
                  <p>No reports recorded for this view.</p>
                ) : (
                  <ul className="space-y-2">
                    {reports.map((report) => (
                      <li key={report.id} className="flex items-center gap-2">
                        <button
                          type="button"
                          aria-pressed={selectedId === report.id}
                          className="flex-1 min-w-0 rounded-lg border border-slate-200 p-3 text-left hover:bg-slate-50 aria-pressed:border-teal-600"
                          onClick={() => setSelectedId(report.id)}
                        >
                          <span className="block break-words font-medium">{report.title}</span>
                          <span className="block text-sm text-slate-600">
                            {report.kind} · {report.status} · {date(report.generatedAt)}
                          </span>
                          {report.assurance === 'legacy_unverified' && (
                            <span className="block text-sm text-slate-600">
                              Historical record — no verified release assurance
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                className={button}
                disabled={loading || offset === 0}
                onClick={() => changePage(Math.max(0, offset - 20))}
              >
                Previous reports
              </button>
              <button
                className={button}
                disabled={loading || !!error || !more}
                onClick={() => changePage(offset + 20)}
              >
                Next reports
              </button>
            </div>
          </section>
          {selectedId && (
            <ReportInspector
              key={selectedId}
              {...access}
              reportId={selectedId}
              onChanged={refresh}
            />
          )}
        </>
      )}
    </div>
  );
}

function ReportInspector({
  reportId,
  onChanged,
  ...access
}: Access & {
  reportId: string;
  onChanged: () => void;
}) {
  const [report, setReport] = useState<ReportDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState('');
  const buildKey = useRef<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (report) heading.current?.focus();
  }, [report]);
  function refresh() {
    setLoading(true);
    setReport(null);
    setReadError('');
    setConfirmed(false);
    setRevision((v) => v + 1);
  }
  useEffect(() => {
    const controller = new AbortController();
    void reportRequest(access.tenantId, `/reports/${reportId}`, { signal: controller.signal })
      .then((response) => response.json())
      .then((value) => {
        if (!controller.signal.aborted)
          setReport(z.object({ data: detailSchema }).parse(value).data);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setReadError(failure(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [access.tenantId, reportId, revision]);
  async function act(path: string, body: unknown) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await reportRequest(access.tenantId, path, { body });
      setMessage(
        response.status === 202
          ? 'Storage is still pending. Reconcile to check the recorded version; no second upload is attempted.'
          : 'The action was recorded. Review the refreshed state.',
      );
      refresh();
      onChanged();
    } catch (err) {
      setError(failure(err));
      setConfirmed(false);
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    if (!report?.pack?.archive) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await reportRequest(
        access.tenantId,
        `/evidence-packs/${report.pack.id}/content`,
      );
      const blob = await readReleasedArchive(
        response,
        report.pack.archive.byteSize,
        report.releasedArchiveHash ?? '',
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `axiom-proof-pack-${report.pack.id}.zip`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(
        'Downloaded bytes match the recorded release hash. Use the independently obtained verifier to inspect every member.',
      );
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  }
  const archiveHash = report?.pack?.archive?.contentHash;
  return (
    <section aria-label="Report detail" className={panel} aria-busy={loading}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold">
          Report detail
        </h2>
        <div className="flex items-center gap-2">
          <button className={button} disabled={busy || loading} onClick={refresh}>
            Refresh report detail
          </button>
        </div>
      </div>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-[#D9534F]">
          {error}
        </p>
      )}
      {loading ? (
        <p role="status">Loading report detail…</p>
      ) : readError ? (
        <p role="alert" className="text-[#D9534F]">
          {readError}
        </p>
      ) : (
        report && (
          <>
            <ReportProof report={report} />
            {report.contentHash && report.status === 'draft' && access.canReview && (
              <div className="space-y-3">
                <label className="flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={busy}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  I reviewed the exact content and SHA-256 shown above.
                </label>
                <label className="block text-sm">
                  Review note (required for rejection)
                  <textarea
                    className={`${field} mt-1`}
                    maxLength={2000}
                    value={note}
                    disabled={busy}
                    onChange={(event) => setNote(event.target.value)}
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <button
                    className={button}
                    disabled={busy || !confirmed}
                    onClick={() =>
                      act(`/reports/${report.id}/review`, {
                        decision: 'approved',
                        note: note.trim() || undefined,
                        expectedContentHash: report.contentHash,
                      })
                    }
                  >
                    Approve reviewed content
                  </button>
                  <button
                    className={button}
                    disabled={busy || !confirmed || !note.trim()}
                    onClick={() =>
                      act(`/reports/${report.id}/review`, {
                        decision: 'rejected',
                        note: note.trim(),
                        expectedContentHash: report.contentHash,
                      })
                    }
                  >
                    Reject with reason
                  </button>
                </div>
              </div>
            )}
            {report.status === 'approved' &&
              report.pack &&
              !report.pack.archive &&
              access.canPrepare && (
                <div className="space-y-3">
                  {report.pack.build ? (
                    <>
                      <p className="text-sm">
                        Archive storage is pending. Reconciliation reads an existing object; it
                        cannot create an object that was never uploaded.
                      </p>
                      {report.pack.build.errorCode && (
                        <p className="text-sm text-[#D9534F]">
                          Recorded outcome: {report.pack.build.errorCode}
                        </p>
                      )}
                      <button
                        className={button}
                        disabled={busy}
                        onClick={() =>
                          act(
                            `/evidence-packs/${report.pack!.id}/builds/${report.pack!.build!.operationKey}/reconcile`,
                            {},
                          )
                        }
                      >
                        Reconcile archive storage
                      </button>
                    </>
                  ) : (
                    <>
                      <label className="flex gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={confirmed}
                          disabled={busy}
                          onChange={(event) => setConfirmed(event.target.checked)}
                        />
                        I authorize building and retaining these approved pack bytes for seven
                        years.
                      </label>
                      <button
                        className={button}
                        disabled={busy || !confirmed}
                        onClick={() => {
                          buildKey.current ??= crypto.randomUUID();
                          void act(`/evidence-packs/${report.pack!.id}/build`, {
                            operationKey: buildKey.current,
                          });
                        }}
                      >
                        Build retained archive
                      </button>
                    </>
                  )}
                </div>
              )}
            {report.status === 'approved' &&
              report.contentHash &&
              (report.kind === 'custom' || archiveHash) &&
              access.canRelease && (
                <div className="space-y-3">
                  <label className="flex gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      disabled={busy}
                      onChange={(event) => setConfirmed(event.target.checked)}
                    />
                    I reviewed this content and its recorded artifact hash and authorize release to
                    this tenant.
                  </label>
                  <button
                    className={button}
                    disabled={busy || !confirmed}
                    onClick={() =>
                      act(`/reports/${report.id}/release`, {
                        expectedContentHash: report.contentHash,
                        expectedArchiveHash: archiveHash ?? null,
                      })
                    }
                  >
                    Release reviewed report
                  </button>
                </div>
              )}
            {report.status === 'published' &&
              report.pack?.archive &&
              report.releasedArchiveHash &&
              access.canExport && (
                <div className="space-y-3">
                  <button className={button} disabled={busy} onClick={download}>
                    Download released pack
                  </button>
                  <p className="text-sm text-slate-600">
                    Obtain the verifier from your trusted Axiom Proof installation and compare the
                    archive hash with this authenticated release record. A checksum supplied inside
                    a downloaded archive is not an independent trust anchor. No archive code needs
                    to be executed.
                  </p>
                </div>
              )}
          </>
        )
      )}
    </section>
  );
}

export function ReportProof({ report }: { report: ReportDetail }) {
  let preview: ReturnType<typeof manifestPreviewSchema.safeParse> | null = null;
  if (report.pack && report.contentText) {
    try {
      preview = manifestPreviewSchema.safeParse(JSON.parse(report.contentText));
    } catch {
      preview = null;
    }
  }
  return (
    <div className="min-w-0 space-y-3 break-words">
      <h3 className="text-lg font-medium">{report.title}</h3>
      <p className="text-sm">
        {report.status} · {report.kind} · Library {report.libraryVersion}
      </p>
      <p className="text-sm text-slate-600">
        Generated by {report.generatedByAgent} · {date(report.generatedAt)}
      </p>
      {report.assurance === 'legacy_unverified' && (
        <p className="text-sm text-slate-600">
          Historical record. No verified release, retained archive or new review assurance has been
          backfilled. A new revision is required for digest-bound review.
        </p>
      )}
      {report.contentHash && (
        <p className="break-all font-mono text-xs">Content SHA-256: {report.contentHash}</p>
      )}
      {preview?.success && (
        <>
          <h4 className="font-medium">Evidence inventory</h4>
          <ul className="space-y-3">
            {preview.data.members.map((member) => (
              <li key={member.receipt_id} className="rounded border border-slate-200 p-3 text-sm">
                <Link className="underline" href={`/evidence?q=${member.evidence_id}`}>
                  {member.filename ?? member.evidence_id}
                </Link>
                <p>
                  {member.byte_size} bytes · {member.provenance}
                </p>
                <p className="break-all font-mono text-xs">SHA-256: {member.content_hash}</p>
                <p>
                  Controls:{' '}
                  {member.control_ids.length
                    ? member.control_ids.join(', ')
                    : 'No control claims recorded'}
                </p>
              </li>
            ))}
          </ul>
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600">
            {preview.data.limitations.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      )}
      <details>
        <summary className="cursor-pointer font-medium">Exact recorded content</summary>
        <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-50 p-3 text-xs">
          {report.contentText ?? JSON.stringify(report.content ?? null, null, 2)}
        </pre>
      </details>
      {report.review && (
        <div className="rounded border border-slate-200 p-3 text-sm">
          <p>
            {report.review.decision} by {report.review.reviewerName} ·{' '}
            {date(report.review.reviewedAt)}
          </p>
          <p className="break-all font-mono text-xs">
            Reviewed SHA-256: {report.review.contentHash}
          </p>
          {report.review.note && <p>Review note: {report.review.note}</p>}
        </div>
      )}
      {report.pack?.archive && (
        <div className="space-y-1 rounded border border-[#C9A227] p-3 text-sm">
          <p>Retained archive · {report.pack.archive.byteSize} bytes · COMPLIANCE</p>
          <p className="break-all font-mono text-xs">
            Archive SHA-256: {report.pack.archive.contentHash}
          </p>
          <p>
            Retention until {date(report.pack.archive.retainUntil)} · Verified{' '}
            {date(report.pack.archive.readbackAt)}
          </p>
          <p className="break-all text-xs">Exact version: {report.pack.archive.versionId}</p>
        </div>
      )}
      {report.status === 'published' && report.publishedAt && (
        <div className="text-sm">
          <p>
            Released {date(report.publishedAt)}
            {report.releasedBy ? ` · Actor ${report.releasedBy}` : ''}
          </p>
          {report.releasedArchiveHash && (
            <p className="break-all font-mono text-xs">
              Released archive SHA-256: {report.releasedArchiveHash}
            </p>
          )}
          {!report.pack && (
            <p>
              Structured report release only. This record does not establish a retained PDF or ZIP.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
