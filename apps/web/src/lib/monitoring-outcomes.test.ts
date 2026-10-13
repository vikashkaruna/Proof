import { beforeEach, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadMonitoringOutcomes } from './monitoring-outcomes';
const tenant = '11111111-1111-4111-8111-111111111111',
  schedule = '22222222-2222-4222-8222-222222222222';
const good = {
  tenantId: tenant,
  schedules: [{ scheduleId: schedule, state: 'never_recorded', fire: null }],
};
const client = {
  auth: { getSession: async () => ({ data: { session: { access_token: 'synthetic-session' } } }) },
} as SupabaseClient;
const transport = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', transport);
  transport.mockResolvedValue({ ok: true, json: async () => ({ data: good }) });
});
it('uses authenticated BFF read with tenant header and no redirect/cache', async () => {
  expect(await loadMonitoringOutcomes(client, tenant, [schedule])).toEqual(good);
  expect(transport.mock.calls[0]?.[1]).toMatchObject({
    headers: { Authorization: 'Bearer synthetic-session', 'X-Tenant-Id': tenant },
    cache: 'no-store',
    redirect: 'error',
  });
});
it.each([
  { ok: false },
  { ok: true, json: async () => ({ data: { ...good, tenantId: schedule } }) },
  { ok: true, json: async () => ({ data: { ...good, schedules: [] } }) },
  { ok: true, json: async () => ({ data: null }) },
])('keeps unreadable proof unavailable', async (response) => {
  transport.mockResolvedValue(response);
  expect(await loadMonitoringOutcomes(client, tenant, [schedule])).toBeNull();
});
it('no session or malformed IDs cannot trigger BFF request', async () => {
  expect(
    await loadMonitoringOutcomes(
      { auth: { getSession: async () => ({ data: { session: null } }) } } as SupabaseClient,
      tenant,
      [schedule],
    ),
  ).toBeNull();
  expect(await loadMonitoringOutcomes(client, tenant, [schedule, schedule])).toBeNull();
  expect(transport).not.toHaveBeenCalled();
});
