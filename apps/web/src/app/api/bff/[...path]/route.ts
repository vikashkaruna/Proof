import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@axiom/supabase';

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
  // W1 follow-up: when no tenant has been selected this falls back to the first
  // fixture tenant. That is a UX default, not an authorisation one — since W0.0
  // the BFF verifies membership against `tenant_users` before honouring any
  // X-Tenant-Id, so a caller who is not a member of the default gets a 403
  // rather than another tenant's data.
  if (!headers.has('x-tenant-id')) {
    const activeTenantSlug = request.cookies.get('axiom_active_tenant')?.value;
    const tenantMap: Record<string, string> = {
      meridian: '00000000-0000-0000-0000-000000000001',
      aarogya: '00000000-0000-0000-0000-000000000002',
      streamline: '00000000-0000-0000-0000-000000000003',
    };
    const tenantId =
      (activeTenantSlug && tenantMap[activeTenantSlug]) ||
      (activeTenantSlug &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(activeTenantSlug)
        ? activeTenantSlug
        : '00000000-0000-0000-0000-000000000001');
    headers.set('x-tenant-id', tenantId);
  }
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
