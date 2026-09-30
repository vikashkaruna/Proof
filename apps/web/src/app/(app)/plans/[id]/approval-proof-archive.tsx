'use client';

import { useCallback, useEffect, useState } from 'react';

interface ArchiveStatus {
  archiveId: string;
  tokenId: string;
  status: 'pending' | 'settled' | 'released';
  sourceSha256: string;
  versionId: string | null;
  reviewed: boolean;
  retainUntil: string;
}

interface Props {
  tenantId: string;
  tokenId: string;
  canManage: boolean;
}

const descriptions: Record<string, string> = {
  pending: 'Archive intent recorded. Verify the provider version before release.',
  settled: 'Exact retained version verified. Founder release is required.',
  released: 'Founder released the verified proof for owner download.',
};
const errorMessages: Record<string, string> = {
  reconciliation_missing: 'No completed maker-checker reconciliation was found.',
  reconciliation_unverified: 'The recorded reconciliation does not match the source facts.',
  dry_run_or_rollback_incomplete: 'The approved dry-run or rollback validation is incomplete.',
  verification_incomplete: 'Execution verification is incomplete.',
  approval_archive_signature_invalid:
    'The stored approval or reconciliation signature could not be verified.',
  approval_archive_pending_reconciliation:
    'The provider result is uncertain. Use Verify provider version before retrying.',
  approval_archive_source_changed:
    'The source changed after archive preparation. Release is blocked.',
  founder_review_required: 'Review the exact retained proof before release.',
};

export function ApprovalProofArchive({ tenantId, tokenId, canManage }: Props) {
  const [archive, setArchive] = useState<ArchiveStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    sourceText: string;
    displayText: string;
    sourceSha256: string;
    versionId: string;
  } | null>(null);
  const [operationKey] = useState(() => crypto.randomUUID());

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/bff/v1/approvals/${tokenId}/archive`, {
        headers: { 'X-Tenant-Id': tenantId },
        cache: 'no-store',
      });
      if (response.status === 404 || (response.status === 403 && !canManage)) {
        setArchive(null);
        return;
      }
      if (!response.ok) throw new Error('Could not read the archive status.');
      setArchive((await response.json()) as ArchiveStatus);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Archive status is unavailable.');
    } finally {
      setLoading(false);
    }
  }, [tenantId, tokenId, canManage]);

  useEffect(() => {
    let active = true;
    fetch(`/api/bff/v1/approvals/${tokenId}/archive`, {
      headers: { 'X-Tenant-Id': tenantId },
      cache: 'no-store',
    })
      .then(async (response) => {
        if (response.status === 404 || (response.status === 403 && !canManage)) return null;
        if (!response.ok) throw new Error('Could not read the archive status.');
        return response.json() as Promise<ArchiveStatus>;
      })
      .then((result) => {
        if (active) setArchive(result);
      })
      .catch(() => {
        if (active) setError('Archive status is unavailable.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [tenantId, tokenId, canManage]);

  async function change(path: string, label: string, body?: unknown) {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const response = await fetch(`/api/bff/v1${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': tenantId,
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify(body ?? {}),
      });
      if (!response.ok) {
        const result = (await response.json().catch(() => null)) as {
          error?: { code?: string };
        } | null;
        const code = result?.error?.code ?? String(response.status);
        throw new Error(errorMessages[code] ?? `${label} could not complete (${code}).`);
      }
      setArchive((await response.json()) as ArchiveStatus);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `${label} failed.`);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function previewProof(archiveId: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/bff/v1/approval-archives/${archiveId}/preview`, {
        headers: { 'X-Tenant-Id': tenantId },
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('The exact retained proof could not be previewed.');
      const result = (await response.json()) as {
        sourceText: string;
        sourceSha256: string;
        versionId: string;
      };
      if (
        !archive ||
        result.sourceSha256 !== archive.sourceSha256 ||
        result.versionId !== archive.versionId
      )
        throw new Error('The retained version changed. Refresh and preview again.');
      setPreview({
        ...result,
        displayText: JSON.stringify(JSON.parse(result.sourceText), null, 2),
      });
    } catch (cause) {
      setPreview(null);
      setError(cause instanceof Error ? cause.message : 'Proof preview is unavailable.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Retained approval proof</h3>
          <p className="mt-1 text-sm text-slate-600">
            Token {tokenId.slice(0, 8)} ·{' '}
            {loading
              ? 'Checking archive status…'
              : archive
                ? descriptions[archive.status]
                : 'No released proof is available.'}
          </p>
          {archive?.versionId && (
            <p className="mt-1 break-all text-xs text-slate-500">
              Provider version {archive.versionId} · Retained until{' '}
              {new Date(archive.retainUntil).toLocaleDateString()}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {canManage && !loading && !archive && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void change(`/approvals/${tokenId}/archive`, 'Archive', { operationKey })
              }
              className="rounded bg-teal-700 px-3 py-2 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
            >
              Archive proof
            </button>
          )}
          {canManage && archive?.status === 'pending' && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void change(`/approval-archives/${archive.archiveId}/reconcile`, 'Reconciliation')
                }
                className="rounded border border-slate-300 px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
              >
                Verify provider version
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void change(
                    `/approval-archives/${archive.archiveId}/retry-missing`,
                    'Missing-object retry',
                  )
                }
                className="rounded border border-slate-300 px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
              >
                Retry missing object
              </button>
            </>
          )}
          {canManage && archive?.status === 'settled' && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => void previewProof(archive.archiveId)}
                className="rounded border border-slate-300 px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
              >
                Preview exact proof
              </button>
              {!archive.reviewed && preview && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void change(
                      `/approval-archives/${archive.archiveId}/review`,
                      'Founder review',
                      { sourceSha256: preview.sourceSha256, versionId: preview.versionId },
                    )
                  }
                  className="rounded bg-teal-700 px-3 py-2 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
                >
                  Record founder review
                </button>
              )}
              {archive.reviewed && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void change(`/approval-archives/${archive.archiveId}/release`, 'Release')
                  }
                  className="rounded bg-teal-700 px-3 py-2 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
                >
                  Release reviewed proof
                </button>
              )}
            </>
          )}
          {archive?.status === 'released' && (
            <a
              href={`/api/bff/v1/approval-archives/${archive.archiveId}/download`}
              download={`approval-proof-${archive.archiveId}.json`}
              className="rounded border border-slate-300 px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
            >
              Download exact version
            </a>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => void refresh()}
            className="rounded border border-slate-300 px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
          >
            Refresh
          </button>
        </div>
      </div>
      {archive && (
        <p className="mt-2 break-all font-mono text-xs text-slate-600">
          SHA-256 {archive.sourceSha256}
        </p>
      )}
      {preview && (
        <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3">
          <p className="text-sm font-medium text-slate-900">
            Exact retained source for founder review
          </p>
          <p className="mt-1 text-xs text-slate-600">
            Review these facts before recording approval. The hash identifies the original retained
            bytes.
          </p>
          <p className="mt-1 break-all font-mono text-xs text-slate-600">
            Version {preview.versionId} · SHA-256 {preview.sourceSha256}
          </p>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs text-slate-800">
            {preview.displayText}
          </pre>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <p className="sr-only" aria-live="polite">
        {busy ? 'Updating approval proof archive.' : archive ? `Archive ${archive.status}.` : ''}
      </p>
    </div>
  );
}
