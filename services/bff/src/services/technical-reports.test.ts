import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TechnicalReportService } from './technical-reports.js';
import { evidenceFixture, tenant } from '../test/evidence-fixture.js';

describe('Technical request summaries', () => {
  it('batches artifact state while withholding unreleased hashes from a requester', async () => {
    const fixture = evidenceFixture();
    const owner = randomUUID();
    const other = randomUUID();
    const founder = randomUUID();
    const requestId = randomUUID();
    const otherRequestId = randomUUID();
    const reportId = randomUUID();
    const otherReportId = randomUUID();
    const buildId = randomUUID();
    const operationKey = randomUUID();
    fixture
      .rows('tenant_users')
      .push(
        { tenant_id: tenant, user_id: owner, role: 'owner' },
        { tenant_id: tenant, user_id: founder, role: 'founder' },
      );
    fixture.rows('users').push({ id: founder, is_axiom_internal: true });
    for (const [id, report, requester] of [
      [requestId, reportId, owner],
      [otherRequestId, otherReportId, other],
    ]) {
      fixture.rows('technical_report_requests').push({
        id,
        tenant_id: tenant,
        plan_id: randomUUID(),
        title: 'Recorded review',
        status: 'drafted',
        report_id: report,
        requested_by: requester,
        created_at: '2026-10-01T00:00:00Z',
      });
      fixture.rows('reports').push({
        id: report,
        tenant_id: tenant,
        kind: 'technical',
        generated_by_agent: 'technical-report-builder',
        status: 'approved',
        content_sha256: 'a'.repeat(64),
      });
    }
    fixture.rows('technical_artifact_builds').push({
      id: buildId,
      tenant_id: tenant,
      report_id: reportId,
      status: 'settled',
      operation_key: operationKey,
      last_error_code: null,
    });
    fixture.rows('technical_artifact_versions').push({
      tenant_id: tenant,
      build_id: buildId,
      artifact_kind: 'technical_pdf',
      content_hash: 'b'.repeat(64),
      byte_size: 1024,
      retain_until: '2033-10-01T00:00:00Z',
    });
    const service = new TechnicalReportService(fixture.db);
    const owned = await service.listRequests(tenant, owner, 25, 0);
    expect(owned.requests).toHaveLength(1);
    expect(owned.requests[0]?.requestId).toBe(requestId);
    expect(owned.requests[0]?.contentHash).toBeNull();
    expect(owned.requests[0]?.artifact?.status).toBe('settled');
    expect(owned.requests[0]?.artifact?.pdf).toBeNull();
    expect(owned.requests[0]?.artifact?.operationKey).toBeNull();
    const internal = await service.listRequests(tenant, founder, 25, 0);
    expect(internal.requests).toHaveLength(2);
    const reviewed = internal.requests.find((row) => row.requestId === requestId);
    expect(reviewed?.contentHash).toBe('a'.repeat(64));
    expect(reviewed?.artifact?.pdf?.sha256).toBe('b'.repeat(64));
    expect(reviewed?.artifact?.operationKey).toBe(operationKey);
  });
});
