'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import { formatDateTime } from '@/lib/display-time';

const historySchema = z
  .object({
    data: z.array(
      z
        .object({
          id: z.uuid(),
          status: z.enum(['checked', 'failed']),
          errorCode: z.string().nullable(),
          checkedAt: z.string(),
          pagesRead: z.number().int().nonnegative(),
          pagesSkipped: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    available: z.boolean(),
  })
  .strict();
type History = z.infer<typeof historySchema>;

const ERRORS: Record<string, string> = {
  login_failed: 'Sign-in was refused. Check the stored credential with the site owner.',
  login_form_missing: 'The configured sign-in form was not found on the login page.',
  credential_unavailable:
    'The stored credential is missing or expired. Ask an operator to renew it.',
  no_pages_read: 'Sign-in worked but no page could be read.',
  timeout: 'The site did not respond in time.',
};

/** Signed-in website check for one registered website connector. The site,
 * login and credential live in protected deployment configuration; this panel
 * only asks for a run and shows recorded outcomes. */
export function AuthenticatedWebsitePanel({
  tenantId,
  connectorId,
  canManage,
}: {
  tenantId: string;
  connectorId: string;
  canManage: boolean;
}) {
  const [history, setHistory] = useState<History | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const path = `/api/bff/v1/connectors/${connectorId}/website-scan`;
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const response = await fetch(path, {
        headers: { 'X-Tenant-Id': tenantId },
        cache: 'no-store',
        signal,
      });
      if (!response.ok) throw new Error();
      const parsed = historySchema.parse(await response.json());
      if (!signal?.aborted) setHistory(parsed);
    },
    [path, tenantId],
  );
  useEffect(() => {
    const abort = new AbortController();
    void Promise.resolve()
      .then(() => refresh(abort.signal))
      .catch(() => {
        if (!abort.signal.aborted) setMessage('Signed-in check history could not be loaded.');
      });
    return () => abort.abort();
  }, [refresh]);

  async function run() {
    if (busy) return;
    setBusy(true);
    setMessage('Signing in and reading the site…');
    try {
      const operationKey = crypto.randomUUID();
      const response = await fetch(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Tenant-Id': tenantId,
          'Idempotency-Key': operationKey,
        },
        body: JSON.stringify({ operationKey }),
      });
      const body = z
        .object({
          data: z
            .object({ status: z.enum(['checked', 'failed']), errorCode: z.string().nullable() })
            .passthrough(),
        })
        .safeParse(await response.json().catch(() => null));
      if (!body.success) throw new Error();
      setMessage(
        body.data.data.status === 'checked'
          ? 'Signed-in check saved. Open the scan report to review it.'
          : (ERRORS[body.data.data.errorCode ?? ''] ??
              'The check did not complete. The failure is recorded.'),
      );
    } catch {
      setMessage('The check could not be started or recorded. Refresh before trying again.');
    } finally {
      try {
        await refresh();
      } catch {
        /* the message above already explains the state */
      }
      setBusy(false);
    }
  }

  return (
    <section
      aria-label="Signed-in website check"
      className="space-y-3 rounded-lg border border-teal-200 bg-teal-50/40 p-4"
    >
      <h3 className="font-semibold text-indigo-900">Signed-in website check</h3>
      <p className="text-sm text-slate-700">
        Signs in with the stored credential and reads up to 25 pages of the signed-in area. It never
        opens log-out, delete or payment links, and keeps only page paths, form field names and
        which privacy, consent and rights pages exist, never page text or values.
      </p>
      <Link
        href={`/connectors/${connectorId}/scan-report`}
        className="inline-block text-sm font-medium text-teal-800 underline"
      >
        Open scan report
      </Link>
      {message && (
        <p role="status" aria-live="polite" className="text-sm">
          {message}
        </p>
      )}
      {canManage && history?.available && (
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy}
          className="block rounded bg-teal-700 px-3 py-2 text-sm text-white disabled:opacity-50"
        >
          {busy ? 'Working…' : 'Run signed-in check'}
        </button>
      )}
      {history && !history.available && (
        <p className="text-sm">
          This site is not configured for signed-in checks in this deployment. Saved results remain
          available.
        </p>
      )}
      {history?.data.length === 0 && <p className="text-sm">No signed-in checks recorded.</p>}
      {history && history.data.length > 0 && (
        <ul className="space-y-1 text-sm" aria-label="Recent signed-in checks">
          {history.data.map((row) => (
            <li key={row.id} className="rounded border bg-white p-2">
              {formatDateTime(row.checkedAt)} ·{' '}
              {row.status === 'checked'
                ? `${row.pagesRead} pages read, ${row.pagesSkipped} not opened`
                : `Failed (${row.errorCode ?? 'unknown'})`}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
