'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';

export function DispatchAlertsButton({
  tenantId,
  canManage,
}: {
  tenantId: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const handleDispatch = async () => {
    if (!canManage) return;
    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      const res = await fetch('/api/bff/v1/monitoring/alerts/dispatch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': tenantId,
        },
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body?.error?.message ?? body?.error?.code ?? 'Dispatch failed');
      }

      const count: unknown = body?.data?.dispatchedCount;
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
        throw new Error('Could not confirm alert dispatch. Review the alert list before retrying.');
      }
      setMessage(`Scan complete: ${count} alert(s) dispatched / refreshed.`);
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Alert dispatch failed');
    } finally {
      setLoading(false);
    }
  };

  if (!canManage) return null;

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleDispatch}
        disabled={loading}
        className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold shadow-sm transition-colors ${
          loading
            ? 'cursor-wait border-slate-300 bg-slate-100 text-slate-400'
            : 'border-teal-600 bg-teal-600 text-white hover:bg-teal-700'
        }`}
      >
        <span>{loading ? '⟳' : '⚡'}</span>
        {loading ? 'Scanning & Dispatching...' : 'Scan & Dispatch Alerts'}
      </button>
      {error && <span className="text-[11px] text-ember-600">{error}</span>}
      {message && <span className="text-[11px] text-teal-700">{message}</span>}
    </div>
  );
}

export function DismissAlertButton({
  tenantId,
  alertId,
  canManage,
}: {
  tenantId: string;
  alertId: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDismiss = async () => {
    if (!canManage) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/bff/v1/monitoring/alerts/${alertId}/dismiss`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': tenantId,
        },
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body?.error?.message ?? body?.error?.code ?? 'Dismissal failed');
      }
      if (body?.data?.dismissed !== true || body?.data?.alertId !== alertId) {
        throw new Error(
          'Could not confirm alert acknowledgement. Review the alert before retrying.',
        );
      }

      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Dismissal failed');
    } finally {
      setLoading(false);
    }
  };

  if (!canManage) return null;

  return (
    <div className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={handleDismiss}
        disabled={loading}
        className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        {loading ? 'Acknowledging...' : 'Acknowledge alert'}
      </button>
      {error && <span className="text-[10px] text-ember-600">{error}</span>}
    </div>
  );
}
