'use client';

import React, { useCallback, useEffect, useState } from 'react';
import type { PramaanDossier } from '@axiom/types';
import { reportRequest } from './report-request';
import { DossierViewerModal } from './dossier-viewer-modal';

export function ClosureDossiersTab({ tenantId }: { tenantId: string }) {
  const [dossiers, setDossiers] = useState<PramaanDossier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedDossier, setSelectedDossier] = useState<PramaanDossier | null>(null);
  const [revision, setRevision] = useState(0);

  const refresh = useCallback(() => {
    setLoading(true);
    setError('');
    setRevision((value) => value + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void reportRequest(tenantId, '/dossiers?limit=25', { signal: controller.signal })
      .then((response) => response.json())
      .then((value: unknown) => {
        if (controller.signal.aborted) return;
        const data = value as { dossiers?: PramaanDossier[] };
        setDossiers(Array.isArray(data.dossiers) ? data.dossiers : []);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : 'Unable to load dossier records');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [tenantId, revision]);

  return (
    <section className="space-y-5" aria-label="Historical dossier records" aria-busy={loading}>
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-[#1E2A4A]">Historical dossier records</h2>
        <p className="mt-2 max-w-2xl text-sm text-slate-600">
          These records contain metadata from an earlier dossier workflow. They do not prove that
          source evidence or closure-pack bytes were retained and verified. New dossier synthesis,
          sealing, download, and email dispatch are unavailable while that workflow is rebuilt.
        </p>
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-base font-semibold text-slate-900">Recent records</h3>
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
        ) : dossiers.length === 0 ? (
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
                    {dossier.dossierType.replace(/_/g, ' ')} · Recorded status: {dossier.status} ·{' '}
                    {new Date(dossier.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedDossier(dossier)}
                  className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
                >
                  View record
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <DossierViewerModal
        dossier={selectedDossier}
        isOpen={Boolean(selectedDossier)}
        onClose={() => setSelectedDossier(null)}
      />
    </section>
  );
}
