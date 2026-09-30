'use client';

import React, { useEffect, useRef } from 'react';
import type { PramaanDossier } from '@axiom/types';

export interface DossierViewerModalProps {
  dossier: PramaanDossier | null;
  isOpen: boolean;
  onClose: () => void;
  canRelease: boolean;
  busy: boolean;
  onSeal: (dossier: PramaanDossier) => void;
  onDownload: (dossier: PramaanDossier) => void;
  onReconcile: (dossier: PramaanDossier) => void;
  onRetryMissing: (dossier: PramaanDossier) => void;
}

const date = (value: string) => new Date(value).toLocaleString();

export function DossierViewerModal({
  dossier,
  isOpen,
  onClose,
  canRelease,
  busy,
  onSeal,
  onDownload,
  onReconcile,
  onRetryMissing,
}: DossierViewerModalProps) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab') return;
      const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
      if (!buttons?.length) return;
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, [isOpen, onClose]);

  if (!isOpen || !dossier) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/60 p-4 sm:p-6">
      <section
        ref={dialog}
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dossier-title"
        aria-describedby="dossier-limitations"
      >
        <div className="flex items-start justify-between gap-4 bg-[#1E2A4A] p-5 text-white">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-teal-200">
              {dossier.sourceBound ? 'Source-bound dossier' : 'Historical dossier record'}
            </p>
            <h2 id="dossier-title" className="mt-1 break-words text-lg font-semibold">
              {dossier.title}
            </h2>
          </div>
          <button
            ref={closeButton}
            type="button"
            onClick={onClose}
            className="rounded p-1 text-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-300"
            aria-label="Close dossier details"
          >
            ✕
          </button>
        </div>
        <div className="space-y-5 overflow-y-auto p-5 text-sm text-slate-800">
          <p
            id="dossier-limitations"
            className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-slate-700"
          >
            {dossier.sourceBound
              ? dossier.archiveStatus === 'settled'
                ? 'The dossier archive has an exact provider version and a Compliance retention readback. Confirm its source and digest before founder sealing.'
                : 'The archive outcome is pending. Reconcile the exact provider version before founder sealing or download.'
              : 'This historical record does not establish a verified source, retained closure pack, or Object Lock receipt. It is unavailable for sealing, download, or dispatch.'}
          </p>
          <dl className="grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="font-medium text-slate-600">Recorded status</dt>
              <dd className="mt-1 capitalize">{dossier.status}</dd>
            </div>
            <div>
              <dt className="font-medium text-slate-600">Dossier type</dt>
              <dd className="mt-1 capitalize">{dossier.dossierType.replace(/_/g, ' ')}</dd>
            </div>
            <div>
              <dt className="font-medium text-slate-600">Created</dt>
              <dd className="mt-1">{date(dossier.createdAt)}</dd>
            </div>
            <div>
              <dt className="font-medium text-slate-600">Engagement ID</dt>
              <dd className="mt-1 break-all font-mono text-xs">{dossier.engagementId}</dd>
            </div>
            {dossier.reportId && (
              <div className="sm:col-span-2">
                <dt className="font-medium text-slate-600">Linked report ID</dt>
                <dd className="mt-1 break-all font-mono text-xs">{dossier.reportId}</dd>
              </div>
            )}
            {dossier.sourceBound && (
              <>
                <div>
                  <dt className="font-medium text-slate-600">Archive status</dt>
                  <dd className="mt-1 capitalize">{dossier.archiveStatus}</dd>
                </div>
                {dossier.archiveVersionId && (
                  <div>
                    <dt className="font-medium text-slate-600">Exact archive version</dt>
                    <dd className="mt-1 break-all font-mono text-xs">{dossier.archiveVersionId}</dd>
                  </div>
                )}
                <div className="sm:col-span-2">
                  <dt className="font-medium text-slate-600">Archive SHA-256</dt>
                  <dd className="mt-1 break-all font-mono text-xs">{dossier.archiveHash}</dd>
                </div>
              </>
            )}
          </dl>
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 bg-slate-50 p-4">
          {dossier.sourceBound && dossier.archiveStatus === 'pending' && dossier.operationKey && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => onReconcile(dossier)}
                className="rounded-md border border-teal-600 bg-white px-4 py-2 text-sm font-medium text-teal-800 disabled:opacity-50"
              >
                Check exact provider version
              </button>
              {canRelease && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onRetryMissing(dossier)}
                  className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 disabled:opacity-50"
                >
                  Retry only if missing
                </button>
              )}
            </>
          )}
          {dossier.sourceBound && dossier.archiveStatus === 'settled' && canRelease && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => onDownload(dossier)}
                className="rounded-md border border-teal-600 bg-white px-4 py-2 text-sm font-medium text-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 disabled:opacity-50"
              >
                Download verified archive
              </button>
              {dossier.status === 'draft' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onSeal(dossier)}
                  className="rounded-md bg-[#1E2A4A] px-4 py-2 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 disabled:opacity-50"
                >
                  Seal as founder
                </button>
              )}
            </>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
          >
            Close
          </button>
        </div>
      </section>
    </div>
  );
}
