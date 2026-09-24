import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@axiom/supabase';
import { selectTenantMembership, type TenantMembership } from '@/lib/tenant-selection';

type RouteContext = { params: Promise<{ path: string[] }> };

/** Browser-to-BFF bridge: cookies stay server-side; the BFF receives a bearer token. */
async function forward(request: NextRequest, context: RouteContext) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const accessToken = session?.access_token;

  // SEC-2 step 3: two blocks stood here. The first minted `test-access-token`
  // for any request where `getUser()` returned a user but no session; the
  // second minted it for any request at all in preprod, development, local,
  // any container without NODE_ENV, or — with no environment guard — any
  // request carrying `axiom_e2e_bypass=true` or an `x-e2e-bypass-auth` header.
  // Either header is attacker-controlled, so this was a free founder token.
  //
  // Under `e2e-bypass` the Supabase client is itself the fixture client, which
  // returns a session with `test-access-token` through the normal path above.
  // So no special case is needed here at all: either there is a session or
  // there is a 401.
  if (!accessToken) {
    return NextResponse.json(
      { error: { code: 'unauthorized', message: 'Missing session' } },
      { status: 401 },
    );
  }

  const { path } = await context.params;
  const base = process.env.BFF_PUBLIC_URL || 'http://localhost:4000';
  const target = new URL(`${base.replace(/\/$/, '')}/${path.join('/')}`);
  target.search = request.nextUrl.search;
  const bodyBytes =
    request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
  const headers = new Headers(request.headers);
  headers.set('authorization', `Bearer ${accessToken}`);
  // These exact endpoints run before a caller has a tenant. The BFF still
  // authenticates and authorizes them; the bridge supplies no tenant scope.
  const tenantless =
    (request.method === 'POST' && target.pathname === '/v1/organizations/onboard') ||
    (request.method === 'GET' && target.pathname === '/v1/user/tenants') ||
    (request.method === 'POST' && target.pathname === '/v1/invitations/accept');
  if (tenantless) {
    headers.delete('x-tenant-id');
  } else if (!headers.has('x-tenant-id')) {
    try {
      const {
        data: { user },
        error: authError,
      } = await supabase.auth.getUser();
      if (authError || !user) {
        return NextResponse.json(
          { error: { code: 'unauthorized', message: 'Invalid session' } },
          { status: 401 },
        );
      }
      const { data, error } = await supabase
        .from('tenant_users')
        .select('tenant_id, tenants:tenant_id(slug)')
        .eq('user_id', user.id);
      if (error) throw new Error('membership_lookup_failed');
      const selected = selectTenantMembership(
        (data ?? []) as unknown as TenantMembership[],
        request.cookies.get('axiom_active_tenant')?.value,
      );
      if (!selected) {
        return NextResponse.json(
          {
            error: {
              code: 'tenant_selection_required',
              message: 'Select a tenant you belong to before continuing.',
            },
          },
          { status: 403 },
        );
      }
      headers.set('x-tenant-id', selected.tenant_id);
    } catch {
      return NextResponse.json(
        {
          error: {
            code: 'tenant_lookup_unavailable',
            message: 'Unable to verify the selected tenant. Try again.',
          },
        },
        { status: 503 },
      );
    }
  }
  // Explicit headers are intentional selections. The BFF independently checks
  // current membership and MFA for them, as it does for resolved cookies.
  // The browser is the client here, and a client is entitled to generate its
  // own idempotency key — but it must be stable across a retry or it buys
  // nothing. `Date.now()` + `Math.random()` is unique per attempt, so a
  // double-submit produced two executions. Derive the key from the request
  // instead, so an identical retry replays rather than re-executes.
  if (
    !headers.has('idempotency-key') &&
    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)
  ) {
    const prefix = new TextEncoder().encode(
      `${request.method}:${target.pathname}${target.search}:`,
    );
    const body = new Uint8Array(bodyBytes ?? new ArrayBuffer(0));
    const payload = new Uint8Array(prefix.length + body.length);
    payload.set(prefix, 0);
    payload.set(body, prefix.length);

    const fingerprint = await crypto.subtle.digest('SHA-256', payload);
    const hex = Array.from(new Uint8Array(fingerprint))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    headers.set('idempotency-key', `web-${hex.slice(0, 32)}`);
  }
  headers.delete('host');
  headers.delete('content-length');
  headers.delete('cookie');
  const response = await fetch(target, {
    method: request.method,
    headers,
    body: bodyBytes,
    redirect: 'manual',
  });
  return new NextResponse(response.body, { status: response.status, headers: response.headers });
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
