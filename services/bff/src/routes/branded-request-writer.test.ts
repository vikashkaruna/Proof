import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { randomUUID } from 'node:crypto';
import { abortableResult } from '../test/abortable-result.js';
import type { Variables } from '../types.js';
import type { EvidenceDatabase } from '../services/evidence-ingestion.js';
import { BoardReportService } from '../services/board-reports.js';
import { StatutoryReportService } from '../services/statutory-reports.js';
const clients = vi.hoisted(() => ({
  admin: {} as unknown,
  human: {} as unknown,
  statutory: {} as unknown,
}));
vi.mock('@axiom/supabase', () => ({
  createSupabaseAdmin: () => clients.admin,
  createHumanActionWriter: () => clients.human,
  createStatutoryProofWriter: () => clients.statutory,
}));
import { boardReportRoutes } from './board-reports.js';
import { statutoryReportRoutes } from './statutory-reports.js';
const actor = randomUUID(),
  tenant = randomUUID(),
  requestId = randomUUID();
const human = vi.fn(),
  statutory = vi.fn(),
  admin = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  human.mockImplementation((name: string) => {
    if (!['request_clarified_board_report', 'request_clarified_auditor_report'].includes(name))
      throw Error('Human request writer cannot generate or retain proof');
    return abortableResult(Promise.resolve({ data: { requestId }, error: null }));
  });
  statutory.mockImplementation(() => {
    throw Error('Statutory writer has no new-request grant');
  });
  admin.mockImplementation(() => {
    throw Error('Service role has no new-request grant');
  });
  clients.human = { rpc: human };
  clients.statutory = { rpc: statutory };
  clients.admin = { rpc: admin };
});
for (const kind of ['board', 'auditor'] as const) {
  it(`mounted ${kind} request uses human writer, never statutory/service-role credentials`, async () => {
    const app = new Hono<{ Variables: Variables }>();
    app.use('*', async (c, next) => {
      c.set('user', { id: actor } as never);
      c.set('role', UserRole.OWNER);
      c.set('tenantId', tenant);
      await next();
    });
    app.route('/v1', kind === 'board' ? boardReportRoutes() : statutoryReportRoutes());
    const response = await app.request(
      kind === 'board' ? '/v1/reports/board/request' : '/v1/reports/statutory/auditor/requests',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          engagementId: randomUUID(),
          assessmentRunId: randomUUID(),
          operationKey: randomUUID(),
          title: 'Explicit reviewed-source request',
        }),
      },
    );
    expect(response.status).toBe(201);
    expect(human).toHaveBeenCalledWith(
      `request_clarified_${kind}_report`,
      expect.objectContaining({ p_actor_id: actor, p_tenant_id: tenant }),
    );
    expect(statutory).not.toHaveBeenCalled();
    expect(admin).not.toHaveBeenCalled();
  });
  it(`${kind} new request fails closed without the separate human writer`, async () => {
    const db = clients.admin as EvidenceDatabase,
      writer = clients.statutory as EvidenceDatabase;
    const service =
      kind === 'board'
        ? new BoardReportService(db, writer)
        : new StatutoryReportService(db, writer);
    const input = {
      engagementId: randomUUID(),
      assessmentRunId: randomUUID(),
      title: 'Explicit request',
    };
    await expect(
      kind === 'board'
        ? (service as BoardReportService).requestBoardReport(tenant, actor, input)
        : (service as StatutoryReportService).requestAuditorPack(tenant, actor, input),
    ).rejects.toMatchObject({ code: 'report_persistence_unconfirmed', status: 503 });
    expect(statutory).not.toHaveBeenCalled();
    expect(admin).not.toHaveBeenCalled();
  });
}
