'use client';

import { useRef, useState } from 'react';
import { z } from 'zod';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  generateUUID,
} from '@axiom/ui';
import { FieldHint, Notice, selectClass } from '@/components/workflow-blocks';

const receiptSchema = z.object({
  id: z.uuid(),
  subjectUserId: z.uuid(),
  subjectEmail: z.string(),
  reviewerUserId: z.uuid(),
  reviewerEmail: z.string(),
  reason: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  status: z.enum(['pending', 'expired', 'cancelled', 'recovery_opened']),
});
const overviewSchema = z.object({
  reviewers: z.array(
    z.object({ id: z.uuid(), email: z.string(), kind: z.enum(['founder', 'owner']) }),
  ),
  own: z.array(receiptSchema),
  inbox: z.array(receiptSchema),
});
type Overview = z.infer<typeof overviewSchema>;
type Attempt = { requestId: string; reviewerUserId: string; reason: string };
const endpoint = '/api/bff/v1/mfa/recovery/requests';

export function RecoveryRequests({ tenantId }: { tenantId: string }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [reviewer, setReviewer] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const attempt = useRef<Attempt | null>(null);
  const headers = { 'Content-Type': 'application/json', 'X-Tenant-Id': tenantId };

  async function load() {
    const response = await fetch(endpoint, { headers, cache: 'no-store' });
    if (!response.ok) throw new Error('Recovery requests could not be read. Try again.');
    const next = overviewSchema.parse(await response.json());
    setOverview(next);
    if (attempt.current && next.own.some((r) => r.id === attempt.current?.requestId)) {
      attempt.current = null;
      setUncertain(false);
    }
    return next;
  }
  async function refresh() {
    setBusy(true);
    setMessage(null);
    try {
      await load();
    } catch {
      setMessage('Recovery requests could not be read. Try again.');
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    setBusy(true);
    setMessage(null);
    try {
      attempt.current ??= {
        requestId: generateUUID(),
        reviewerUserId: reviewer,
        reason: reason.trim(),
      };
      setUncertain(true);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(attempt.current),
      });
      if (!response.ok) {
        // Read before allowing a different request: a proxy error can hide a saved write.
        const originalId = attempt.current.requestId;
        const next = await load();
        if (next.own.some((r) => r.id === originalId)) {
          setMessage(
            'Recovery request recorded. Your selected owner or founder can see it in Account security.',
          );
        } else if ([400, 403, 409].includes(response.status)) {
          attempt.current = null;
          setUncertain(false);
          setMessage(
            'This request was refused. Check the recipient or existing request before trying again.',
          );
        } else {
          setMessage('The request was not confirmed. Refresh or retry the same request.');
        }
        return;
      }
      const confirmed = receiptSchema.parse(await response.json());
      if (
        confirmed.id !== attempt.current.requestId ||
        confirmed.reviewerUserId !== attempt.current.reviewerUserId
      )
        throw new Error('Request receipt does not match');
      const originalId = attempt.current.requestId;
      const next = await load();
      if (!next.own.some((r) => r.id === originalId))
        throw new Error('Request readback is missing');
      setMessage(
        'Recovery request recorded. Your selected owner or founder can see it in Account security.',
      );
    } catch {
      setMessage(
        attempt.current
          ? 'The request outcome is unknown. Refresh to check it or retry the same request.'
          : 'The request could not be prepared. Nothing was sent. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function cancel(id: string) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`${endpoint}/${id}/cancel`, { method: 'POST', headers });
      if (!response.ok) throw new Error('not confirmed');
      const receipt = receiptSchema.parse(await response.json());
      if (receipt.id !== id || receipt.status !== 'cancelled')
        throw new Error('Cancellation receipt does not match');
      const next = await load();
      if (!next.own.some((r) => r.id === id && r.status === 'cancelled'))
        throw new Error('Cancellation readback is missing');
      setMessage('Request cancelled. No authenticator was changed.');
    } catch {
      setMessage('Cancellation was not confirmed. Refresh before retrying.');
    } finally {
      setBusy(false);
    }
  }
  const pending = overview?.own.some((r) => r.status === 'pending');
  return (
    <Card data-testid="mfa-recovery-requests">
      <CardHeader>
        <CardTitle>Lost your authenticator and recovery codes?</CardTitle>
        <CardDescription>
          Ask an owner in this organisation or a founder for help. You can send a request using this
          password sign-in. They must verify your identity independently before recovery.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-slate-600">
          A request grants no access and changes no authenticator or session. Owners need a current
          founder delegation for eligible members. Founders recover other founders, owners or
          admins; they arrange owner delegation for other members.
        </p>
        <Button variant="outline" onClick={refresh} loading={busy}>
          Check recovery requests
        </Button>
        {message && <Notice role="status">{message}</Notice>}
        {overview && (
          <>
            {!pending && (
              <div className="flex flex-col gap-3">
                <div>
                  <Label htmlFor="recoveryRequestReviewer">Ask for help from</Label>
                  <select
                    id="recoveryRequestReviewer"
                    className={selectClass}
                    value={reviewer}
                    disabled={busy || uncertain}
                    onChange={(e) => setReviewer(e.target.value)}
                  >
                    <option value="">Select an owner or founder…</option>
                    {overview.reviewers.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.email} ({r.kind})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="recoveryRequestReason">What happened?</Label>
                  <Input
                    id="recoveryRequestReason"
                    required
                    minLength={10}
                    maxLength={1000}
                    value={reason}
                    disabled={busy || uncertain}
                    onChange={(e) => setReason(e.target.value)}
                    aria-describedby="recoveryRequestReasonHint"
                  />
                  <FieldHint id="recoveryRequestReasonHint">
                    Required: at least 10 characters ({reason.trim().length} so far). Do not include
                    passwords or recovery codes.
                  </FieldHint>
                </div>
                <Button
                  onClick={send}
                  loading={busy}
                  disabled={!uncertain && (!reviewer || reason.trim().length < 10)}
                >
                  {uncertain ? 'Retry the same request' : 'Send recovery request'}
                </Button>
                {overview.reviewers.length === 0 && (
                  <Notice>
                    No other owner or founder is available. Contact your organisation through a
                    trusted channel.
                  </Notice>
                )}
              </div>
            )}
            {overview.own.map((r) => (
              <div key={r.id} className="rounded-md border p-3 text-sm">
                <p>
                  Requested from {r.reviewerEmail}: {r.status.replace('_', ' ')}.
                </p>
                {r.status === 'pending' && (
                  <Button variant="outline" disabled={busy} onClick={() => cancel(r.id)}>
                    Cancel request
                  </Button>
                )}
              </div>
            ))}
            {overview.inbox.length > 0 && (
              <div className="flex flex-col gap-3">
                <h4 className="font-medium">Requests for your help</h4>
                {overview.inbox.map((r) => (
                  <div key={r.id} className="rounded-md border p-3 text-sm">
                    <p>{r.subjectEmail} needs authenticator recovery.</p>
                    <p>{r.reason}</p>
                    <p>
                      Verify their identity through a channel you trust. Then select this account in
                      the recovery console below if you have recovery authority. A founder must
                      handle founder, owner or admin accounts; an owner needs founder delegation for
                      an eligible member. This request is not identity verification or permission to
                      recover the account.
                    </p>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
