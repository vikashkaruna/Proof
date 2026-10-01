'use client';

import React, { useState } from 'react';

interface ExportLedgerButtonProps {
  tenantId: string;
  tenantName?: string;
  tenantSlug?: string;
}

export function ExportLedgerButton({ tenantId, tenantName, tenantSlug }: ExportLedgerButtonProps) {
  const [status, setStatus] = useState<'idle' | 'exporting' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [exportedCount, setExportedCount] = useState<number | null>(null);
  const [truncated, setTruncated] = useState(false);

  const handleExport = async () => {
    if (status === 'exporting') return;
    setStatus('exporting');
    setErrorMessage(null);

    try {
      const params = new URLSearchParams({
        export: 'true',
      });
      params.set('tenantId', tenantId);

      const res = await fetch(`/api/ledger?${params.toString()}`);
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `Export failed with status ${res.status}`);
      }

      const data = await res.json();
      const exported = data?.export_metadata?.total_records;
      if (
        !Array.isArray(data?.records) ||
        typeof exported !== 'number' ||
        !Number.isSafeInteger(exported) ||
        exported < 0 ||
        exported !== data.records.length ||
        data?.export_metadata?.tenant?.id !== tenantId ||
        typeof data?.export_metadata?.export_truncated !== 'boolean'
      ) {
        throw new Error('Ledger export response could not be verified. No file was downloaded.');
      }
      const jsonBlob = new Blob([JSON.stringify(data, null, 2)], {
        type: 'application/json',
      });
      const downloadUrl = URL.createObjectURL(jsonBlob);
      const downloadAnchor = document.createElement('a');
      downloadAnchor.href = downloadUrl;
      const dateStr = new Date().toISOString().slice(0, 10);
      const safeSlug = (tenantSlug ?? 'tenant').replace(/[^a-zA-Z0-9_-]/g, '-');
      downloadAnchor.download = `axiom-ledger-audit-${safeSlug}-${dateStr}.json`;
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      document.body.removeChild(downloadAnchor);
      URL.revokeObjectURL(downloadUrl);

      setExportedCount(exported);
      setTruncated(data.export_metadata.export_truncated);
      setStatus('success');
      setTimeout(() => {
        setStatus('idle');
      }, 3500);
    } catch (err: unknown) {
      console.error('Ledger export error:', err);
      setErrorMessage(err instanceof Error ? err.message : 'Export failed');
      setStatus('error');
      setTimeout(() => {
        setStatus('idle');
        setErrorMessage(null);
      }, 4000);
    }
  };

  return (
    <div className="relative inline-flex items-center">
      <button
        type="button"
        onClick={handleExport}
        disabled={status === 'exporting'}
        className={`rounded-lg border px-3.5 py-1.5 text-xs font-semibold transition-all shadow-2xs inline-flex items-center gap-2 ${
          status === 'success'
            ? 'border-teal-300 bg-teal-50 text-teal-800'
            : status === 'error'
              ? 'border-red-300 bg-red-50 text-red-800'
              : status === 'exporting'
                ? 'border-slate-200 bg-slate-100 text-slate-400 cursor-not-allowed'
                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
        }`}
        title={
          status === 'exporting'
            ? 'Preparing recorded audit entries...'
            : `Export recorded audit entries for ${tenantName || 'selected tenant'}`
        }
      >
        {status === 'exporting' && (
          <>
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
            <span>Preparing audit export...</span>
          </>
        )}
        {status === 'success' && (
          <>
            <span className="text-teal-600 font-bold">✓</span>
            <span>
              Export downloaded ({exportedCount} records{truncated ? '; truncated' : ''})
            </span>
          </>
        )}
        {status === 'error' && (
          <>
            <span className="text-red-500 font-bold">⚠</span>
            <span>{errorMessage || 'Export failed'}</span>
          </>
        )}
        {status === 'idle' && (
          <>
            <span>⬇</span>
            <span>Export recorded ledger entries</span>
          </>
        )}
      </button>
    </div>
  );
}
