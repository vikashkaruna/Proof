'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Label, Textarea, generateUUID } from '@axiom/ui';

interface Action {
  id: string;
  action_type: string;
  description: string;
  risk_class: 'low' | 'medium' | 'high' | 'critical';
  approval_status: string;
  dry_run_status: string;
  rollback_validated: boolean;
}

interface Props {
  planId: string;
  tenantId: string;
  planStatus?: string;
  actions: Action[];
  eligible: Action[];
  blocked: Action[];
  initialApprovalToken?: string | null;
  initialApprovedActionIds?: string[];
  /**
   * Resolved on the server from the central capability matrix (W1 · SEC-9).
   *
   * Render gating, not the security boundary — the BFF refuses regardless.
   * Its job is that a reviewer or viewer is not handed an Approve button whose
   * only possible outcome is a 403.
   */
  canApprove?: boolean;
  canReject?: boolean;
  canExecute?: boolean;
}

export function ApprovalActions({
  planId,
  tenantId,
  planStatus = 'review',
  actions,
  eligible,
  blocked,
  initialApprovalToken = null,
  initialApprovedActionIds = [],
  canApprove = false,
  canReject = false,
  canExecute = false,
}: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set(eligible.map((a) => a.id)));
  const [reason, setReason] = useState('');
  const [concurrency, setConcurrency] = useState(1);
  const [stopOnFailure, setStopOnFailure] = useState(true);
  const [expiresInMinutes, setExpiresInMinutes] = useState(60);
  const [submitting, setSubmitting] = useState(false);
  const [approvalToken, setApprovalToken] = useState<string | null>(initialApprovalToken);
  const [approvedActionIds, setApprovedActionIds] = useState<string[]>(
    initialApprovedActionIds.length > 0 ? initialApprovedActionIds : eligible.map((a) => a.id),
  );
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // W1 · SEC-8 — the step-up. The BFF will not issue an approval token without
  // a freshly satisfied challenge bound to this exact plan and action set, so
  // approving is a two-step act here as well: open a challenge, prove the
  // factor, then approve. The binding is why the code has to be entered after
  // the selection is final rather than once per session.
  const [stepUp, setStepUp] = useState<{ challengeId: string; expiresAt: string } | null>(null);
  const [stepUpCode, setStepUpCode] = useState('');
  const [needsEnrolment, setNeedsEnrolment] = useState(false);

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  /** Read `{ error: { code, message, details } }` out of a failed response. */
  async function readError(res: Response, fallback: string) {
    const body = await res.json().catch(() => ({}));
    let message = body?.error?.message ?? `${fallback} (HTTP ${res.status})`;
    if (body?.error?.details) {
      const detail =
        typeof body.error.details === 'object'
          ? JSON.stringify(body.error.details)
          : String(body.error.details);
      message += `: ${detail}`;
    }
    return { code: body?.error?.code as string | undefined, message };
  }

  /** Step one: open a challenge bound to exactly what is selected. */
  async function beginApproval() {
    setError(null);
    setSuccess(null);
    setNeedsEnrolment(false);
    if (selected.size === 0) {
      setError('Select at least one action to approve.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/bff/v1/mfa/challenge', {
        method: 'POST',
        // A step-up challenge is single-use, so creating one must not replay.
        // The bridge's derived key is stable per (path, body), which for a
        // re-approval of the same plan and actions would hand back a
        // challenge that had already been spent. See `verify-form.tsx`.
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': tenantId,
          'Idempotency-Key': `mfa-challenge-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          purpose: 'approval_issuance',
          planId,
          actionIds: Array.from(selected),
          mode: 'batch',
        }),
      });
      if (!res.ok) {
        const { code, message } = await readError(res, 'Could not start verification');
        // An approver with no factor needs to enrol, not to keep trying codes.
        if (code === 'mfa_enrolment_required') setNeedsEnrolment(true);
        setError(message);
        return;
      }
      const body = await res.json();
      setStepUp({ challengeId: body.challengeId, expiresAt: body.expiresAt });
      setStepUpCode('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start verification');
    } finally {
      setSubmitting(false);
    }
  }

  /** Step two: satisfy the challenge, then spend it on the approval. */
  async function confirmApproval() {
    if (!stepUp) return;
    setError(null);
    setSubmitting(true);
    try {
      const verify = await fetch(
        `/api/bff/v1/mfa/challenge/${encodeURIComponent(stepUp.challengeId)}/verify`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': tenantId },
          body: JSON.stringify({ code: stepUpCode.trim() }),
        },
      );
      if (!verify.ok) {
        const { code, message } = await readError(verify, 'Verification failed');
        setError(message);
        // These are terminal for this challenge — a new one is needed.
        if (code === 'attempts_exhausted' || code === 'challenge_expired') setStepUp(null);
        return;
      }
      await issueApproval(stepUp.challengeId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verification failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function issueApproval(mfaChallengeId: string) {
    const res = await fetch('/api/bff/v1/plans/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': tenantId },
      body: JSON.stringify({
        planId,
        actionIds: Array.from(selected),
        mode: 'batch',
        concurrency,
        stopOnFailure,
        expiresInMinutes,
        reason: reason.trim() ? reason.trim() : undefined,
        mfaChallengeId,
      }),
    });
    if (!res.ok) {
      const { message } = await readError(res, 'Approval failed');
      setError(message);
      // The challenge is spent either way — a retry needs a fresh one.
      setStepUp(null);
      return;
    }
    const body = await res.json();
    setApprovalToken(JSON.stringify(body.token));
    setApprovedActionIds(Array.from(selected));
    setStepUp(null);
    setStepUpCode('');
    setSuccess(`Approved ${selected.size} action(s). Signed approval token issued.`);
    router.refresh();
  }

  async function execute() {
    if (!approvalToken || approvedActionIds.length === 0) return;
    setError(null);
    setSuccess(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/bff/v1/plans/${planId}/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': tenantId,
          'Idempotency-Key': generateUUID(),
        },
        body: JSON.stringify({
          planId,
          approvalToken,
          actionIds: approvedActionIds,
          mode: 'batch',
          concurrency,
          stopOnFailure,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error?.message ?? `Execution failed (HTTP ${res.status})`);
        return;
      }
      setApprovalToken(null);
      setApprovedActionIds([]);
      setSuccess('Actions executed successfully.');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Execution failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function reject() {
    if (!confirm('Reject the plan? This will mark all actions as rejected/skipped.')) return;
    setError(null);
    setSuccess(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/bff/v1/plans/${planId}/reject`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': tenantId,
        },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error?.message ?? `Rejection failed (HTTP ${res.status})`);
        return;
      }
      setSuccess('Plan rejected. Actions have been marked as skipped.');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reject plan');
    } finally {
      setSubmitting(false);
    }
  }

  if (planStatus === 'completed') {
    return (
      <div className="rounded-md border border-teal-500 bg-teal-50 p-4 text-sm text-teal-800">
        <strong>Plan execution completed.</strong> All remediation actions have been executed and
        recorded in the immutable audit ledger.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {planStatus === 'cancelled' && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          This remediation plan is currently marked as cancelled/rejected. You may still re-approve
          eligible actions below to reinstate and approve them.
        </div>
      )}

      {blocked.length > 0 && (
        <div className="rounded-md border border-ember-500 bg-ember-50 p-3 text-sm text-ember-700">
          <strong>{blocked.length} action(s) blocked</strong> — not eligible for approval. Need a
          completed dry-run AND a validated rollback. The BFF will refuse to issue an approval token
          that includes a blocked action.
        </div>
      )}

      {error && (
        <div className="rounded-md border border-ember-500 bg-ember-50 p-3 text-sm text-ember-700">
          {error}
        </div>
      )}

      {needsEnrolment && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          <strong>You have no second factor enrolled.</strong> Approval tokens bind a fresh
          authentication to the exact actions being approved, so one is required before you can
          approve anything.{' '}
          <a href="/settings/security" className="font-medium underline">
            Enrol an authenticator
          </a>
          .
        </div>
      )}

      {success && (
        <div className="rounded-md border border-teal-500 bg-teal-50 p-3 text-sm text-teal-800">
          {success}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          onClick={() => setSelected(new Set(eligible.map((a) => a.id)))}
          size="sm"
        >
          Select all eligible
        </Button>
        <Button variant="ghost" onClick={() => setSelected(new Set())} size="sm">
          Clear
        </Button>
        <span className="text-sm text-slate-500">
          {selected.size} of {eligible.length} eligible selected
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="concurrency">Concurrency</Label>
          <Input
            id="concurrency"
            type="number"
            min={1}
            max={20}
            value={concurrency}
            onChange={(e) => setConcurrency(Math.max(1, Number(e.target.value)))}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="expires">Expires in (minutes)</Label>
          <Input
            id="expires"
            type="number"
            min={1}
            max={10080}
            value={expiresInMinutes}
            onChange={(e) => setExpiresInMinutes(Math.max(1, Number(e.target.value)))}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="stop">Stop on failure</Label>
          <div className="flex items-center gap-2 pt-2">
            <input
              id="stop"
              type="checkbox"
              checked={stopOnFailure}
              onChange={(e) => setStopOnFailure(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300"
            />
            <span className="text-sm text-slate-600">Halt the batch on first action failure</span>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="reason">Reason (optional, recorded in the ledger)</Label>
        <Textarea
          id="reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Client CFO approved in writing on 2026-08-11"
          rows={2}
        />
      </div>

      {canApprove && stepUp && (
        <div className="rounded-md border border-slate-300 bg-slate-50 p-4">
          <p className="text-sm font-medium text-slate-800">Confirm with your authenticator</p>
          <p className="mt-1 text-xs text-slate-600">
            This code authorises <strong>these {selected.size} action(s) on this plan</strong> and
            nothing else. It can be used once. Changing the selection needs a new code.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="stepUpCode">6-digit code, or a recovery code</Label>
              <Input
                id="stepUpCode"
                value={stepUpCode}
                onChange={(e) => setStepUpCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && stepUpCode.trim()) void confirmApproval();
                }}
                placeholder="123456"
                autoComplete="one-time-code"
                inputMode="text"
                autoFocus
              />
            </div>
            <Button
              variant="accent"
              onClick={confirmApproval}
              loading={submitting}
              disabled={!stepUpCode.trim()}
            >
              Verify and approve
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setStepUp(null);
                setStepUpCode('');
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {!canApprove && !canReject && (
        <div className="rounded-md border border-slate-300 bg-slate-50 p-3 text-sm text-slate-700">
          You have read access to this plan. Approving and rejecting are reserved for an approver or
          owner in this tenant.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {canApprove && (
          <Button
            variant="accent"
            size="lg"
            onClick={beginApproval}
            loading={submitting && !stepUp}
            disabled={selected.size === 0 || Boolean(stepUp)}
          >
            Approve {selected.size} action{selected.size === 1 ? '' : 's'}
          </Button>
        )}
        {canExecute && approvalToken && (
          <Button variant="primary" size="lg" onClick={execute} loading={submitting}>
            Execute approved actions
          </Button>
        )}
        <Button variant="ghost" size="lg" onClick={() => router.refresh()}>
          Refresh
        </Button>
        {canReject && (
          <Button
            variant="danger"
            size="lg"
            onClick={reject}
            loading={submitting}
            disabled={submitting}
          >
            Reject plan
          </Button>
        )}
      </div>

      <p className="text-xs text-slate-500">
        Approving requires a fresh second factor bound to this plan and these actions, and the BFF
        issues a signed, scope-bound token via the Approval Engine only once that challenge is
        satisfied. The token is the gate (per ADR-2). A separate execute call is required to
        actually run — the token itself doesn&apos;t execute.
      </p>
    </div>
  );
}
