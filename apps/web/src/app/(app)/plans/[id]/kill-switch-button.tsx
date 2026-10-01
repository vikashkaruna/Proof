'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@axiom/ui';

export function KillSwitchButton({
  planId,
  tenantId,
  className,
}: {
  planId?: string;
  tenantId: string;
  className?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [engaged, setEngaged] = useState<boolean | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    let revision = 0;
    async function checkStatus() {
      const current = ++revision;
      if (mounted) setEngaged(null);
      try {
        const res = await fetch('/api/bff/v1/kill-switch/status', {
          headers: { 'X-Tenant-Id': tenantId },
        });
        if (res.ok) {
          const data = await res.json();
          if (mounted && current === revision && typeof data?.engaged === 'boolean') {
            setEngaged(data.engaged);
          }
        }
      } catch {
        // An unreadable state must not become an apparent disengaged state.
      }
    }
    checkStatus();

    const handleEvent = () => {
      // Browser events are unscoped; only the selected tenant's BFF can confirm state.
      void checkStatus();
    };
    window.addEventListener('axiom:kill-switch-changed', handleEvent);
    return () => {
      mounted = false;
      window.removeEventListener('axiom:kill-switch-changed', handleEvent);
    };
  }, [tenantId]);

  async function toggle() {
    if (engaged === null || busy) return;
    if (!engaged) {
      if (
        !confirm(
          'ENGAGE KILL SWITCH?\n\nThis will halt ALL in-flight agent execution globally and ' +
            'prevent any further mutations until reset. This action is recorded ' +
            'in the audit ledger (ADR-1 / ADR-3).',
        )
      ) {
        return;
      }
      setBusy(true);
      setFeedback(null);
      try {
        const res = await fetch('/api/bff/v1/kill-switch/engage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': tenantId },
          body: JSON.stringify({ scope: 'tenant', reason: 'Manual engagement from UI' }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          setFeedback(err?.error?.message || 'Failed to engage kill switch');
          return;
        }
        if ((await res.json().catch(() => null))?.engaged !== true) {
          setEngaged(null);
          setFeedback(
            'Kill switch status is unconfirmed. Refresh to verify before another action.',
          );
          return;
        }
        setEngaged(true);
        setFeedback('Kill switch ENGAGED. All in-flight agent executions halted.');
        window.dispatchEvent(
          new CustomEvent('axiom:kill-switch-changed', { detail: { engaged: true } }),
        );
        router.refresh();
      } catch (e) {
        setEngaged(null);
        setFeedback(e instanceof Error ? e.message : 'Error engaging kill switch');
      } finally {
        setBusy(false);
      }
    } else {
      if (
        !confirm(
          'DISENGAGE KILL SWITCH?\n\nThis will reset the kill switch and resume normal ' +
            'agent operations and remediation execution.',
        )
      ) {
        return;
      }
      setBusy(true);
      setFeedback(null);
      try {
        const res = await fetch('/api/bff/v1/kill-switch/release', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': tenantId },
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          setFeedback(err?.error?.message || 'Failed to disengage kill switch');
          return;
        }
        if ((await res.json().catch(() => null))?.engaged !== false) {
          setEngaged(null);
          setFeedback(
            'Kill switch status is unconfirmed. Refresh to verify before another action.',
          );
          return;
        }
        setEngaged(false);
        setFeedback('Kill switch DISENGAGED. Agent execution resumed.');
        window.dispatchEvent(
          new CustomEvent('axiom:kill-switch-changed', { detail: { engaged: false } }),
        );
        router.refresh();
      } catch (e) {
        setEngaged(null);
        setFeedback(e instanceof Error ? e.message : 'Error disengaging kill switch');
      } finally {
        setBusy(false);
      }
    }
  }

  return (
    <div className={`flex flex-col items-end gap-1.5 ${className || ''}`}>
      <div className="flex items-center gap-2">
        {engaged === true ? (
          <Button
            variant="danger"
            size="sm"
            onClick={toggle}
            loading={busy}
            disabled={busy}
            className="animate-pulse bg-[#D9534F] hover:bg-[#c4433f] text-white font-bold border-2 border-red-700 shadow-md"
          >
            <span className="mr-1">⏻</span> Kill switch engaged · Disengage
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={toggle}
            loading={busy}
            disabled={busy || engaged === null}
            className="border-red-300 text-red-700 hover:bg-red-50"
          >
            <span className="mr-1">⏻</span>{' '}
            {engaged === null ? 'Kill switch status unavailable' : 'Engage kill switch'}
          </Button>
        )}
      </div>
      {feedback && (
        <div
          className={`rounded px-2 py-1 text-xs font-semibold ${
            engaged === true
              ? 'bg-red-100 text-red-900 border border-red-300'
              : 'bg-teal-100 text-teal-900 border border-teal-300'
          }`}
        >
          {feedback}
        </div>
      )}
    </div>
  );
}
