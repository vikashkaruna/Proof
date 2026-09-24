'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '@axiom/ui';
import { MutationForm } from '../../estate/estate-client';

export interface MemberRow {
  userId: string;
  email: string;
  role: string;
  acceptedAt: string | null;
}
export interface InvitationRow {
  id: string;
  email: string;
  role: string;
  approval_scopes: string[];
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  delivery_status: 'not_configured' | 'pending' | 'sent' | 'failed';
}

const fieldClass = 'w-full rounded-md border border-input bg-background p-2 text-sm';

function invitationState(i: InvitationRow): string {
  if (i.accepted_at) return 'Accepted';
  if (i.revoked_at) return 'Revoked';
  if (Date.parse(i.expires_at) <= Date.now()) return 'Expired';
  return 'Open';
}

const deliveryLabel: Record<InvitationRow['delivery_status'], string> = {
  not_configured: 'Email not configured — share the link yourself',
  pending: 'Email outcome unknown',
  sent: 'Emailed',
  failed: 'Email failed — share the link yourself',
};

export function MembersClient({
  tenantId,
  canInviteOwners,
  members,
  invitations,
}: {
  tenantId: string;
  canInviteOwners: boolean;
  members: MemberRow[];
  invitations: InvitationRow[];
}) {
  const router = useRouter();
  const pending = useRef<{ key: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [role, setRole] = useState('viewer');

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    if (!pending.current) {
      const scopes = String(form.get('scopes') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      pending.current = {
        key: crypto.randomUUID(),
        body: JSON.stringify({
          email: String(form.get('email') ?? ''),
          role: String(form.get('role') ?? 'viewer'),
          ...(scopes.length ? { approvalScopes: scopes } : {}),
        }),
      };
    }
    setBusy(true);
    setMessage('');
    setLink(null);
    try {
      const res = await fetch('/api/bff/v1/tenant/invitations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': tenantId,
          'Idempotency-Key': pending.current.key,
        },
        body: pending.current.body,
      });
      const body = (await res.json().catch(() => ({}))) as {
        data?: { delivery_status: InvitationRow['delivery_status'] };
        token?: string;
        error?: { message?: string };
      };
      if (!res.ok || !body.data) {
        if (res.status < 500) pending.current = null;
        setMessage(body.error?.message ?? 'The invitation could not be created.');
        return;
      }
      pending.current = null;
      setMessage(`Invitation created. ${deliveryLabel[body.data.delivery_status]}.`);
      // Shown once: the server keeps only a hash of this token.
      if (body.token) setLink(`${window.location.origin}/invite#token=${body.token}`);
      event.currentTarget?.reset?.();
      router.refresh();
    } catch {
      setMessage('The result is unknown. Submit again; the same request is safely retried.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Invite a person</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={invite} className="space-y-3" data-testid="invite-form">
            <div className="space-y-1">
              <Label htmlFor="invite-email">Email</Label>
              <Input id="invite-email" name="email" type="email" required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="invite-role">Role</Label>
              <select
                id="invite-role"
                name="role"
                className={fieldClass}
                value={role}
                onChange={(e) => setRole(e.target.value)}
              >
                {canInviteOwners && <option value="owner">Owner</option>}
                {canInviteOwners && <option value="admin">Admin</option>}
                <option value="approver">Approver</option>
                <option value="reviewer">Reviewer</option>
                <option value="viewer">Viewer</option>
              </select>
            </div>
            {role === 'approver' && (
              <div className="space-y-1">
                <Label htmlFor="invite-scopes">Approval scopes (comma separated, optional)</Label>
                <Input
                  id="invite-scopes"
                  name="scopes"
                  placeholder="Leave empty for unrestricted"
                />
              </div>
            )}
            <Button type="submit" disabled={busy}>
              {busy ? 'Inviting…' : 'Send invitation'}
            </Button>
          </form>
          {message && (
            <p role="status" className="mt-3 text-sm">
              {message}
            </p>
          )}
          {link && (
            <div className="mt-3 space-y-1">
              <Label htmlFor="invite-link">Invitation link (shown once)</Label>
              <Input id="invite-link" readOnly value={link} data-testid="invite-link" />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y text-sm" data-testid="member-list">
            {members.map((m) => (
              <li key={m.userId} className="flex justify-between py-2">
                <span>{m.email}</span>
                <span className="capitalize text-slate-600">{m.role.replace('_', ' ')}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Invitations</CardTitle>
        </CardHeader>
        <CardContent>
          {invitations.length === 0 ? (
            <p className="text-sm text-slate-500">No invitations yet.</p>
          ) : (
            <ul className="divide-y text-sm" data-testid="invitation-list">
              {invitations.map((i) => {
                const state = invitationState(i);
                return (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      {i.email} · <span className="capitalize">{i.role}</span>
                    </span>
                    <span className="text-slate-600" data-testid={`invitation-state-${i.email}`}>
                      {state}
                      {state === 'Open' ? ` · ${deliveryLabel[i.delivery_status]}` : ''}
                    </span>
                    {state === 'Open' && (
                      <MutationForm
                        tenantId={tenantId}
                        path={`/tenant/invitations/${i.id}/revoke`}
                        method="POST"
                        body={() => ({})}
                        label={`Revoke ${i.email}`}
                      >
                        <span className="sr-only">Revoke invitation for {i.email}</span>
                      </MutationForm>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
