import { redirect } from 'next/navigation';
import { safeRedirectPath } from '@/lib/safe-redirect';
import Link from 'next/link';
import { createSupabaseServerClient } from '@axiom/supabase';
import { BRAND } from '@axiom/config';
import { AxiomLogo, Button, Card, Input, Label } from '@axiom/ui';
import { cookies } from 'next/headers';
import { loginAction, signupAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    mode?: 'signup' | 'login';
    error?: string;
    message?: string;
    redirect?: string;
    force?: string;
  }>;
}) {
  const resolvedSearchParams = await searchParams;
  const cookieStore = await cookies();
  const isLoggedOut = cookieStore.get('axiom_e2e_logged_out')?.value === 'true';

  let user = null;
  try {
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase.auth.getUser();
    user = data?.user ?? null;
  } catch {
    user = null;
  }

  if (
    user &&
    !isLoggedOut &&
    resolvedSearchParams.force !== 'true' &&
    resolvedSearchParams.redirect &&
    resolvedSearchParams.redirect !== '/login'
  ) {
    redirect(safeRedirectPath(resolvedSearchParams.redirect));
  }

  const isSignup = resolvedSearchParams.mode === 'signup';

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-mist-100 p-4">
      <Link
        href="/"
        className="mb-8 flex items-center justify-center hover:opacity-90 transition-opacity"
      >
        <AxiomLogo size="lg" theme="light" showSubtitle={true} />
      </Link>

      <Card className="w-full max-w-md">
        <div className="p-6">
          {user && !isLoggedOut && (
            <div className="mb-4 rounded-lg border border-teal-200 bg-teal-50 p-3 text-xs text-teal-900 flex items-center justify-between">
              <span>
                Signed in as <strong>{user.email}</strong>
              </span>
              <Link href="/portal" className="font-semibold underline hover:text-teal-700">
                Go to Portal →
              </Link>
            </div>
          )}

          <h1 className="font-heading text-2xl font-semibold text-indigo-500">
            {isSignup ? 'Create your account' : 'Sign in'}
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            {isSignup
              ? 'Welcome to Axiom Proof. Set up your founder / partner access.'
              : 'Welcome back. Sign in to continue.'}
          </p>

          {resolvedSearchParams.message && (
            <div className="mt-4 rounded-md border border-teal-500 bg-teal-50 p-3 text-sm text-teal-800">
              {resolvedSearchParams.message}
            </div>
          )}

          {resolvedSearchParams.error && (
            <div className="mt-4 rounded-md border border-ember-500 bg-ember-50 p-3 text-sm text-ember-700">
              {resolvedSearchParams.error}
            </div>
          )}

          <form action={isSignup ? signupAction : loginAction} className="mt-6 flex flex-col gap-4">
            <input type="hidden" name="redirect" value={resolvedSearchParams.redirect || ''} />
            {isSignup && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="full_name" required>
                  Full name
                </Label>
                <Input
                  id="full_name"
                  name="full_name"
                  type="text"
                  required
                  autoComplete="name"
                  placeholder="Ravi Sharma"
                />
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email" required>
                Email
              </Label>
              <Input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                placeholder="you@company.com"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password" required>
                Password
              </Label>
              <Input
                id="password"
                name="password"
                type="password"
                required
                minLength={12}
                autoComplete={isSignup ? 'new-password' : 'current-password'}
                placeholder="At least 12 characters"
              />
            </div>
            <Button type="submit" variant="primary" fullWidth size="lg">
              {isSignup ? 'Create account' : 'Sign in'}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-slate-500">
            {isSignup ? 'Already have an account?' : "Don't have an account?"}{' '}
            <Link
              href={isSignup ? '/login' : '/login?mode=signup'}
              className="font-medium text-teal-600 hover:underline"
            >
              {isSignup ? 'Sign in' : 'Sign up'}
            </Link>
          </p>
        </div>
      </Card>

      <p className="mt-6 max-w-md text-center text-xs text-slate-500">
        By signing in you agree to our{' '}
        <Link href={`https://${BRAND.primaryDomain}/terms`} className="underline">
          Terms
        </Link>{' '}
        and{' '}
        <Link href={`https://${BRAND.primaryDomain}/privacy`} className="underline">
          Privacy Policy
        </Link>
        . Data residency: {BRAND.dataResidencyRegion}.
      </p>
    </div>
  );
}
