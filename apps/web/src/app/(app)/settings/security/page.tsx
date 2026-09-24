import { PageHeader, Card, CardHeader, CardTitle, CardDescription, CardContent } from '@axiom/ui';
import { requireTenantContext } from '@/lib/tenant-context';
import { MfaEnrolment } from './mfa-enrolment';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ enrol?: string }>;
}

/**
 * Account security — MFA enrolment (W1 · SEC-8).
 *
 * Deliberately a personal page rather than a tenant-admin one. A user's
 * enrolment state is their own security data: `user_mfa_factors` is readable
 * only by its owner (migration 0012), including by a tenant owner, because an
 * owner knowing which of their approvers lack a factor is not worth the
 * precedent of letting one user read another's credential metadata.
 */
export default async function SecuritySettingsPage({ searchParams }: PageProps) {
  const { enrol } = await searchParams;
  const sentHere = enrol === 'required';
  // Reachable while quarantined — this is the page a user with no factor is
  // sent to, so gating it on having a factor would be a closed loop.
  const ctx = await requireTenantContext(undefined, { allowUnverifiedMfa: true });

  // Read the initial state on the server. The RLS policy `user_mfa_factors_self`
  // (migration 0012) permits exactly this — a user reading their own factors —
  // so the user-scoped client is enough and no service-role key is involved.
  //
  // It also keeps the client component free of a mount-time effect that sets
  // state, which is both a cascading-render hazard and a flash of "not
  // enrolled" for a user who is.
  const { data: factorRows } = await ctx.supabase
    .from('user_mfa_factors')
    .select('id, factor_type, status, label, activated_at, last_used_at, consumed_at');

  const rows = factorRows ?? [];
  const initialStatus = {
    enrolled: rows.some((r) => r.factor_type === 'totp' && r.status === 'active'),
    recoveryCodesRemaining: rows.filter(
      (r) => r.factor_type === 'recovery_code' && r.status === 'active' && r.consumed_at == null,
    ).length,
    factors: rows
      .filter((r) => r.factor_type !== 'recovery_code')
      .map((r) => ({
        id: r.id as string,
        factorType: r.factor_type as string,
        status: r.status as string,
        label: (r.label as string | null) ?? null,
        activatedAt: (r.activated_at as string | null) ?? null,
        lastUsedAt: (r.last_used_at as string | null) ?? null,
      })),
  };

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-6 animate-fade-in">
      <PageHeader
        title="Account security"
        description="Your second factor. Required before you can issue an approval token, and re-checked at the moment of every approval."
      />

      {sentHere && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <strong>Enrol before continuing.</strong> Your role requires a second factor, and you have
          none yet. This page is the only one reachable until an authenticator is active — not to be
          obstructive, but because the alternative is a role that can change a client&apos;s
          production estate protected by a password alone.
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Why this is asked for twice</CardTitle>
          <CardDescription>
            Signing in proves who you are at the start of a session. Approving a remediation plan
            changes a client&apos;s production estate, so it asks again — and the second challenge
            is bound to the specific plan and actions on screen. That binding is what lets the
            ledger record who approved what, rather than only that a logged-in session was present.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-600">
            Signed in as <span className="font-medium text-slate-800">{ctx.email}</span> · role{' '}
            <span className="font-medium text-slate-800">{ctx.role}</span> in{' '}
            <span className="font-medium text-slate-800">{ctx.tenantName}</span>
          </p>
        </CardContent>
      </Card>

      <MfaEnrolment
        tenantId={ctx.tenantId}
        accountEmail={ctx.email ?? 'your account'}
        initialStatus={initialStatus}
        enrolmentRequired={sentHere}
      />
    </div>
  );
}
