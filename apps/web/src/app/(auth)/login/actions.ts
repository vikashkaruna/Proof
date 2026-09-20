'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { createSupabaseServerClient } from '@axiom/supabase';
import { createSupabaseAdmin } from '@axiom/supabase';

export async function loginAction(formData: FormData) {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const redirectTo = String(formData.get('redirect') || '/dashboard');

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

  if (authenticatedUser) {
    try {
      const admin = createSupabaseAdmin();
      const { data: membership } = await admin
        .from('tenant_users')
        .select('id')
        .eq('user_id', authenticatedUser.id)
        .maybeSingle();

      if (!membership) {
        const { data: defaultTenant } = await admin
          .from('tenants')
          .select('id')
          .order('created_at', { ascending: true })
          .limit(1)
          .maybeSingle();

        if (defaultTenant) {
          await admin.from('tenant_users').insert({
            tenant_id: defaultTenant.id,
            user_id: authenticatedUser.id,
            role: 'owner',
          });
        }
      }
    } catch (adminErr) {
      console.warn('[loginAction] Tenant membership sync notice:', adminErr);
    }
  }

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

  // Mirror to public.users and ensure membership in default tenant
  if (signupUser) {
    try {
      const admin = createSupabaseAdmin();
      await admin.from('users').upsert({
        id: signupUser.id,
        email,
        full_name: fullName,
        is_axiom_internal: false,
      });

      const { data: membership } = await admin
        .from('tenant_users')
        .select('id')
        .eq('user_id', signupUser.id)
        .maybeSingle();

      if (!membership) {
        const { data: defaultTenant } = await admin
          .from('tenants')
          .select('id')
          .order('created_at', { ascending: true })
          .limit(1)
          .maybeSingle();

        if (defaultTenant) {
          await admin.from('tenant_users').insert({
            tenant_id: defaultTenant.id,
            user_id: signupUser.id,
            role: 'owner',
          });
        }
      }
    } catch (adminErr) {
      console.warn('[signupAction] Tenant setup notice:', adminErr);
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
