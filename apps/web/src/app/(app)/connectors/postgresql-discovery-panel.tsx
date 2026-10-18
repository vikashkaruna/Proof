'use client';
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { formatDateTime } from '@/lib/display-time';
const entry = z
  .object({
    id: z.uuid(),
    connector_id: z.uuid(),
    estate_id: z.uuid(),
    engagement_id: z.uuid(),
    operation: z.enum(['enumerate', 'sample']),
    resource: z.string().nullable(),
    status: z.enum(['queued', 'claimed', 'read_completed', 'completed', 'failed', 'unconfirmed']),
    requested_at: z.string(),
    expires_at: z.string(),
    completed_at: z.string().nullable(),
    cleanup_confirmed: z.boolean().nullable(),
    error_code: z.string().nullable(),
    discovery_run_id: z.uuid().nullable(),
    result: z
      .object({
        id: z.uuid(),
        record_count: z.number().int().nonnegative(),
        result: z.array(z.record(z.string(), z.unknown())),
        created_at: z.string(),
      })
      .nullable(),
  })
  .strict();
const history = z.object({ data: z.array(entry), available: z.boolean() }).strict();
const engagementShape = z.object({
  engagements: z.array(
    z.object({ id: z.uuid(), title: z.string(), estate_id: z.uuid().nullable() }).passthrough(),
  ),
});
const statuses = {
  queued: 'Waiting for worker',
  claimed: 'Reading the sandbox',
  read_completed: 'Read saved; waiting for worker cleanup',
  completed: 'Completed',
  failed: 'Failed',
  unconfirmed: 'Completion not confirmed; inspect history before a new request',
};
function PostgresqlDiscoveryPanelView({
  tenantId,
  connectorId,
  estateId,
  canManage,
}: {
  tenantId: string;
  connectorId: string;
  estateId?: string;
  canManage: boolean;
}) {
  const [saved, setSaved] = useState<z.infer<typeof history> | null>(null),
    [engagements, setEngagements] = useState<z.infer<typeof engagementShape>['engagements']>([]),
    [selected, setSelected] = useState(''),
    [resource, setResource] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const [now, setNow] = useState(0);
  useEffect(() => {
    const first = setTimeout(() => setNow(Date.now()), 0);
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearTimeout(first);
      clearInterval(interval);
    };
  }, []);
  const path = `/api/bff/v1/connectors/${connectorId}/discovery`;
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const response = await fetch(path, {
        headers: { 'X-Tenant-Id': tenantId },
        cache: 'no-store',
        signal,
      });
      if (!response.ok) throw new Error();
      const result = history.parse(await response.json());
      if (result.data.some((row) => row.connector_id !== connectorId)) throw new Error();
      if (!signal?.aborted) setSaved(result);
    },
    [path, tenantId, connectorId],
  );
  useEffect(() => {
    const abort = new AbortController();
    void Promise.resolve()
      .then(() =>
        Promise.all([
          refresh(abort.signal),
          canManage
            ? fetch('/api/bff/v1/engagements', {
                headers: { 'X-Tenant-Id': tenantId },
                cache: 'no-store',
                signal: abort.signal,
              }).then(async (r) => {
                if (!r.ok) throw new Error();
                const result = engagementShape.parse(await r.json());
                if (!abort.signal.aborted)
                  setEngagements(result.engagements.filter((e) => e.estate_id === estateId));
              })
            : Promise.resolve(),
        ]),
      )
      .catch(() => {
        if (!abort.signal.aborted)
          setMessage(
            'Discovery history or assessment choices could not be loaded. Refresh to try again.',
          );
      });
    return () => abort.abort();
  }, [tenantId, connectorId, estateId, canManage, refresh]);
  const pending = saved?.data.some(
    (row) =>
      ['queued', 'claimed', 'read_completed'].includes(row.status) &&
      Date.parse(row.expires_at) > now,
  );
  const resources = [
    ...new Set(
      saved?.data
        .filter((row) => row.status === 'completed' && row.operation === 'enumerate')
        .flatMap(
          (row) =>
            row.result?.result
              .map((record) => (typeof record.resource === 'string' ? record.resource : ''))
              .filter(Boolean) ?? [],
        ) ?? [],
    ),
  ];
  async function run(operation: 'enumerate' | 'sample') {
    if (busy || pending || !estateId || !selected) return;
    setBusy(true);
    setMessage('');
    try {
      const operationKey = crypto.randomUUID();
      const response = await fetch(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Tenant-Id': tenantId,
          'Idempotency-Key': operationKey,
        },
        body: JSON.stringify({
          operationKey,
          estateId,
          engagementId: selected,
          operation,
          ...(operation === 'sample' ? { resource, limit: 20 } : {}),
        }),
      });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error();
      const receipt = z
        .object({ data: z.object({ requestId: z.uuid(), status: z.string() }).passthrough() })
        .parse(body);
      setMessage(
        receipt.data.status === 'completed'
          ? 'Discovery saved. Review the metadata below.'
          : 'The request is saved. Completion is not confirmed; inspect its status before starting another request.',
      );
    } catch {
      setMessage(
        'Discovery did not confirm completion. Refresh the saved history before starting another request. Check the sandbox grant and custody setup if no request was recorded.',
      );
    } finally {
      try {
        await refresh();
      } catch {
        setMessage(
          'Saved history could not be refreshed. Refresh before starting another request.',
        );
      }
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="PostgreSQL sandbox discovery"
      className="space-y-3 rounded-lg border border-teal-200 bg-teal-50/40 p-4"
    >
      <h3 className="font-semibold text-indigo-900">PostgreSQL sandbox discovery</h3>
      <p className="text-sm text-slate-700">
        List accessible tables or profile a bounded sample. Only names and aggregate value shapes
        are retained. This local synthetic sandbox requires a current read grant and reviewed
        custody setup; it does not certify compliance.
      </p>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void refresh()
            .catch(() => setMessage('Discovery history could not be loaded.'))
            .finally(() => setBusy(false));
        }}
        className="rounded border px-3 py-2 text-sm"
      >
        Refresh saved discovery
      </button>
      {canManage && saved?.available && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            Assessment
            <select
              aria-label="Sandbox assessment"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={busy}
              className="block rounded border p-2"
            >
              <option value="">Select an assessment</option>
              {engagements.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.title}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={busy || !!pending || !estateId || !selected}
            onClick={() => void run('enumerate')}
            className="rounded bg-teal-700 px-3 py-2 text-sm text-white"
          >
            {busy ? 'Working…' : 'List sandbox tables'}
          </button>
          {resources.length > 0 && (
            <>
              <label className="text-sm">
                Table
                <select
                  aria-label="Sandbox table"
                  value={resource}
                  onChange={(e) => setResource(e.target.value)}
                  disabled={busy}
                  className="block rounded border p-2"
                >
                  <option value="">Select a table</option>
                  {resources.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={busy || !!pending || !selected || !resource}
                onClick={() => void run('sample')}
                className="rounded border border-teal-700 px-3 py-2 text-sm"
              >
                Profile up to 20 rows
              </button>
            </>
          )}
          {engagements.length === 0 && (
            <p className="text-sm">
              Create an assessment linked to this estate before starting discovery.
            </p>
          )}
        </div>
      )}
      {saved && !saved.available && (
        <p className="text-sm">
          Discovery execution is not configured in this deployment. Saved results remain available.
        </p>
      )}
      {saved?.data.length === 0 && (
        <p className="text-sm">No sandbox discovery requests recorded.</p>
      )}
      {saved?.data.map((row) => (
        <article key={row.id} className="rounded border bg-white p-3 text-sm">
          <div className="font-medium">
            {row.operation === 'enumerate' ? 'List tables' : `Profile ${row.resource}`} ·{' '}
            {now > 0 &&
            Date.parse(row.expires_at) <= now &&
            ['queued', 'claimed', 'read_completed'].includes(row.status)
              ? 'Expired; completion not confirmed'
              : statuses[row.status]}
          </div>
          <p className="text-slate-600">Requested {formatDateTime(row.requested_at)}</p>
          {row.status === 'completed' && row.result && (
            <>
              <p>Saved {row.result.record_count} metadata records · worker cleanup confirmed</p>
              <table className="mt-2 w-full text-left">
                <thead>
                  <tr>
                    <th>{row.operation === 'enumerate' ? 'Resource' : 'Column'}</th>
                    <th>Observed metadata</th>
                  </tr>
                </thead>
                <tbody>
                  {row.result.result.map((record, index) => (
                    <tr key={index}>
                      <td>{String(record.resource ?? record.column ?? 'Metadata')}</td>
                      <td>
                        {Object.entries(record)
                          .filter(
                            ([key, value]) =>
                              !['resource', 'column'].includes(key) &&
                              ['string', 'number', 'boolean'].includes(typeof value),
                          )
                          .map(([key, value]) => `${key.replaceAll('_', ' ')}: ${String(value)}`)
                          .join(' · ') || 'Details retained'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </article>
      ))}
    </section>
  );
}

export function PostgresqlDiscoveryPanel(props: {
  tenantId: string;
  connectorId: string;
  estateId?: string;
  canManage: boolean;
}) {
  return (
    <PostgresqlDiscoveryPanelView
      key={[props.tenantId, props.connectorId, props.estateId, props.canManage].join(':')}
      {...props}
    />
  );
}
