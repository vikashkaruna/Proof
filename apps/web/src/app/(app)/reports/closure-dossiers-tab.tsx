'use client';

import React, { useCallback, useEffect, useState } from 'react';
import type { PramaanDossier } from '@axiom/types';
import { reportRequest, readReleasedArchive } from './report-request';
import { listSchema, type ReportSummary } from './report-contract';
import { DossierViewerModal } from './dossier-viewer-modal';

type Build = {
  dossierId: string;
  reportId: string;
  operationKey: string;
  status: 'pending' | 'settled';
  createdAt: string;
};

export function ClosureDossiersTab({
  tenantId,
  canGenerate,
  canRelease,
}: {
  tenantId: string;
  canGenerate: boolean;
  canRelease: boolean;
}) {
  const [dossiers, setDossiers] = useState<PramaanDossier[]>([]);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [reportOffset, setReportOffset] = useState(0);
  const [hasMoreReports, setHasMoreReports] = useState(false);
  const [reportId, setReportId] = useState('');
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [selectedDossier, setSelectedDossier] = useState<PramaanDossier | null>(null);
  const [revision, setRevision] = useState(0);

  const refresh = useCallback(() => {
    setLoading(true);
    setError('');
    setRevision((value) => value + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const requests: Promise<void>[] = [];
    if (canRelease)
      requests.push(
        reportRequest(tenantId, '/dossiers?limit=25', { signal: controller.signal })
          .then((response) => response.json())
          .then((value: unknown) => {
            if (!controller.signal.aborted) {
              const data = value as { dossiers?: PramaanDossier[] };
              setDossiers(Array.isArray(data.dossiers) ? data.dossiers : []);
            }
          }),
      );
    if (canGenerate)
      requests.push(
        reportRequest(tenantId, '/dossiers/mine', { signal: controller.signal })
          .then((response) => response.json())
          .then((value: unknown) => {
            if (!controller.signal.aborted) {
              const data = value as { builds?: Build[] };
              setBuilds(Array.isArray(data.builds) ? data.builds : []);
            }
          }),
      );
    void Promise.all(requests)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : 'Unable to load dossier records');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [tenantId, canGenerate, canRelease, revision]);

  useEffect(() => {
    if (!canGenerate) return;
    const controller = new AbortController();
    void reportRequest(tenantId, `/reports?limit=100&offset=${reportOffset}&status=published`, {
      signal: controller.signal,
    })
      .then((response) => response.json())
      .then((value: unknown) => {
        if (controller.signal.aborted) return;
        const result = listSchema.parse(value);
        setReports((previous) => {
          const byId = new Map((reportOffset === 0 ? [] : previous).map((item) => [item.id, item]));
          for (const report of result.data)
            if (
              ((report.kind === 'board' ||
                report.kind === 'auditor' ||
                report.kind === 'technical') &&
                report.engagementId) ||
              (report.kind === 'dpb' && !report.engagementId)
            )
              byId.set(report.id, report);
          return [...byId.values()];
        });
        setHasMoreReports(result.meta.hasMore);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error ? cause.message : 'Unable to load released source reports',
          );
      });
    return () => controller.abort();
  }, [tenantId, canGenerate, reportOffset]);

  async function prepare(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const report = reports.find((item) => item.id === reportId);
    if (!report || !title.trim() || (report.kind !== 'dpb' && !report.engagementId)) return;
    setBusy(true);
    setActionError('');
    try {
      await reportRequest(
        tenantId,
        report.kind === 'dpb'
          ? '/closure/pramaan/dpb'
          : `/engagements/${report.engagementId}/closure/pramaan`,
        {
          body: {
            dossierType:
              report.kind === 'auditor'
                ? 'auditor_assurance'
                : report.kind === 'technical'
                  ? 'technical_register'
                  : report.kind === 'dpb'
                    ? 'dpb_statutory'
                    : 'board_executive',
            reportId,
            title: title.trim(),
            operationKey: crypto.randomUUID(),
          },
        },
      );
      refresh();
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : 'Dossier outcome is uncertain; refresh the recorded state.',
      );
      refresh();
    } finally {
      setBusy(false);
    }
  }

  async function reconcile(build: Build) {
    setBusy(true);
    setActionError('');
    try {
      await reportRequest(tenantId, `/dossiers/${build.dossierId}/archive/reconcile`, {
        body: { operationKey: build.operationKey },
      });
      refresh();
    } catch (cause) {
      setActionError(
        cause instanceof Error ? cause.message : 'Provider reconciliation is unavailable.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function pendingAction(dossier: PramaanDossier, retry: boolean) {
    if (!dossier.operationKey) return;
    setBusy(true);
    setActionError('');
    try {
      await reportRequest(
        tenantId,
        `/dossiers/${dossier.id}/archive/${retry ? 'retry-missing' : 'reconcile'}`,
        { body: { operationKey: dossier.operationKey } },
      );
      await open(dossier.id);
      refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Archive recovery is unavailable.');
    } finally {
      setBusy(false);
    }
  }

  async function open(dossierId: string) {
    setBusy(true);
    setActionError('');
    try {
      const response = await reportRequest(tenantId, `/dossiers/${dossierId}`);
      setSelectedDossier((await response.json()) as PramaanDossier);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Unable to load dossier details.');
    } finally {
      setBusy(false);
    }
  }

  async function seal(dossier: PramaanDossier) {
    setBusy(true);
    setActionError('');
    try {
      await reportRequest(tenantId, `/dossiers/${dossier.id}/seal`, {
        body: { expectedProofSeal: dossier.proofSealHash },
      });
      await open(dossier.id);
      refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Founder seal was not confirmed.');
    } finally {
      setBusy(false);
    }
  }

  async function download(dossier: PramaanDossier) {
    if (!dossier.archiveHash || !dossier.archiveBytes) return;
    setBusy(true);
    setActionError('');
    try {
      const response = await reportRequest(tenantId, `/dossiers/${dossier.id}/archive`);
      const blob = await readReleasedArchive(response, dossier.archiveBytes, dossier.archiveHash);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `pramaan-${dossier.id}.zip`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Verified archive download failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="space-y-5"
      aria-label="Pramaan closure dossiers"
      aria-busy={loading || busy}
    >
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-[#1E2A4A]">Source-bound closure dossiers</h2>
        <p className="mt-2 max-w-2xl text-sm text-slate-600">
          Board executive and assessment-derived auditor dossiers use released reports with exact
          retained source and PDF versions. Founder sealing requires a separately verified
          Compliance-locked archive. Auditor dossiers do not assert independent audit or evidence
          certification. Technical dossiers repeat recorded plan claims without independently
          certifying execution or closure. DPB dossiers repeat a recorded breach and notification;
          they do not verify regulator receipt. Full-closure dossiers remain unavailable.
        </p>
      </div>
      {canGenerate && (
        <form
          onSubmit={(event) => void prepare(event)}
          className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          <h3 className="font-semibold text-slate-900">Prepare source-bound dossier</h3>
          <label htmlFor="pramaan-report" className="block text-sm font-medium text-slate-700">
            Released board, auditor, DPB, or technical report
          </label>
          <select
            id="pramaan-report"
            required
            value={reportId}
            onChange={(event) => {
              setReportId(event.target.value);
              const report = reports.find((item) => item.id === event.target.value);
              if (report) setTitle(`${report.title} — closure dossier`);
            }}
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
          >
            <option value="">Choose a released source report</option>
            {reports.map((report) => (
              <option key={report.id} value={report.id}>
                {report.kind === 'auditor'
                  ? 'Auditor review pack'
                  : report.kind === 'technical'
                    ? 'Recorded-plan technical pack'
                    : report.kind === 'dpb'
                      ? 'Recorded DPB notification pack'
                      : 'Board report'}{' '}
                · {report.title}
              </option>
            ))}
          </select>
          {hasMoreReports && (
            <button
              type="button"
              onClick={() => setReportOffset((value) => value + 100)}
              className="rounded-md border border-slate-300 px-3 py-2 text-sm"
            >
              Load more reports
            </button>
          )}
          <label htmlFor="pramaan-title" className="block text-sm font-medium text-slate-700">
            Dossier title
          </label>
          <input
            id="pramaan-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={300}
            required
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
          />
          <button
            type="submit"
            disabled={busy || !reportId}
            className="rounded-md bg-[#1E2A4A] px-4 py-2 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 disabled:opacity-50"
          >
            {busy ? 'Preparing…' : 'Prepare dossier archive'}
          </button>
        </form>
      )}
      {actionError && (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-[#D9534F]"
        >
          {actionError}
        </p>
      )}
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-base font-semibold text-slate-900">Recorded dossiers</h3>
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 disabled:opacity-50"
          >
            Refresh records
          </button>
        </div>
        {loading ? (
          <p role="status" className="mt-4 text-sm text-slate-600">
            Loading dossier records…
          </p>
        ) : error ? (
          <p role="alert" className="mt-4 text-sm text-[#D9534F]">
            {error}
          </p>
        ) : dossiers.length === 0 && builds.length === 0 ? (
          <p className="mt-4 text-sm text-slate-600">No dossier records are visible.</p>
        ) : (
          <ul className="mt-4 divide-y divide-slate-100">
            {dossiers.map((dossier) => (
              <li
                key={dossier.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0">
                  <p className="break-words font-medium text-slate-900">{dossier.title}</p>
                  <p className="mt-1 text-sm text-slate-600">
                    {dossier.dossierType === 'auditor_assurance'
                      ? 'Assessment-derived auditor dossier'
                      : dossier.dossierType === 'technical_register'
                        ? 'Recorded-plan technical dossier'
                        : dossier.dossierType === 'dpb_statutory'
                          ? 'Recorded breach and DPB notification dossier'
                          : dossier.dossierType.replace(/_/g, ' ')}{' '}
                    · Recorded status: {dossier.status} ·{' '}
                    {new Date(dossier.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void open(dossier.id)}
                  className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
                >
                  View record
                </button>
              </li>
            ))}
            {!canRelease &&
              builds.map((build) => (
                <li
                  key={build.dossierId}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                  <div>
                    <p className="font-medium text-slate-900">Dossier {build.dossierId}</p>
                    <p className="mt-1 text-sm text-slate-600">Archive {build.status}</p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void open(build.dossierId)}
                      disabled={busy}
                      className="rounded-md border border-slate-300 px-3 py-2 text-sm"
                    >
                      View
                    </button>
                    {build.status === 'pending' && (
                      <button
                        type="button"
                        onClick={() => void reconcile(build)}
                        disabled={busy}
                        className="rounded-md border border-teal-600 px-3 py-2 text-sm text-teal-800"
                      >
                        Check provider version
                      </button>
                    )}
                  </div>
                </li>
              ))}
          </ul>
        )}
      </div>
      <DossierViewerModal
        dossier={selectedDossier}
        isOpen={Boolean(selectedDossier)}
        canRelease={canRelease}
        busy={busy}
        onSeal={(dossier) => void seal(dossier)}
        onDownload={(dossier) => void download(dossier)}
        onReconcile={(dossier) => void pendingAction(dossier, false)}
        onRetryMissing={(dossier) => void pendingAction(dossier, true)}
        onClose={() => setSelectedDossier(null)}
      />
    </section>
  );
}
