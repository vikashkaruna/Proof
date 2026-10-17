'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { z } from 'zod';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@axiom/ui';

/**
 * Founder-led MFA recovery (0152/0153).
 *
 * Both panels only shape requests. Every authority decision — live founder on
 * both sides, fresh step-up bound to the exact act, the session fence, the
 * one-shot grant — is made and repeated by SQL behind the BFF.
 *
 * The session fingerprint is how the two people confirm, out of band, that
 * the session the founder authorizes is the one the beneficiary is sitting in.
 */
export function sessionFingerprint(sessionId: string): string {
  const hex = sessionId.replace(/-/g, '').toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}

export interface OwnRecovery {
  caseId: string;
  state: 'opened' | 'bound' | 'authorized' | 'enrolling';
  boundHere: boolean;
  sessionId: string | null;
}

const readError = async (res: Response, fallback: string) => {
  const body = await res.json().catch(() => ({}));
  const code = body?.error?.code as string | undefined;
  return code ? `${fallback} (${code})` : `${fallback} (HTTP ${res.status})`;
};

const ownSchema = z.object({
  recovery: z
    .object({
      caseId: z.string(),
      state: z.enum(['opened', 'bound', 'authorized', 'enrolling']),
      boundHere: z.boolean(),
    })
    .nullable(),
});

export function RecoveryBeneficiary({
  tenantId,
  initial,
}: {
  tenantId: string;
  initial: OwnRecovery;
}) {
  const router = useRouter();
  const [recovery, setRecovery] = useState(initial);
  const [pending, setPending] = useState<{ secret: string; provisioningUri: string } | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headers = { 'Content-Type': 'application/json', 'X-Tenant-Id': tenantId };

  async function refresh() {
    const res = await fetch('/api/bff/v1/mfa/recovery/beneficiary', { headers });
    const parsed = res.ok ? ownSchema.safeParse(await res.json()) : null;
    if (!parsed?.success) {
      setError('Recovery status is unavailable. Refresh the page.');
      return;
    }
    if (parsed.data.recovery) setRecovery((r) => ({ ...r, ...parsed.data.recovery! }));
  }

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  const bind = () =>
    act(async () => {
      const res = await fetch('/api/bff/v1/mfa/recovery/beneficiary/bind', {
        method: 'POST',
        headers,
        body: JSON.stringify({ caseId: recovery.caseId }),
      });
      if (!res.ok) return setError(await readError(res, 'This sign-in could not be bound'));
      setRecovery((r) => ({ ...r, state: 'bound', boundHere: true }));
    });

  const enrol = () =>
    act(async () => {
      const res = await fetch('/api/bff/v1/mfa/recovery/beneficiary/enrol', {
        method: 'POST',
        headers,
        body: JSON.stringify({ caseId: recovery.caseId }),
      });
      if (!res.ok) return setError(await readError(res, 'Enrolment is not authorized yet'));
      setPending(await res.json());
      setRecovery((r) => ({ ...r, state: 'enrolling' }));
    });

  const activate = () =>
    act(async () => {
      const res = await fetch('/api/bff/v1/mfa/recovery/beneficiary/enrol/activate', {
        method: 'POST',
        headers,
        body: JSON.stringify({ caseId: recovery.caseId, code: code.trim() }),
      });
      if (!res.ok) return setError(await readError(res, 'The code was not accepted'));
      const body = (await res.json()) as { recoveryCodes: string[] };
      setRecoveryCodes(body.recoveryCodes);
      setPending(null);
    });

  const authorized =
    recovery.boundHere && (recovery.state === 'authorized' || recovery.state === 'enrolling');

  return (
    <Card data-testid="mfa-recovery-beneficiary">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Account recovery in progress <Badge variant="warning">{recovery.state}</Badge>
        </CardTitle>
        <CardDescription>
          A founder or your organisation's owner has opened a recovery for your authenticator. Your
          earlier sessions have been ended. Nothing else in the product is available until this
          recovery is complete.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <div className="rounded-md border border-ember-500 bg-ember-50 p-3 text-sm text-ember-700">
            {error}
          </div>
        )}

        {recoveryCodes ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-4">
            <p className="text-sm font-semibold text-amber-900">
              Recovery complete. Save these recovery codes now — this is the only time they are
              shown.
            </p>
            <div
              data-testid="recovery-code-list"
              className="mt-3 grid grid-cols-2 gap-1.5 font-mono text-sm text-amber-950 sm:grid-cols-3"
            >
              {recoveryCodes.map((rc) => (
                <span key={rc} className="rounded bg-white/70 px-2 py-1">
                  {rc}
                </span>
              ))}
            </div>
            <Button className="mt-3" variant="accent" onClick={() => router.push('/verify')}>
              I have saved them — verify with the new authenticator
            </Button>
          </div>
        ) : !recovery.boundHere ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-slate-700">
              Step 1 of 3. Bind this sign-in to the recovery so the person recovering your account
              can confirm it is you.
            </p>
            <Button variant="accent" onClick={bind} loading={busy}>
              Bind this sign-in
            </Button>
          </div>
        ) : !authorized ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-slate-700">
              Step 2 of 3. Read this code to the person recovering your account, over a channel you
              both trust. They must see the same code before confirming.
            </p>
            {recovery.sessionId && (
              <p
                data-testid="session-fingerprint"
                className="font-mono text-2xl tracking-widest text-slate-900"
              >
                {sessionFingerprint(recovery.sessionId)}
              </p>
            )}
            <Button variant="ghost" onClick={() => act(refresh)} loading={busy}>
              Check for confirmation
            </Button>
          </div>
        ) : pending ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-slate-700">
              Step 3 of 3. Add this key to your new authenticator, then enter the code it shows.
            </p>
            <a className="text-sm text-teal-700 underline" href={pending.provisioningUri}>
              Open in authenticator app
            </a>
            <p data-testid="recovery-setup-key" className="font-mono text-sm text-slate-900">
              {pending.secret.match(/.{1,4}/g)?.join(' ')}
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="recoveryEnrolCode">Code from the new authenticator</Label>
                <Input
                  id="recoveryEnrolCode"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="123456"
                  autoComplete="one-time-code"
                />
              </div>
              <Button variant="accent" onClick={activate} loading={busy} disabled={!code.trim()}>
                Complete recovery
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-slate-700">
              Step 3 of 3. Your sign-in was confirmed. Set up your new authenticator within 15
              minutes.
            </p>
            <Button variant="accent" onClick={enrol} loading={busy}>
              Set up new authenticator
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const overviewSchema = z.object({
  founders: z.array(
    z.object({ user_id: z.string(), email: z.string(), full_name: z.string().nullable() }),
  ),
  cases: z.array(
    z.object({
      case_id: z.string(),
      subject_user_id: z.string(),
      state: z.string(),
      reason: z.string(),
      expires_at: z.string(),
      beneficiary_session: z
        .object({
          session_id: z.string(),
          created_at: z.string().nullable(),
          user_agent: z.string().nullable(),
        })
        .nullable(),
    }),
  ),
});
type Overview = z.infer<typeof overviewSchema>;

const OPEN_STATES = new Set(['opened', 'bound', 'authorized', 'enrolling']);

export function RecoveryConsole({ tenantId }: { tenantId: string }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [subject, setSubject] = useState('');
  const [reason, setReason] = useState('');
  const [openCode, setOpenCode] = useState('');
  const [authCodes, setAuthCodes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const headers = { 'Content-Type': 'application/json', 'X-Tenant-Id': tenantId };

  async function load() {
    const res = await fetch('/api/bff/v1/mfa/recovery/overview', { headers });
    const parsed = res.ok ? overviewSchema.safeParse(await res.json()) : null;
    if (!parsed?.success) {
      setError(
        res.ok
          ? 'Recovery overview is unreadable.'
          : await readError(res, 'Recovery console unavailable'),
      );
      return;
    }
    setOverview(parsed.data);
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

  const emailOf = (id: string) => overview?.founders.find((f) => f.user_id === id)?.email ?? id;

  const open = () =>
    act(async () => {
      const res = await fetch('/api/bff/v1/mfa/recovery/cases', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          subjectUserId: subject,
          reason: reason.trim(),
          code: openCode.trim(),
        }),
      });
      setOpenCode('');
      if (!res.ok) return setError(await readError(res, 'Recovery was not opened'));
      setNotice(
        `Recovery opened. ${emailOf(subject)} has been signed out everywhere and must now sign in with their password and bind that sign-in.`,
      );
      setReason('');
      await load();
    });

  const authorize = (caseId: string, sessionId: string) =>
    act(async () => {
      const res = await fetch(`/api/bff/v1/mfa/recovery/cases/${caseId}/authorize`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          beneficiarySessionId: sessionId,
          code: (authCodes[caseId] ?? '').trim(),
        }),
      });
      setAuthCodes((c) => ({ ...c, [caseId]: '' }));
      if (!res.ok) return setError(await readError(res, 'Confirmation was refused'));
      setNotice('Confirmed. They have 15 minutes to enrol a new authenticator.');
      await load();
    });

  const cancel = (caseId: string) =>
    act(async () => {
      const res = await fetch(`/api/bff/v1/mfa/recovery/cases/${caseId}/cancel`, {
        method: 'POST',
        headers,
      });
      if (!res.ok) return setError(await readError(res, 'Cancellation was refused'));
      setNotice('Recovery cancelled. Their earlier sessions stay ended.');
      await load();
    });

  return (
    <Card data-testid="mfa-recovery-console">
      <CardHeader>
        <CardTitle>Recover another founder&apos;s authenticator</CardTitle>
        <CardDescription>
          For a founder who has lost their authenticator and recovery codes. Verify who they are
          through a channel you trust before starting; every step is recorded. You cannot recover
          your own account here.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {notice && (
          <p role="status" className="text-sm text-slate-700">
            {notice}
          </p>
        )}
        {error && (
          <div className="rounded-md border border-ember-500 bg-ember-50 p-3 text-sm text-ember-700">
            {error}
          </div>
        )}
        {!overview ? (
          <Button variant="ghost" onClick={() => act(load)} loading={busy}>
            Open recovery console
          </Button>
        ) : (
          <>
            <div className="flex flex-col gap-3 rounded-md border border-slate-300 bg-slate-50 p-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="recoverySubject">Founder to recover</Label>
                <select
                  id="recoverySubject"
                  className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                >
                  <option value="">Select…</option>
                  {overview.founders.map((f) => (
                    <option key={f.user_id} value={f.user_id}>
                      {f.full_name ? `${f.full_name} — ${f.email}` : f.email}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="recoveryReason">How you verified their identity</Label>
                <Input
                  id="recoveryReason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. video call on known number, 14:05 IST"
                />
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="recoveryOpenCode">Your authenticator code</Label>
                  <Input
                    id="recoveryOpenCode"
                    value={openCode}
                    onChange={(e) => setOpenCode(e.target.value)}
                    placeholder="123456"
                    autoComplete="one-time-code"
                  />
                </div>
                <Button
                  variant="accent"
                  onClick={open}
                  loading={busy}
                  disabled={!subject || reason.trim().length < 10 || !openCode.trim()}
                >
                  Open recovery
                </Button>
              </div>
            </div>

            {overview.cases
              .filter((c) => OPEN_STATES.has(c.state))
              .map((c) => (
                <div
                  key={c.case_id}
                  data-testid="mfa-recovery-case"
                  className="flex flex-col gap-2 rounded-md border border-indigo-300 bg-indigo-50 p-4"
                >
                  <p className="text-sm font-medium text-indigo-900">
                    {emailOf(c.subject_user_id)} · <Badge variant="warning">{c.state}</Badge>
                  </p>
                  <p className="text-xs text-indigo-800">{c.reason}</p>
                  {c.state === 'bound' && c.beneficiary_session ? (
                    <>
                      <p className="text-sm text-indigo-900">
                        Ask them to read their code. Confirm only if it matches:{' '}
                        <span className="font-mono text-lg tracking-widest">
                          {sessionFingerprint(c.beneficiary_session.session_id)}
                        </span>
                      </p>
                      <div className="flex flex-wrap items-end gap-3">
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor={`auth-${c.case_id}`}>Your authenticator code</Label>
                          <Input
                            id={`auth-${c.case_id}`}
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
                          loading={busy}
                          disabled={!(authCodes[c.case_id] ?? '').trim()}
                          onClick={() => authorize(c.case_id, c.beneficiary_session!.session_id)}
                        >
                          Codes match — confirm
                        </Button>
                      </div>
                    </>
                  ) : c.state === 'opened' ? (
                    <p className="text-sm text-indigo-900">
                      Waiting for them to sign in with their password and bind that sign-in.
                    </p>
                  ) : (
                    <p className="text-sm text-indigo-900">Confirmed; waiting for enrolment.</p>
                  )}
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" onClick={() => act(load)} loading={busy}>
                      Refresh
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => cancel(c.case_id)}
                      loading={busy}
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
