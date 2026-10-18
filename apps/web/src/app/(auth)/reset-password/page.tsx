import Link from 'next/link';
import { AxiomLogo, Button, Card, Input, Label } from '@axiom/ui';
import { createSupabaseServerClient } from '@axiom/supabase';
import { updatePasswordAction } from '../password-reset-actions';

export const dynamic = 'force-dynamic';

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  let email: string | null = null;
  try {
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase.auth.getUser();
    email = data?.user?.email ?? null;
  } catch {
    email = null;
  }
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-mist-100 px-4 py-12">
      <Link
        href="/login"
        className="mb-8 flex items-center justify-center transition-opacity hover:opacity-90"
      >
        <AxiomLogo size="lg" theme="light" showSubtitle={true} />
      </Link>
      <Card className="w-full max-w-md">
        <div className="p-6">
          <h1 className="font-heading text-2xl font-semibold text-indigo-500">
            Choose a new password
          </h1>
          {!email ? (
            <>
              <p
                role="alert"
                className="mt-4 rounded-md border border-ember-500 bg-ember-50 p-3 text-sm text-ember-700"
              >
                This reset link has expired or was already used.
              </p>
              <div className="mt-6">
                <Link href="/forgot-password" className="font-medium text-teal-600 hover:underline">
                  Request a new reset link
                </Link>
              </div>
            </>
          ) : (
            <>
              <p className="mt-1 text-sm text-slate-600">
                For <strong>{email}</strong>. Saving signs this account out everywhere; then sign in
                with the new password and your authenticator code.
              </p>
              {error && (
                <div
                  role="alert"
                  className="mt-4 rounded-md border border-ember-500 bg-ember-50 p-3 text-sm text-ember-700"
                >
                  {error}
                </div>
              )}
              <form action={updatePasswordAction} className="mt-6 flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="password" required>
                    New password
                  </Label>
                  <Input
                    id="password"
                    name="password"
                    type="password"
                    required
                    minLength={12}
                    autoComplete="new-password"
                    placeholder="At least 12 characters"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="confirm" required>
                    Confirm new password
                  </Label>
                  <Input
                    id="confirm"
                    name="confirm"
                    type="password"
                    required
                    minLength={12}
                    autoComplete="new-password"
                  />
                </div>
                <Button type="submit" variant="primary" fullWidth size="lg">
                  Save new password
                </Button>
              </form>
            </>
          )}
        </div>
      </Card>
    </main>
  );
}
