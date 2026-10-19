import { expect, it, vi } from 'vitest';
import { ownedTargetControllerFactory } from './owned-synthetic-composition.js';
it('real scoped Supabase client sends fixed RPC via target-role Authorization and anon apikey', async () => {
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          fixture_id: '89110000-0000-4000-8000-000000000001',
          resource_id: '89110000-0000-4000-8000-000000000002',
          version: 0,
          audit_log_enabled: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );
  vi.stubGlobal('fetch', fetch);
  try {
    const client = ownedTargetControllerFactory(
      'http://synthetic-postgrest.invalid',
      'synthetic-anon-key',
      'synthetic-scoped-target-role-key',
    )();
    const result = await client
      .rpc('read_owned_synthetic_target', {
        p_tenant_id: '89110000-0000-4000-8000-000000000001',
        p_binding_id: '89110000-0000-4000-8000-000000000002',
        p_engagement_id: '89110000-0000-4000-8000-000000000003',
      })
      .abortSignal(new AbortController().signal);
    expect(result.error).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe(
      'http://synthetic-postgrest.invalid/rest/v1/rpc/read_owned_synthetic_target',
    );
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer synthetic-scoped-target-role-key');
    expect(headers.get('apikey')).toBe('synthetic-anon-key');
    expect(init.method).toBe('POST');
  } finally {
    vi.unstubAllGlobals();
  }
});
