'use client';

import { useState } from 'react';
import { z } from 'zod';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  formatDateTime,
  Input,
  Label,
} from '@axiom/ui';
import { sessionFingerprint } from './recovery-panels';

/**
 * Scoped owner delegation of MFA recovery (0154). Founders issue and revoke;
 * an owner holding a live delegation recovers ordinary members of that one
 * tenant. SQL re-checks every scope fact at open and at confirmation.
 */

const delegationsSchema = z.object({
  owners: z.array(z.object({ user_id: z.string(), email: z.string(), tenant_id: z.string() })),
  delegations: z.array(
    z.object({
      delegation_id: z.string(),
      owner_user_id: z.string(),
      owner_email: z.string().nullable(),
      tenant_id: z.string(),
      tenant_name: z.string().nullable(),
      target_roles: z.array(z.string()),
      version: z.number(),
      reason: z.string(),
      expires_at: z.string(),
      revoked_at: z.string().nullable(),
      eligible: z.array(z.object({ user_id: z.string(), email: z.string(), role: z.string() })),
    }),
  ),
  cases: z.array(
    z.object({
      case_id: z.string(),
      subject_user_id: z.string(),
      subject_email: z.string().nullable(),
      state: z.string(),
      reason: z.string(),
      expires_at: z.string(),
      beneficiary_session: z
        .object({ session_id: z.string(), created_at: z.string().nullable() })
        .nullable(),
    }),
  ),
});
type Delegations = z.infer<typeof delegationsSchema>;

const ROLES = ['approver', 'reviewer', 'viewer'] as const;

const readError = async (res: Response, fallback: string) => {
  const body = await res.json().catch(() => ({}));
  const code = body?.error?.code as string | undefined;
  return code ? `${fallback} (${code})` : `${fallback} (HTTP ${res.status})`;
};

function useDelegations(tenantId: string) {
  const [data, setData] = useState<Delegations | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const headers = { 'Content-Type': 'application/json', 'X-Tenant-Id': tenantId };

  async function load() {
    const res = await fetch('/api/bff/v1/mfa/recovery/delegations', { headers });
    const parsed = res.ok ? delegationsSchema.safeParse(await res.json()) : null;
    if (!parsed?.success) {
      setError(
        res.ok ? 'Delegations are unreadable.' : await readError(res, 'Delegations unavailable'),
      );
      return;
    }
    setData(parsed.data);
  }
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }
  return { data, busy, error, notice, setError, setNotice, headers, load, act };
}

export function DelegationManager({
  tenantId,
  tenantName,
}: {
  tenantId: string;
  tenantName: string;
}) {
  const s = useDelegations(tenantId);
  const [owner, setOwner] = useState('');
  const [roles, setRoles] = useState<string[]>(['approver']);
  const [days, setDays] = useState('7');
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');

  const owners = (s.data?.owners ?? []).filter((o) => o.tenant_id === tenantId);
  const live = (s.data?.delegations ?? []).filter((d) => d.tenant_id === tenantId && !d.revoked_at);

  const issue = () =>
    s.act(async () => {
      const res = await fetch('/api/bff/v1/mfa/recovery/delegations', {
        method: 'POST',
        headers: s.headers,
        body: JSON.stringify({
          ownerUserId: owner,
          targetRoles: roles,
          expiresInDays: Number(days),
          reason: reason.trim(),
          code: code.trim(),
        }),
      });
      setCode('');
      if (!res.ok) return s.setError(await readError(res, 'Delegation was refused'));
      s.setNotice('Delegation issued.');
      setReason('');
      await s.load();
    });

  const revoke = (id: string) =>
    s.act(async () => {
      const res = await fetch(`/api/bff/v1/mfa/recovery/delegations/${id}/revoke`, {
        method: 'POST',
        headers: s.headers,
        body: JSON.stringify({ reason: 'Revoked from the recovery console' }),
      });
      if (!res.ok) return s.setError(await readError(res, 'Revocation was refused'));
      s.setNotice('Delegation revoked. Any recovery it allowed can no longer be confirmed.');
      await s.load();
    });

  return (
    <Card data-testid="mfa-recovery-delegations">
      <CardHeader>
        <CardTitle>Let an owner recover members of {tenantName}</CardTitle>
        <CardDescription>
          Owners can recover only approvers, reviewers or viewers whose memberships are all in this
          organisation. Never founders, owners, admins, analysts or their own account.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {s.notice && (
          <p role="status" className="text-sm text-slate-700">
            {s.notice}
          </p>
        )}
        {s.error && (
          <div className="rounded-md border border-ember-500 bg-ember-50 p-3 text-sm text-ember-700">
            {s.error}
          </div>
        )}
        {!s.data ? (
          <Button variant="ghost" onClick={() => s.act(s.load)} loading={s.busy}>
            Manage owner delegations
          </Button>
        ) : (
          <>
            {live.map((d) => (
              <div
                key={d.delegation_id}
                data-testid="mfa-recovery-delegation"
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-300 p-3 text-sm"
              >
                <span>
                  {d.owner_email} · {d.target_roles.join(', ')} · until{' '}
                  {formatDateTime(d.expires_at)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => revoke(d.delegation_id)}
                  loading={s.busy}
                >
                  Revoke
                </Button>
              </div>
            ))}
            <div className="flex flex-col gap-3 rounded-md border border-slate-300 bg-slate-50 p-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="delegateOwner">Owner</Label>
                <select
                  id="delegateOwner"
                  className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                >
                  <option value="">Select…</option>
                  {owners.map((o) => (
                    <option key={o.user_id} value={o.user_id}>
                      {o.email}
                    </option>
                  ))}
                </select>
              </div>
              <fieldset className="flex gap-4 text-sm">
                <legend className="mb-1 text-sm font-medium">Roles they may recover</legend>
                {ROLES.map((r) => (
                  <label key={r} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={roles.includes(r)}
                      onChange={(e) =>
                        setRoles((cur) =>
                          e.target.checked ? [...cur, r] : cur.filter((x) => x !== r),
                        )
                      }
                    />
                    {r}
                  </label>
                ))}
              </fieldset>
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="delegateDays">Days (1–30)</Label>
                  <Input id="delegateDays" value={days} onChange={(e) => setDays(e.target.value)} />
                </div>
                <div className="flex min-w-64 flex-1 flex-col gap-1.5">
                  <Label htmlFor="delegateReason">Why this owner</Label>
                  <Input
                    id="delegateReason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="delegateCode">Your authenticator code</Label>
                  <Input
                    id="delegateCode"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="123456"
                    autoComplete="one-time-code"
                  />
                </div>
                <Button
                  variant="accent"
                  onClick={issue}
                  loading={s.busy}
                  disabled={
                    !owner ||
                    roles.length === 0 ||
                    !/^\d+$/.test(days) ||
                    Number(days) < 1 ||
                    Number(days) > 30 ||
                    reason.trim().length < 10 ||
                    !code.trim()
                  }
                >
                  Delegate
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

const OPEN = new Set(['opened', 'bound', 'authorized', 'enrolling']);

export function OwnerRecoveryPanel({ tenantId }: { tenantId: string }) {
  const s = useDelegations(tenantId);
  const [subject, setSubject] = useState('');
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');
  const [authCodes, setAuthCodes] = useState<Record<string, string>>({});

  const held = (s.data?.delegations ?? []).filter((d) => d.tenant_id === tenantId && !d.revoked_at);
  const delegation = held[0];

  const open = () =>
    s.act(async () => {
      const res = await fetch('/api/bff/v1/mfa/recovery/delegated-cases', {
        method: 'POST',
        headers: s.headers,
        body: JSON.stringify({
          delegationId: delegation!.delegation_id,
          subjectUserId: subject,
          reason: reason.trim(),
          code: code.trim(),
        }),
      });
      setCode('');
      if (!res.ok) return s.setError(await readError(res, 'Recovery was not opened'));
      s.setNotice(
        'Recovery opened. The member has been signed out and must sign in again with their password.',
      );
      setReason('');
      await s.load();
    });

  const authorize = (caseId: string, sessionId: string) =>
    s.act(async () => {
      const res = await fetch(`/api/bff/v1/mfa/recovery/cases/${caseId}/authorize`, {
        method: 'POST',
        headers: s.headers,
        body: JSON.stringify({
          beneficiarySessionId: sessionId,
          code: (authCodes[caseId] ?? '').trim(),
        }),
      });
      setAuthCodes((c) => ({ ...c, [caseId]: '' }));
      if (!res.ok) return s.setError(await readError(res, 'Confirmation was refused'));
      s.setNotice('Confirmed. They have 15 minutes to enrol a new authenticator.');
      await s.load();
    });

  const cancel = (caseId: string) =>
    s.act(async () => {
      const res = await fetch(`/api/bff/v1/mfa/recovery/cases/${caseId}/cancel`, {
        method: 'POST',
        headers: s.headers,
      });
      if (!res.ok) return s.setError(await readError(res, 'Cancellation was refused'));
      s.setNotice('Recovery cancelled.');
      await s.load();
    });

  return (
    <Card data-testid="mfa-owner-recovery">
      <CardHeader>
        <CardTitle>Recover a member&apos;s authenticator</CardTitle>
        <CardDescription>
          Available only while a founder has delegated recovery to you for this organisation. Verify
          the member&apos;s identity in person or by a channel you trust first.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {s.notice && (
          <p role="status" className="text-sm text-slate-700">
            {s.notice}
          </p>
        )}
        {s.error && (
          <div className="rounded-md border border-ember-500 bg-ember-50 p-3 text-sm text-ember-700">
            {s.error}
          </div>
        )}
        {!s.data ? (
          <Button variant="ghost" onClick={() => s.act(s.load)} loading={s.busy}>
            Check my recovery delegation
          </Button>
        ) : !delegation ? (
          <p className="text-sm text-slate-600">
            No founder has delegated recovery to you for this organisation.
          </p>
        ) : (
          <>
            <p className="text-sm text-slate-700">
              Delegated for {delegation.target_roles.join(', ')} until{' '}
              {formatDateTime(delegation.expires_at)}.
            </p>
            <div className="flex flex-col gap-3 rounded-md border border-slate-300 bg-slate-50 p-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ownerRecoverySubject">Member to recover</Label>
                <select
                  id="ownerRecoverySubject"
                  className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                >
                  <option value="">Select…</option>
                  {delegation.eligible.map((m) => (
                    <option key={m.user_id} value={m.user_id}>
                      {m.email} ({m.role})
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ownerRecoveryReason">How you verified their identity</Label>
                <Input
                  id="ownerRecoveryReason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="ownerRecoveryCode">Your authenticator code</Label>
                  <Input
                    id="ownerRecoveryCode"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="123456"
                    autoComplete="one-time-code"
                  />
                </div>
                <Button
                  variant="accent"
                  onClick={open}
                  loading={s.busy}
                  disabled={!subject || reason.trim().length < 10 || !code.trim()}
                >
                  Open recovery
                </Button>
              </div>
            </div>
            {(s.data.cases ?? [])
              .filter((c) => OPEN.has(c.state))
              .map((c) => (
                <div
                  key={c.case_id}
                  data-testid="mfa-owner-recovery-case"
                  className="flex flex-col gap-2 rounded-md border border-indigo-300 bg-indigo-50 p-4 text-sm"
                >
                  <p className="font-medium text-indigo-900">
                    {c.subject_email} · <Badge variant="warning">{c.state}</Badge>
                  </p>
                  {c.state === 'bound' && c.beneficiary_session ? (
                    <div className="flex flex-wrap items-end gap-3">
                      <span>
                        Confirm only if their code is{' '}
                        <span className="font-mono text-lg tracking-widest">
                          {sessionFingerprint(c.beneficiary_session.session_id)}
                        </span>
                      </span>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor={`owner-auth-${c.case_id}`}>Your authenticator code</Label>
                        <Input
                          id={`owner-auth-${c.case_id}`}
                          value={authCodes[c.case_id] ?? ''}
                          onChange={(e) =>
                            setAuthCodes((codes) => ({ ...codes, [c.case_id]: e.target.value }))
                          }
                          placeholder="123456"
                          autoComplete="one-time-code"
                        />
                      </div>
                      <Button
                        variant="accent"
                        loading={s.busy}
                        disabled={!(authCodes[c.case_id] ?? '').trim()}
                        onClick={() => authorize(c.case_id, c.beneficiary_session!.session_id)}
                      >
                        Codes match — confirm
                      </Button>
                    </div>
                  ) : (
                    <p>
                      {c.state === 'opened'
                        ? 'Waiting for them to sign in with their password and bind that sign-in.'
                        : 'Confirmed; waiting for enrolment.'}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => s.act(s.load)}
                      loading={s.busy}
                    >
                      Refresh
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => cancel(c.case_id)}
                      loading={s.busy}
                    >
                      Cancel recovery
                    </Button>
                  </div>
                </div>
              ))}
          </>
        )}
      </CardContent>
    </Card>
  );
}
