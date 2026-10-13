import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import type { Variables } from '../types.js';
import { monitoringOutcomeRoutes } from './monitoring-outcomes.js';
const state = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('../services/monitoring-outcomes.js', () => ({ loadMonitoringOutcomes: state.load }));
const tenant = '11111111-1111-4111-8111-111111111111',
  schedule = '22222222-2222-4222-8222-222222222222';
function app(role: UserRole = UserRole.VIEWER) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('role', role);
    c.set('tenantId', tenant);
    c.set('token', 'synthetic-session');
    await next();
  });
  app.route('/v1', monitoringOutcomeRoutes());
  return app;
}
beforeEach(() => {
  vi.clearAllMocks();
  state.load.mockResolvedValue({
    tenantId: tenant,
    schedules: [{ scheduleId: schedule, state: 'never_recorded', fire: null }],
  });
});
it('retains existing viewer read authority and derives tenant from verified context', async () => {
  const r = await app().request('/v1/monitoring/outcomes?scheduleIds=' + schedule);
  expect(r.status).toBe(200);
  expect(state.load).toHaveBeenCalledWith(tenant, 'synthetic-session', [schedule]);
});
it('agent membership cannot read human outcomes', async () => {
  expect(
    (await app(UserRole.AGENT).request('/v1/monitoring/outcomes?scheduleIds=' + schedule)).status,
  ).toBe(403);
  expect(state.load).not.toHaveBeenCalled();
});
it.each([
  'scheduleIds=bad',
  'scheduleIds=' + schedule + ',' + schedule,
  'scheduleIds=' + schedule + '&actorId=' + tenant,
  'scheduleIds=' + schedule + '&scheduleIds=' + tenant,
])('refuses malformed/spoofed query before store %s', async (query) => {
  expect((await app().request('/v1/monitoring/outcomes?' + query)).status).toBe(400);
  expect(state.load).not.toHaveBeenCalled();
});
it('returns bounded unavailable without fabricated empty success', async () => {
  state.load.mockResolvedValue(null);
  const r = await app().request('/v1/monitoring/outcomes?scheduleIds=' + schedule);
  expect(r.status).toBe(503);
  expect(await r.json()).toEqual({
    error: {
      code: 'monitoring_outcomes_unavailable',
      message: 'Recorded monitoring outcomes are unavailable',
    },
  });
});
