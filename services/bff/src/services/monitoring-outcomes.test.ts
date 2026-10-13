import { beforeEach, expect, it, vi } from 'vitest';
import { loadMonitoringOutcomes } from './monitoring-outcomes.js';
const state = vi.hoisted(() => ({ rpc: vi.fn(), client: vi.fn() }));
vi.mock('@axiom/config', () => ({
  loadEnv: () => ({ SUPABASE_URL: 'https://example.invalid', SUPABASE_ANON_KEY: 'public-anon' }),
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => {
    state.client(...args);
    return { rpc: state.rpc };
  },
}));
const tenant = '11111111-1111-4111-8111-111111111111',
  schedule = '22222222-2222-4222-8222-222222222222';
const good = {
  tenantId: tenant,
  schedules: [{ scheduleId: schedule, state: 'never_recorded', fire: null }],
};
beforeEach(() => {
  vi.clearAllMocks();
  state.rpc.mockResolvedValue({ data: good, error: null });
});
it('uses user token and public key only with no actor parameter', async () => {
  expect(await loadMonitoringOutcomes(tenant, 'synthetic-session', [schedule])).toEqual(good);
  expect(state.client).toHaveBeenCalledWith('https://example.invalid', 'public-anon', {
    auth: { persistSession: false },
    global: { headers: { Authorization: 'Bearer synthetic-session' } },
  });
  expect(state.rpc).toHaveBeenCalledWith('read_monitoring_outcomes', {
    p_tenant_id: tenant,
    p_schedule_ids: [schedule],
  });
});
it.each([
  { data: null, error: null },
  { data: good, error: { message: 'sensitive detail' } },
  { data: { error: 'monitoring_read_refused' }, error: null },
  { data: { ...good, tenantId: schedule }, error: null },
  { data: { ...good, schedules: [] }, error: null },
  { data: { ...good, schedules: [{ ...good.schedules[0], scheduleId: tenant }] }, error: null },
])('fails closed for %j', async (response) => {
  state.rpc.mockResolvedValue(response);
  expect(await loadMonitoringOutcomes(tenant, 'synthetic-session', [schedule])).toBeNull();
});
it('refuses invalid request or missing token before creating client', async () => {
  expect(await loadMonitoringOutcomes(tenant, '', [schedule])).toBeNull();
  expect(await loadMonitoringOutcomes(tenant, 's', [schedule, schedule])).toBeNull();
  expect(state.client).not.toHaveBeenCalled();
});
it('bounds transport exceptions to unavailable', async () => {
  state.rpc.mockRejectedValue(new Error('sensitive'));
  expect(await loadMonitoringOutcomes(tenant, 's', [schedule])).toBeNull();
});
