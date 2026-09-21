'use client';

import { useState } from 'react';
import Link from 'next/link';
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
  enrolmentRequired?: boolean;
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
export function MfaEnrolment({
  tenantId,
  accountEmail,
  initialStatus,
  enrolmentRequired = false,
}: Props) {
  const [status, setStatus] = useState<MfaStatus>(initialStatus);
  const [pending, setPending] = useState<PendingEnrolment | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The open `enrolment` challenge, when replacing a live factor.
   *
   * Replacement is a three-step act and the UI has to model all three: open a
   * challenge, satisfy it, then spend it on the new enrolment. Earlier this
   * component jumped straight to the third step, so the BFF — correctly —
   * refused every press of Replace with `mfa_challenge_required`.
   */
  const [stepUp, setStepUp] = useState<{
    challengeId: string;
    purpose: 'enrolment' | 'factor_revocation';
    factorId?: string;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stepUpCode, setStepUpCode] = useState('');

  const headers = {
    'Content-Type': 'application/json',
    'X-Tenant-Id': tenantId,
  };

  const readError = async (res: Response, fallback: string) => {
    const body = await res.json().catch(() => ({}));
    return {
      code: body?.error?.code as string | undefined,
      message: (body?.error?.message as string | undefined) ?? `${fallback} (HTTP ${res.status})`,
    };
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

  /**
   * Begin enrolment, spending `mfaChallengeId` when one was required.
   *
   * A first enrolment sends none: there is no factor yet to protect, and the
   * BFF opens the enrolment without a step-up. A replacement must send one.
   */
  async function begin(mfaChallengeId?: string) {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/bff/v1/mfa/enrol', {
        method: 'POST',
        headers,
        body: JSON.stringify({ label: 'Authenticator', mfaChallengeId }),
      });
      if (!res.ok) {
        const { message } = await readError(res, 'Could not start enrolment');
        setError(message);
        // The challenge is spent or was never good; a retry needs a new one.
        setStepUp(null);
        return;
      }
      setPending(await res.json());
      setStepUp(null);
      setStepUpCode('');
      setCode('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start enrolment');
    } finally {
      setBusy(false);
    }
  }

  /**
   * The entry point behind the single button: enrol directly, or open an
   * `enrolment` challenge first when a live factor is being replaced.
   */
  async function beginOrChallenge(purpose: 'enrolment' | 'factor_revocation' = 'enrolment') {
    setNotice(null);
    if (!status.enrolled && purpose === 'enrolment') {
      await begin();
      return;
    }
    const factorId = status.factors.find(
      (factor) => factor.factorType === 'totp' && factor.status === 'active',
    )?.id;
    if (!factorId) {
      setError('Refresh the page to read your current authenticator.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/bff/v1/mfa/challenge', {
        method: 'POST',
        headers: {
          ...headers,
          // A step-up challenge is single-use, and the browser-to-BFF bridge
          // derives a key from method + path + body when none is given — which
          // for this fixed body is the same key for this user forever. The
          // second replacement would replay a spent challenge. See
          // `apps/web/src/app/api/bff/idempotency-key.test.ts`.
          'Idempotency-Key': `mfa-challenge-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({ purpose, factorId }),
      });
      if (!res.ok) {
        const { message } = await readError(res, 'Could not start verification');
        setError(message);
        return;
      }
      const body = await res.json();
      setStepUp({ challengeId: body.challengeId as string, purpose, factorId });
      setStepUpCode('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start verification');
    } finally {
      setBusy(false);
    }
  }

  /** Satisfy the replacement challenge, then spend it on the new enrolment. */
  async function confirmStepUp() {
    if (!stepUp) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(
        `/api/bff/v1/mfa/challenge/${encodeURIComponent(stepUp.challengeId)}/verify`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ code: stepUpCode.trim() }),
        },
      );
      if (!res.ok) {
        const { code: errorCode, message } = await readError(res, 'Verification failed');
        setError(message);
        // Terminal for this challenge — keeping the panel open would only
        // collect codes against an id the server will never accept again.
        if (errorCode === 'attempts_exhausted' || errorCode === 'challenge_expired') {
          setStepUp(null);
        }
        return;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verification failed');
      return;
    } finally {
      setBusy(false);
    }
    // Outside the try: `begin` manages its own busy state and errors, and a
    // failure there is an enrolment failure, not a verification one.
    if (stepUp.purpose === 'factor_revocation') {
      await revoke(stepUp.challengeId, stepUp.factorId!);
    } else {
      await begin(stepUp.challengeId);
    }
  }

  async function revoke(mfaChallengeId: string, factorId: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/bff/v1/mfa/factors/${encodeURIComponent(factorId)}/revoke`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ mfaChallengeId }),
      });
      if (!res.ok) {
        setError((await readError(res, 'Could not revoke authenticator')).message);
        return;
      }
      setRecoveryCodes(null);
      setNotice(
        'Authenticator revoked. Its recovery codes and MFA-verified sessions have ended. Enrol a new authenticator before continuing if your role requires MFA.',
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not revoke authenticator');
    } finally {
      setStepUp(null);
      setStepUpCode('');
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
        const { message } = await readError(res, 'That code was not accepted');
        setError(message);
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

        {recoveryCodes && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-4">
            <p className="text-sm font-semibold text-amber-900">
              Save these recovery codes now — this is the only time they are shown.
            </p>
            <p className="mt-1 text-xs text-amber-800">
              Each works once. They are stored hashed, so nobody, including us, can read them back.
              They are the only way in if you lose the authenticator.
            </p>
            <div
              data-testid="recovery-codes"
              className="mt-3 grid grid-cols-2 gap-1.5 font-mono text-sm text-amber-950 sm:grid-cols-3"
            >
              {recoveryCodes.map((rc) => (
                <span
                  key={rc}
                  data-testid="recovery-code"
                  className="rounded bg-white/70 px-2 py-1"
                >
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

        {stepUp && !pending && (
          <div
            data-testid={
              stepUp.purpose === 'enrolment' ? 'mfa-replace-step-up' : 'mfa-revoke-step-up'
            }
            className="flex flex-col gap-3 rounded-md border border-indigo-300 bg-indigo-50 p-4"
          >
            <p className="text-sm font-medium text-indigo-900">
              {stepUp.purpose === 'enrolment'
                ? 'Confirm with your current authenticator before replacing it.'
                : 'Confirm revocation of your authenticator.'}
            </p>
            <p className="text-xs text-indigo-800">
              Enter the six-digit code from the authenticator you have now, or one of your recovery
              codes if you no longer have it.
              {stepUp.purpose === 'factor_revocation'
                ? ' Revoking ends your recovery codes and MFA-verified sessions. You must enrol again if your role requires MFA.'
                : ' The new authenticator is only issued once this is satisfied.'}
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="stepUpCode">Current code or recovery code</Label>
                <Input
                  id="stepUpCode"
                  value={stepUpCode}
                  onChange={(e) => setStepUpCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && stepUpCode.trim()) void confirmStepUp();
                  }}
                  placeholder="123456"
                  autoComplete="one-time-code"
                />
              </div>
              <Button
                variant="accent"
                onClick={confirmStepUp}
                loading={busy}
                disabled={!stepUpCode.trim()}
              >
                {stepUp.purpose === 'enrolment' ? 'Confirm and replace' : 'Confirm revocation'}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setStepUp(null);
                  setStepUpCode('');
                  setError(null);
                }}
              >
                Cancel
              </Button>
            </div>
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

        {!pending && !stepUp && (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="accent" onClick={() => beginOrChallenge()} loading={busy}>
              {status.enrolled ? 'Replace authenticator' : 'Enrol an authenticator'}
            </Button>
            {status.enrolled && (
              <Button
                variant="ghost"
                onClick={() => beginOrChallenge('factor_revocation')}
                disabled={busy}
              >
                Revoke authenticator
              </Button>
            )}
            {status.enrolled && (
              <span className="text-sm text-slate-600">
                {status.recoveryCodesRemaining} recovery code
                {status.recoveryCodesRemaining === 1 ? '' : 's'} remaining
              </span>
            )}
          </div>
        )}

        {enrolmentRequired && status.enrolled && !recoveryCodes && !pending && !stepUp && (
          <Link href="/verify" prefetch={false} className="font-medium text-indigo-600 underline">
            Continue to sign-in verification
          </Link>
        )}

        {status.enrolled && !pending && !stepUp && (
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
