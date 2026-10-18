import Link from 'next/link';
import { AxiomLogo, Button, Card, Input, Label } from '@axiom/ui';
import { requestPasswordResetAction } from '../password-reset-actions';

export const dynamic = 'force-dynamic';

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string }>;
}) {
  const { error, message } = await searchParams;
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
            Reset your password
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Enter the email you sign in with. We will email you a one-time link to choose a new
            password. Your authenticator stays the same.
          </p>
          {message && (
            <div
              role="status"
              className="mt-4 rounded-md border border-teal-500 bg-teal-50 p-3 text-sm text-teal-800"
            >
              {message}
            </div>
          )}
          {error && (
            <div
              role="alert"
              className="mt-4 rounded-md border border-ember-500 bg-ember-50 p-3 text-sm text-ember-700"
            >
              {error}
            </div>
          )}
          <form action={requestPasswordResetAction} className="mt-6 flex flex-col gap-4">
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
            <Button type="submit" variant="primary" fullWidth size="lg">
              Email me a reset link
            </Button>
          </form>
          <p className="mt-6 text-center text-sm text-slate-500">
            Remembered it?{' '}
            <Link href="/login" className="font-medium text-teal-600 hover:underline">
              Back to sign in
            </Link>
          </p>
          <p className="mt-3 text-center text-xs text-slate-500">
            Lost your authenticator as well? Ask an Axiom founder to recover it first.
          </p>
        </div>
      </Card>
    </main>
  );
}
