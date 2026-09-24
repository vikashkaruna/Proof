'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { createSupabaseServerClient } from '@axiom/supabase';
import { safeRedirectPath } from '@/lib/safe-redirect';

export async function loginAction(formData: FormData) {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const redirectTo = safeRedirectPath(formData.get('redirect'));

  if (!email || !password) {
    redirect(`/login?error=${encodeURIComponent('Email and password are required.')}`);
  }

  const cookieStore = await cookies();
  cookieStore.delete('axiom_e2e_logged_out');

  let authenticatedUser: any = null;
  let authError: string | null = null;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (!error && data?.user) {
      authenticatedUser = data.user;
    } else if (error) {
      authError = error.message;
    }
  } catch (err: any) {
    console.warn('[loginAction] Supabase auth attempt notice:', err?.message || err);
    authError = err?.message || 'fetch failed';
  }

  // Handle authentication failure.
  //
  // SEC-2 / SEC-13 row 6: a "sovereign session" block stood here. Whenever
  // login hit a network or 5xx failure and the environment was anything but
  // production, it minted the founder identity WITHOUT CREDENTIALS and wrote
  // `axiom_e2e_bypass=true` as a non-httpOnly cookie. That cookie then
  // satisfied the unguarded clause in the page middleware and the BFF proxy —
  // in every environment, production included — so a transient Supabase
  // outage permanently handed a real user a full takeover credential.
  //
  // A failure to authenticate is now a failure to authenticate. A dependency
  // being unreachable is reported as such and is never an authorisation.
  if (!authenticatedUser) {
    const isNetworkOrServiceFailure =
      authError?.includes('fetch failed') ||
      authError?.includes('ENOTFOUND') ||
      authError?.includes('ECONNREFUSED') ||
      authError?.includes('500') ||
      authError?.includes('502') ||
      authError?.includes('503');

    const errorMessage = isNetworkOrServiceFailure
      ? 'Authentication service is unreachable. Please try again shortly.'
      : authError || 'Invalid email or password.';

    redirect(`/login?error=${encodeURIComponent(errorMessage)}`);
  }

  // A "tenant membership sync" block stood here. If the signing-in user held
  // no membership, it selected the OLDEST tenant in the database and inserted
  // them into it as `owner`, using the service-role client to bypass RLS.
  //
  // Signup is open — `/login?mode=signup` requires no invitation — and the
  // same block ran there. So any person who created an account became owner of
  // the first tenant on the platform, which on a real deployment is the
  // flagship client. Under the W1 capability matrix that is authority to
  // approve and execute remediation against their estate, manage their users,
  // and see every finding, DSAR and breach they have.
  //
  // A user who belongs to no tenant is not an owner of someone else's.
  // `requireTenantContext()` sends them to /onboarding, where they create
  // their own tenant subject to the SEC-5 quota, or accept an invitation.

  try {
    revalidatePath('/', 'layout');
  } catch (err) {
    console.warn('[loginAction] revalidatePath warning:', err);
  }
  redirect(redirectTo);
}

export async function signupAction(formData: FormData) {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const fullName = String(formData.get('full_name') ?? '').trim();

  if (!email || !password) {
    redirect(`/login?mode=signup&error=${encodeURIComponent('Email and password are required.')}`);
  }
  if (password.length < 12) {
    redirect(
      `/login?mode=signup&error=${encodeURIComponent('Password must be at least 12 characters.')}`,
    );
  }

  const cookieStore = await cookies();
  cookieStore.delete('axiom_e2e_logged_out');

  let signupUser: any = null;
  let signupError: string | null = null;
  let hasSession = false;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName },
        emailRedirectTo: `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001'}/login`,
      },
    });
    if (!error && data?.user) {
      signupUser = data.user;
      hasSession = Boolean(data.session);
    } else if (error) {
      signupError = error.message;
    }
  } catch (err: any) {
    console.warn('[signupAction] Supabase signup notice:', err?.message || err);
    signupError = err?.message || 'fetch failed';
  }

  if (!signupUser) {
    const isNetworkOrServiceFailure =
      !signupError ||
      signupError.includes('fetch failed') ||
      signupError.includes('ENOTFOUND') ||
      signupError.includes('ECONNREFUSED') ||
      signupError.includes('500') ||
      signupError.includes('502') ||
      signupError.includes('503');

    const errorMessage = isNetworkOrServiceFailure
      ? 'Authentication service is unreachable or unconfigured. Please check database and auth service connectivity.'
      : signupError || 'Signup failed. Please check your information and try again.';

    redirect(`/login?mode=signup&error=${encodeURIComponent(errorMessage)}`);
  }

  // Mirror the auth user into public.users.
  //
  // The automatic grant of `owner` on the oldest tenant that used to follow
  // this is removed — see the note in loginAction. Signup creates an account
  // and nothing else; tenant membership comes from onboarding or an invitation.
  //
  // This runs with the user's OWN session rather than the service-role client:
  // the `users_insert_self` RLS policy (migration 0001) permits a user to
  // insert exactly their own row, which is all this needs. SEC-3's invariant
  // holds — the web app never needs the service-role key.
  if (signupUser && hasSession) {
    try {
      const supabase = await createSupabaseServerClient();
      const { error: mirrorError } = await supabase.from('users').upsert({
        id: signupUser.id,
        email,
        full_name: fullName,
      });
      if (mirrorError) {
        console.warn('[signupAction] Profile mirror notice:', mirrorError.message);
      }
    } catch (mirrorErr) {
      console.warn('[signupAction] Profile mirror notice:', mirrorErr);
    }
  }

  try {
    revalidatePath('/', 'layout');
  } catch (err) {
    console.warn('[signupAction] revalidatePath warning:', err);
  }

  if (hasSession) {
    redirect('/dashboard');
  }

  redirect(
    `/login?message=${encodeURIComponent(
      'Account created successfully. Please sign in with your credentials.',
    )}`,
  );
}

export async function logoutAction() {
  const cookieStore = await cookies();
  cookieStore.set('axiom_e2e_logged_out', 'true', { path: '/', httpOnly: false });
  cookieStore.delete('axiom_user_email');

  // Explicitly delete any sb-*-auth-token cookies to ensure session purge
  for (const cookie of cookieStore.getAll()) {
    if (cookie.name.startsWith('sb-') && cookie.name.includes('-auth-token')) {
      cookieStore.delete(cookie.name);
    }
  }

  try {
    const supabase = await createSupabaseServerClient();
    if (supabase?.auth?.signOut) {
      await supabase.auth.signOut();
    }
  } catch (err) {
    console.error('Error during signOut:', err);
  }

  try {
    revalidatePath('/', 'layout');
  } catch (err) {
    console.warn('[logoutAction] revalidatePath warning:', err);
  }
  redirect('/');
}
