import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@axiom/supabase';

/** The emailed recovery link lands here with a one-time code. Exchanging it
 * sets a short recovery session (route handlers may set cookies; pages may
 * not), then the person chooses a new password. A bad or used code goes back
 * to the request page; nothing about the account is revealed. */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const target = request.nextUrl.clone();
  target.search = '';
  if (code && /^[A-Za-z0-9-]{8,128}$/.test(code)) {
    try {
      const supabase = await createSupabaseServerClient();
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (!error) {
        target.pathname = '/reset-password';
        return NextResponse.redirect(target);
      }
    } catch {
      // fall through
    }
  }
  target.pathname = '/forgot-password';
  target.searchParams.set(
    'error',
    'That reset link has expired or was already used. Request a new one.',
  );
  return NextResponse.redirect(target);
}
