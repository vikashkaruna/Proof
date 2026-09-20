'use client';

import { useState } from 'react';
import {
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Input,
  Label,
  Badge,
} from '@axiom/ui';

interface Props {
  tenantId: string;
  accountEmail: string;
  /** Rendered on the server from the user's own rows, so the first paint is correct. */
  initialStatus: MfaStatus;
}

interface MfaStatus {
  enrolled: boolean;
  recoveryCodesRemaining: number;
  factors: Array<{
    id: string;
    factorType: string;
    status: string;
    label: string | null;
    activatedAt: string | null;
    lastUsedAt: string | null;
  }>;
}

interface PendingEnrolment {
  factorId: string;
  secret: string;
  provisioningUri: string;
}

/**
 * TOTP enrolment (W1 · SEC-8).
 *
 * No QR image: rendering one needs an encoder dependency, and the two paths
 * that work without it are genuinely sufficient — the `otpauth://` link opens
 * the authenticator directly on a phone, and the grouped secret is what every
 * authenticator's "enter a setup key" flow expects. Adding a QR is a later
 * convenience, not a gap in the control.
 */
export function MfaEnrolment({ tenantId, accountEmail, initialStatus }: Props) {
  const [status, setStatus] = useState<MfaStatus>(initialStatus);
  const [pending, setPending] = useState<PendingEnrolment | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const headers = {
    'Content-Type': 'application/json',
    'X-Tenant-Id': tenantId,
  };

  const readError = async (res: Response, fallback: string) => {
    const body = await res.json().catch(() => ({}));
    return (body?.error?.message as string | undefined) ?? `${fallback} (HTTP ${res.status})`;
  };

  /**
   * Re-read after an action. Called only from event handlers — never from an
   * effect, which is what makes the initial server-rendered status the single
   * source of truth for the first paint.
   */
  async function refresh() {
    try {
      const res = await fetch('/api/bff/v1/mfa/status', { headers });
      if (res.ok) setStatus(await res.json());
    } catch {
      // A failed status re-read is not worth an error banner; the actions
      // below report their own failures, which is where it matters.
    }
  }

  async function begin() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/bff/v1/mfa/enrol', {
        method: 'POST',
        headers,
        body: JSON.stringify({ label: 'Authenticator' }),
      });
      if (!res.ok) {
        setError(await readError(res, 'Could not start enrolment'));
        return;
      }
      setPending(await res.json());
      setCode('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start enrolment');
    } finally {
      setBusy(false);
    }
  }

  async function activate() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/bff/v1/mfa/enrol/activate', {
        method: 'POST',
        headers,
        body: JSON.stringify({ code: code.trim() }),
      });
      if (!res.ok) {
        setError(await readError(res, 'That code was not accepted'));
        return;
      }
      const body = await res.json();
      setRecoveryCodes(body.recoveryCodes as string[]);
      setPending(null);
      setCode('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Activation failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Authenticator app
          {status.enrolled ? (
            <Badge variant="success">Active</Badge>
          ) : (
            <Badge variant="warning">Not enrolled</Badge>
          )}
        </CardTitle>
        <CardDescription>
          A time-based one-time password (TOTP) from an app such as Google Authenticator, 1Password
          or Aegis. It works offline, which is why it is the primary factor rather than email or
          SMS.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {error && (
          <div className="rounded-md border border-ember-500 bg-ember-50 p-3 text-sm text-ember-700">
            {error}
          </div>
        )}

        {recoveryCodes && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-4">
            <p className="text-sm font-semibold text-amber-900">
              Save these recovery codes now — this is the only time they are shown.
            </p>
            <p className="mt-1 text-xs text-amber-800">
              Each works once. They are stored hashed, so nobody, including us, can read them back.
              They are the only way in if you lose the authenticator.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-1.5 font-mono text-sm text-amber-950 sm:grid-cols-3">
              {recoveryCodes.map((rc) => (
                <span key={rc} className="rounded bg-white/70 px-2 py-1">
                  {rc}
                </span>
              ))}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="mt-3"
              onClick={() => setRecoveryCodes(null)}
            >
              I have saved them
            </Button>
          </div>
        )}

        {pending && (
          <div className="flex flex-col gap-3 rounded-md border border-slate-300 bg-slate-50 p-4">
            <p className="text-sm font-medium text-slate-800">
              Add this to your authenticator, then enter the code it shows.
            </p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="setupKey">Setup key (for manual entry)</Label>
              <code
                id="setupKey"
                className="select-all break-all rounded bg-white px-3 py-2 font-mono text-sm text-slate-800"
              >
                {pending.secret}
              </code>
            </div>
            <p className="text-xs text-slate-600">
              On a phone,{' '}
              <a href={pending.provisioningUri} className="font-medium text-indigo-600 underline">
                open this link
              </a>{' '}
              to add it directly. The account will appear as {accountEmail}.
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="activationCode">6-digit code</Label>
                <Input
                  id="activationCode"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && code.trim()) void activate();
                  }}
                  placeholder="123456"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                />
              </div>
              <Button variant="accent" onClick={activate} loading={busy} disabled={!code.trim()}>
                Activate
              </Button>
              <Button variant="ghost" onClick={() => setPending(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {!pending && (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="accent" onClick={begin} loading={busy}>
              {status.enrolled ? 'Replace authenticator' : 'Enrol an authenticator'}
            </Button>
            {status.enrolled && (
              <span className="text-sm text-slate-600">
                {status.recoveryCodesRemaining} recovery code
                {status.recoveryCodesRemaining === 1 ? '' : 's'} remaining
              </span>
            )}
          </div>
        )}

        {status.enrolled && !pending && (
          <p className="text-xs text-slate-500">
            Replacing an active authenticator asks you to confirm with the current one (or a
            recovery code) first. Without that, anyone who got hold of your session could simply
            enrol their own device and approve as you.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
