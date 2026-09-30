import { beforeEach, describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { randomUUID } from 'node:crypto';
import { statutoryReportRoutes } from './statutory-reports.js';
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
  instance.route('/v1', statutoryReportRoutes({ db: fixture.db }));
  return instance;
}

describe('Statutory Reports HTTP Routes', () => {
  it('enforces RBAC on statutory report generation — viewer is denied', async () => {
    const res = await app(fixture.viewer, UserRole.VIEWER).request(
      '/v1/reports/statutory/generate',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'auditor',
          engagementId: randomUUID(),
          title: 'Statutory Auditor Pack',
          content: {},
        }),
      },
    );
    expect(res.status).toBe(403);
  });

  it('refuses caller-authored statutory claims without invoking draft or PDF storage', async () => {
    let rpcCalled = false;
    fixture.db.rpc = ((_name: string) => {
      rpcCalled = true;
      return abortableResult(Promise.resolve({ data: null, error: null }));
    }) as never;

    const res = await app().request('/v1/reports/statutory/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'auditor',
        engagementId: randomUUID(),
        title: 'Auditor Pack',
        content: { arbitrary_claim: 'independently verified' },
      }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'source_bound_workflow_required' } });
    expect(rpcCalled).toBe(false);
  });

  it('renders and streams a statutory report HTML and PDF', async () => {
    const reportId = randomUUID();
    const engagementId = randomUUID();

    const technicalContent = {
      schema_version: 1,
      kind: 'technical_remediation_register',
      title: 'Technical Remediation Register',
      tenant_id: tenant,
      plan_id: randomUUID(),
      plan_version: 3,
      generated_at: new Date().toISOString(),
      branding: {
        product: 'Axiom Proof',
        company: 'Axiom Minds Private Limited',
        company_url: 'https://axiomminds.ai',
      },
      register_summary: {
        total_actions: 1,
        approved_actions: 1,
        dry_run_passed_actions: 1,
        rollback_validated_actions: 1,
        executed_actions: 1,
        estimated_total_rollback_time_seconds: 30,
      },
      actions: [
        {
          action_id: randomUUID(),
          sequence: 1,
          action_type: 'data.mask',
          description: 'Apply dynamic data masking on sensitive customer PII',
          risk_class: 'medium',
          risk_score: 50,
          target_systems: ['prod-db-primary'],
          blast_radius_records: 500,
          dry_run_status: 'passed',
          dry_run_completed_at: new Date().toISOString(),
          rollback_validated: true,
          rollback_time_seconds: 15,
          approval_status: 'approved',
          approved_by: fixture.owner,
          execution_outcome: 'success',
          idempotency_key: 'idem-act-1',
        },
      ],
      signatures: {
        prepared_by: {
          name: 'Prativedan',
          role: 'Autonomous Compliance Synthesizer',
          agent: 'prativedan',
        },
        reviewed_by: null,
      },
    };

    fixture.base.rows('reports').push({
      id: reportId,
      tenant_id: tenant,
      kind: 'technical',
      title: 'Technical Remediation Register',
      content_text: JSON.stringify(technicalContent),
      status: 'draft',
      created_by: fixture.owner,
      created_at: new Date().toISOString(),
    });

    let rpcCalled = false;
    fixture.db.rpc = ((_name: string) => {
      rpcCalled = true;
      return abortableResult(Promise.resolve({ data: null, error: null }));
    }) as never;

    // 1. Test HTML endpoint
    const htmlRes = await app().request(`/v1/reports/statutory/${reportId}/html`, {
      method: 'GET',
    });
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get('content-type')).toContain('text/html');
    const html = await htmlRes.text();
    expect(html).toContain('Technical Remediation Register');

    // 2. Test PDF endpoint
    const pdfRes = await app().request(`/v1/reports/statutory/${reportId}/pdf`, {
      method: 'GET',
    });
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers.get('content-type')).toBe('application/pdf');
    const pdfBytes = await pdfRes.arrayBuffer();
    const pdfHeader = Buffer.from(pdfBytes).subarray(0, 5).toString('ascii');
    expect(pdfHeader).toBe('%PDF-');
    expect(rpcCalled).toBe(false);

    const otherHtml = await app(fixture.viewer, UserRole.VIEWER).request(
      `/v1/reports/statutory/${reportId}/html`,
    );
    const otherPdf = await app(fixture.viewer, UserRole.VIEWER).request(
      `/v1/reports/statutory/${reportId}/pdf`,
    );
    expect(otherHtml.status).toBe(404);
    expect(otherPdf.status).toBe(404);
  });

  it('lists statutory reports for the tenant', async () => {
    const repId = randomUUID();
    fixture.base.rows('reports').push({
      id: repId,
      tenant_id: tenant,
      kind: 'dpb',
      title: 'DPB Annual Compliance Filing',
      library_version: 'v1.0.0',
      generated_by_agent: 'prativedan',
      status: 'published',
      created_by: fixture.owner,
      created_at: new Date().toISOString(),
    });

    const privateId = randomUUID();
    fixture.base.rows('reports').push({
      id: privateId,
      tenant_id: tenant,
      kind: 'auditor',
      title: 'Another creator draft',
      status: 'draft',
      created_by: fixture.founder,
      created_at: new Date().toISOString(),
    });

    const res = await app().request('/v1/reports/statutory', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      reports: Array<{ id: string; kind: string }>;
      total: number;
    };
    expect(body.reports.some((r) => r.id === repId)).toBe(true);
    expect(body.reports.some((r) => r.id === privateId)).toBe(false);
  });
});
