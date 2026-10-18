'use server';

import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@axiom/supabase';
import { appOrigin } from '@/lib/app-origin';

const NEUTRAL =
  'If an account exists for that address, a password reset link is on its way. It expires soon and works once.';

/** Sends the provider's one-time recovery link. The answer never reveals
 * whether the address has an account, and provider errors are not echoed. */
export async function requestPasswordResetAction(formData: FormData) {
  const email = String(formData.get('email') ?? '').trim();
  if (!email || email.length > 320 || !email.includes('@'))
    redirect(
      `/forgot-password?error=${encodeURIComponent('Enter the email address you sign in with.')}`,
    );
  try {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${appOrigin()}/auth/reset-callback`,
    });
  } catch {
    // Same answer either way: no account enumeration, no provider detail.
  }
  redirect(`/forgot-password?message=${encodeURIComponent(NEUTRAL)}`);
}

/** Sets the new password on the recovery session, then ends EVERY session of
 * the account (this one included): the person signs in again with the new
 * password, and their authenticator is still required as usual. */
export async function updatePasswordAction(formData: FormData) {
  const password = String(formData.get('password') ?? '');
  const confirm = String(formData.get('confirm') ?? '');
  const fail = (message: string) =>
    redirect(`/reset-password?error=${encodeURIComponent(message)}`);
  if (password.length < 12 || password.length > 256) fail('Use at least 12 characters.');
  if (password !== confirm) fail('The two passwords do not match.');
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user)
    redirect(
      `/forgot-password?error=${encodeURIComponent('That reset link has expired or was already used. Request a new one.')}`,
    );
  const { error } = await supabase.auth.updateUser({ password });
  if (error) fail('The password could not be changed. Choose a different password and try again.');
  await supabase.auth.signOut({ scope: 'global' });
  redirect(
    `/login?message=${encodeURIComponent('Password changed. Sign in with your new password; you will still be asked for your authenticator code.')}`,
  );
}
