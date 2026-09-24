'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Label } from '@axiom/ui';

interface Props {
  redirectTo: string;
  tenantId: string;
  accountEmail: string;
}

/**
 * Two calls, not one: open a challenge bound to this session, then satisfy it.
 *
 * The challenge is opened here rather than on the server render so that its
 * short window starts when the person is actually at the keyboard — a
 * challenge minted during a page load they walked away from is a window open
 * for no reason.
 */
/**
 * A step-up challenge is single-use by definition, so creating one is NOT an
 * idempotent operation and must never replay.
 *
 * The browser-to-BFF bridge derives an Idempotency-Key from method, path and
 * body when the caller supplies none. For this request that is the same value
 * every time — `POST /v1/mfa/challenge` with a fixed body — while
 * `claim_request` conflicts whenever the stored claim's authority hash
 * differs, and that hash includes the GoTrue session id. So the first
 * verification of a user's life claimed the key, and every later sign-in
 * presented the same key from a different session and was refused
 * `idempotency_conflict` permanently. Within one session it was worse in a
 * quieter way: the claim replayed, handing back a challenge id that had
 * already been consumed.
 *
 * Derived keys are right for approving and executing, where a double submit
 * must not run twice. They are wrong here, so this caller supplies its own.
 */
function freshChallengeKey(): string {
  return `mfa-challenge-${crypto.randomUUID()}`;
}

export function VerifyForm({ redirectTo, tenantId, accountEmail }: Props) {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const headers = { 'Content-Type': 'application/json', 'X-Tenant-Id': tenantId };

  const readError = async (res: Response, fallback: string) => {
    const body = await res.json().catch(() => ({}));
    return (body?.error?.message as string | undefined) ?? `${fallback} (HTTP ${res.status})`;
  };

  async function verify() {
    setError(null);
    setBusy(true);
    try {
      const opened = await fetch('/api/bff/v1/mfa/challenge', {
        method: 'POST',
        headers: { ...headers, 'Idempotency-Key': freshChallengeKey() },
        body: JSON.stringify({ purpose: 'login' }),
      });
      if (!opened.ok) {
        setError(await readError(opened, 'Could not start verification'));
        return;
      }
      const { challengeId } = await opened.json();

      const verified = await fetch(
        `/api/bff/v1/mfa/challenge/${encodeURIComponent(challengeId)}/verify`,
        { method: 'POST', headers, body: JSON.stringify({ code: code.trim() }) },
      );
      if (!verified.ok) {
        setError(await readError(verified, 'That code was not accepted'));
        return;
      }

      // `refresh()` first: the server components re-run and see the new
      // attestation, so the destination does not bounce straight back here.
      router.refresh();
      router.replace(redirectTo);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verification failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div className="rounded-md border border-ember-500 bg-ember-50 p-3 text-sm text-ember-700">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="code">Authentication code</Label>
        <Input
          id="code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && code.trim()) void verify();
          }}
          placeholder="123456"
          autoComplete="one-time-code"
          inputMode="text"
          autoFocus
        />
        <p className="text-xs text-slate-500">
          From your authenticator app, or one of your recovery codes. Signed in as {accountEmail}.
        </p>
      </div>

      <Button variant="accent" size="lg" onClick={verify} loading={busy} disabled={!code.trim()}>
        Verify
      </Button>

      <p className="text-xs text-slate-500">
        Lost your authenticator? A recovery code works here and can be used once. If you have none
        left, an administrator has to reset your enrolment.
      </p>
    </div>
  );
}
