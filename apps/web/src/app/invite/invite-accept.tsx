'use client';

import { useRef, useState, useSyncExternalStore } from 'react';
import { Button, Card } from '@axiom/ui';

const STORAGE_KEY = 'axiom_invitation_token';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

let captured: string | null | undefined;

/** Moves a fragment token into session storage once; stable across renders. */
function captureToken(): string | null {
  if (captured !== undefined) return captured;
  const fromHash = new URLSearchParams(window.location.hash.slice(1)).get('token');
  if (fromHash && TOKEN.test(fromHash)) {
    try {
      sessionStorage.setItem(STORAGE_KEY, fromHash);
    } catch {
      // Storage can be unavailable; the token is still usable in this page view.
    }
    // Drop the token from the address bar and history.
    window.history.replaceState(null, '', '/invite');
    captured = fromHash;
    return captured;
  }
  let stored: string | null = null;
  try {
    stored = sessionStorage.getItem(STORAGE_KEY);
  } catch {
    stored = null;
  }
  captured = stored && TOKEN.test(stored) ? stored : null;
  return captured;
}
const subscribe = () => () => {};

export function InviteAccept() {
  // undefined while server rendering; the token is read only in the browser.
  const token = useSyncExternalStore(subscribe, captureToken, () => undefined);
  const ready = token !== undefined;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const key = useRef<string | null>(null);

  async function accept() {
    if (!token || busy) return;
    key.current ??= crypto.randomUUID();
    setBusy(true);
    setMessage('');
    try {
      const res = await fetch('/api/bff/v1/invitations/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key.current },
        body: JSON.stringify({ token }),
        // A signed-out request is redirected to /login by the auth middleware.
        redirect: 'manual',
      });
      if (res.status === 401 || res.type === 'opaqueredirect') {
        window.location.assign('/login?redirect=/invite');
        return;
      }
      const body = (await res.json().catch(() => ({}))) as {
        data?: { tenantId: string };
        error?: { code?: string; message?: string };
      };
      if (!res.ok || !body.data) {
        if (res.status < 500) key.current = null;
        setMessage(body.error?.message ?? 'The invitation could not be accepted. Try again.');
        return;
      }
      captured = null;
      try {
        sessionStorage.removeItem(STORAGE_KEY);
      } catch {
        // Nothing to clean up.
      }
      // Membership is verified server-side on every request; this only selects it.
      document.cookie = `axiom_active_tenant=${body.data.tenantId}; path=/; max-age=31536000; SameSite=Lax`;
      window.location.assign('/dashboard');
    } catch {
      setMessage('The result is unknown. Select Accept again; it is safe to retry.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="w-full max-w-md p-6" data-testid="invite-accept">
      <h1 className="font-heading text-xl font-semibold text-slate-900">Accept your invitation</h1>
      {!ready ? null : token ? (
        <>
          <p className="mt-2 text-sm text-slate-600">
            You must be signed in with the email address the invitation was sent to. Accepting adds
            you to the organization with the role it names.
          </p>
          <Button className="mt-4" onClick={accept} disabled={busy}>
            {busy ? 'Accepting…' : 'Accept invitation'}
          </Button>
        </>
      ) : (
        <p className="mt-2 text-sm text-slate-600">
          This link has no invitation token. Open the link from your invitation again.
        </p>
      )}
      {message && (
        <p role="alert" className="mt-3 text-sm text-ember-700">
          {message}
        </p>
      )}
    </Card>
  );
}
