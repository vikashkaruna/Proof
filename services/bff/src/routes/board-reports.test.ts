import { beforeEach, describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { randomUUID } from 'node:crypto';
import { boardReportRoutes } from './board-reports.js';
import { abortableResult } from '../test/abortable-result.js';
import { packFixture } from '../test/evidence-pack-fixture.js';
import { tenant } from '../test/evidence-fixture.js';
import type { Variables } from '../types.js';

let fixture: Awaited<ReturnType<typeof packFixture>>;

beforeEach(async () => {
  fixture = await packFixture();
});

function app(user = fixture.owner, role: UserRole = UserRole.OWNER, tenantId = tenant) {
  const instance = new Hono<{ Variables: Variables }>();
  instance.use('*', async (c, next) => {
    c.set('user', { id: user } as never);
    c.set('role', role);
    c.set('tenantId', tenantId);
    await next();
  });
  instance.route('/v1', boardReportRoutes({ db: fixture.db }));
  return instance;
}

describe('Board Reports HTTP Routes', () => {
  it('enforces RBAC on requesting board report — viewer is denied', async () => {
    const res = await app(fixture.viewer, UserRole.VIEWER).request('/v1/reports/board/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        engagementId: randomUUID(),
        assessmentRunId: randomUUID(),
        title: 'Q3 Board Report',
      }),
    });
    expect(res.status).toBe(403);
  });

  it('validates request payload schema', async () => {
    const res = await app(fixture.owner, UserRole.OWNER).request('/v1/reports/board/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        engagementId: 'invalid-uuid',
        assessmentRunId: randomUUID(),
        title: '',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('allows manager/owner to request board report when parameters are valid', async () => {
    const engId = randomUUID();
    const runId = randomUUID();

    // Mock RPC request_board_report in fixture
    const reqId = randomUUID();
    fixture.db.rpc = ((name: string, _args: Record<string, unknown>) => {
      if (name === 'request_board_report') {
        return abortableResult(
          Promise.resolve({
            data: {
              requestId: reqId,
              status: 'requested',
              replayed: false,
            },
            error: null,
          })
        );
      }
      return abortableResult(Promise.resolve({ data: null, error: null }));
    }) as never;

    const res = await app(fixture.owner, UserRole.OWNER).request('/v1/reports/board/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        engagementId: engId,
        assessmentRunId: runId,
        title: 'Executive DPDPA Board Summary',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { requestId: string; status: string };
    expect(body.requestId).toBe(reqId);
    expect(body.status).toBe('requested');
  });

  it('generates a draft report and calls record_board_report_draft and attach_board_report_pdf', async () => {
    const reqId = randomUUID();
    const repId = randomUUID();
    const runId = randomUUID();
    const engId = randomUUID();

    fixture.base.rows('board_report_requests').push({
      id: reqId,
      tenant_id: tenant,
      engagement_id: engId,
      assessment_run_id: runId,
      title: 'Executive DPDPA Board Summary',
      status: 'requested',
      assessment_result_digest: '1111111111111111111111111111111111111111111111111111111111111111',
      library_version: '2023.1',
      library_digest: '2222222222222222222222222222222222222222222222222222222222222222',
      created_at: new Date().toISOString(),
    });

    fixture.base.rows('workload_assessment_packets').push({
      run_id: runId,
      tenant_id: tenant,
      engagement_id: engId,
      result_digest: '1111111111111111111111111111111111111111111111111111111111111111',
      result: {
        posture_score: 85,
        estimated_exposure_inr: 100000000,
        findings: [
          {
            control_id: 'DPDPA-SEC-01',
            domain: 'Security',
            severity: 'critical',
            title: 'Unencrypted Personal Data',
            score: 0,
            rationale: 'Replica DB unencrypted.',
            remediation_recommendation: 'Enable KMS encryption.',
          },
        ],
      },
      completed_at: new Date().toISOString(),
    });

    const calls: string[] = [];
    fixture.db.rpc = ((name: string, args: Record<string, unknown>) => {
      calls.push(name);
      if (name === 'record_board_report_draft') {
        return abortableResult(
          Promise.resolve({
            data: {
              reportId: repId,
              requestId: reqId,
              status: 'draft',
              contentHash: '3333333333333333333333333333333333333333333333333333333333333333',
              replayed: false,
            },
            error: null,
          })
        );
      }
      if (name === 'attach_board_report_pdf') {
        return abortableResult(
          Promise.resolve({
            data: {
              pdfHash: args.p_pdf_sha256,
            },
            error: null,
          })
        );
      }
      return abortableResult(Promise.resolve({ data: null, error: null }));
    }) as never;

    const res = await app(fixture.founder, UserRole.FOUNDER).request(`/v1/reports/board/${reqId}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { reportId: string; status: string };
    expect(body.reportId).toBe(repId);
    expect(body.status).toBe('draft');
    expect(calls).toContain('record_board_report_draft');
    expect(calls).toContain('attach_board_report_pdf');
  });

  it('streams PDF for authorized reader', async () => {
    const repId = randomUUID();
    const contentPayload = {
      schema_version: 1,
      kind: 'board_report',
      title: 'Q3 Board Report',
      tenant_id: tenant,
      engagement_id: randomUUID(),
      assessment_run_id: randomUUID(),
      assessment_result_digest: '1111111111111111111111111111111111111111111111111111111111111111',
      library_version: '2023.1',
      library_digest: '2222222222222222222222222222222222222222222222222222222222222222',
      generated_at: new Date().toISOString(),
      branding: {
        product: 'Axiom Proof',
        company: 'Axiom Minds Private Limited',
        company_url: 'https://axiomminds.ai',
      },
      executive_summary: {
        posture_score: 90,
        total_controls: 10,
        passed_controls: 9,
        failed_controls: 1,
        critical_gaps: 0,
        high_gaps: 1,
        medium_gaps: 0,
        low_gaps: 0,
        estimated_exposure_inr: 5000000,
        narrative: 'Executive summary narrative text here.',
      },
      key_findings: [],
      action_plan: [],
      signatures: {
        prepared_by: {
          name: 'Prativedan',
          role: 'Reporting Agent',
          agent: 'prativedan',
        },
        approved_by: null,
      },
    };

    fixture.base.rows('reports').push({
      id: repId,
      tenant_id: tenant,
      title: 'Q3 Board Report',
      content_text: JSON.stringify(contentPayload),
    });

    fixture.base.rows('board_report_artifacts').push({
      id: randomUUID(),
      tenant_id: tenant,
      report_id: repId,
      source_json_sha256: '4444444444444444444444444444444444444444444444444444444444444444',
      source_json_bytes: 500,
      html_sha256: '5555555555555555555555555555555555555555555555555555555555555555',
      html_bytes: 1200,
    });

    const res = await app(fixture.viewer, UserRole.VIEWER).request(`/v1/reports/board/${repId}/pdf`, {
      method: 'GET',
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('x-report-sha256')).toMatch(/^[0-9a-f]{64}$/);

    const arrayBuffer = await res.arrayBuffer();
    expect(arrayBuffer.byteLength).toBeGreaterThan(500);
    const header = Buffer.from(arrayBuffer).toString('utf-8', 0, 8);
    expect(header).toContain('%PDF');
  });
});
