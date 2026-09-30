import { afterEach, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadAssessmentSnapshot } from './assessment-snapshot';

const tenantId = '11111111-1111-4111-8111-111111111111';
const engagementId = '22222222-2222-4222-8222-222222222222';
const snapshot = {
  tenantId,
  engagement: { id: engagementId, title: 'Saved review', libraryVersion: '0.1.1', status: 'active' },
  isSdf: false, exposureInr: null, controls: [],
  summary: { pass: 0, partial: 0, fail: 0, unassessed: 0 },
};
function client(token: string | null): SupabaseClient {
  return { auth: { getSession: async () => ({ data: { session: token ? { access_token: token } : null } }) } } as unknown as SupabaseClient;
}
afterEach(() => vi.unstubAllGlobals());

it('does not contact the BFF when there is no session token', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  expect(await loadAssessmentSnapshot(client(null), tenantId)).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});

it('binds the requested engagement and tenant in a no-store authenticated read', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json(snapshot));
  vi.stubGlobal('fetch', fetcher);
  expect(await loadAssessmentSnapshot(client('session-token'), tenantId, engagementId)).toEqual(snapshot);
  const [url, init] = fetcher.mock.calls[0]!;
  expect(new URL(url).searchParams.get('engagementId')).toBe(engagementId);
  expect(init.headers).toMatchObject({ Authorization: 'Bearer session-token', 'X-Tenant-Id': tenantId });
  expect(init).toMatchObject({ cache: 'no-store', redirect: 'error' });
});

it('refuses cross-tenant, wrong-engagement, malformed, and failed responses', async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json({ ...snapshot, tenantId: '33333333-3333-4333-8333-333333333333' }))
    .mockResolvedValueOnce(Response.json({ ...snapshot, engagement: null }))
    .mockResolvedValueOnce(Response.json({ ...snapshot, exposureInr: -1 }))
    .mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 503 }));
  vi.stubGlobal('fetch', fetcher);
  for (let attempt = 0; attempt < 4; attempt++) {
    expect(await loadAssessmentSnapshot(client('session-token'), tenantId, engagementId)).toBeNull();
  }
});

it('treats transport errors as unavailable rather than saved findings', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network failure')));
  expect(await loadAssessmentSnapshot(client('session-token'), tenantId)).toBeNull();
});
