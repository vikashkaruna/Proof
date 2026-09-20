import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@axiom/supabase';
import { VerifyForm } from './verify-form';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ redirect?: string }>;
}

/**
 * The login-time MFA prompt (W1 · SEC-8).
 *
 * Deliberately outside the `(app)` group. Every page in there goes through
 * `requireTenantContext()`, which is what sends an unverified session here —
 * so rendering the prompt inside that group would be a redirect loop.
 *
 * It does not call `requireTenantContext()` itself for the same reason. All it
 * needs is a session; establishing which tenant the person is acting in is
 * precisely what they are not yet allowed to do.
 */
export default async function VerifyPage({ searchParams }: PageProps) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { redirect: target } = await searchParams;

  // Only same-origin paths are honoured. A `redirect` parameter is attacker-
  // controllable, and an open redirect on the page that follows authentication
  // is how a phishing flow borrows your domain for its landing page.
  const safeTarget =
    target && target.startsWith('/') && !target.startsWith('//') ? target : '/dashboard';

  // Someone who reaches this page with no factor cannot satisfy anything here.
  const { data: factors } = await supabase
    .from('user_mfa_factors')
    .select('id')
    .eq('factor_type', 'totp')
    .eq('status', 'active')
    .limit(1);
  if (!factors || factors.length === 0) redirect('/settings/security?enrol=required');

  // The MFA endpoints sit under `/v1/*` and so go through tenant resolution.
  // Pass a tenant the user actually belongs to rather than letting the proxy
  // fall back to its default, which this user may well not be a member of —
  // the BFF would refuse, and the refusal would look like a broken code.
  const { data: memberships } = await supabase
    .from('tenant_users')
    .select('tenant_id')
    .eq('user_id', user.id)
    .limit(1);
  const tenantId = memberships?.[0]?.tenant_id as string | undefined;
  if (!tenantId) redirect('/onboarding');

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="font-heading text-2xl font-semibold tracking-tight text-indigo-500">
          Verify it&apos;s you
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          Your role requires a second factor. Enter the current code from your authenticator to
          finish signing in.
        </p>
      </div>
      <VerifyForm redirectTo={safeTarget} tenantId={tenantId} accountEmail={user.email ?? ''} />
    </div>
  );
}
