import { beforeEach, describe, it, expect, vi } from 'vitest';
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
  it('accepts only bounded source identifiers and refuses viewer auditor requests', async () => {
    const body = {
      engagementId: randomUUID(),
      assessmentRunId: randomUUID(),
      title: 'Recorded assessment review',
    };
    const viewer = await app(fixture.viewer, UserRole.VIEWER).request(
      '/v1/reports/statutory/auditor/requests',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    expect(viewer.status).toBe(403);
    const unsourced = await app().request('/v1/reports/statutory/auditor/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, content: { auditor_attestation: 'invented' } }),
    });
    expect(unsourced.status).toBe(400);
  });
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

  it('refuses legacy technical HTML and PDF without a retained source-bound version', async () => {
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
    expect(htmlRes.status).toBe(409);
    expect(await htmlRes.json()).toMatchObject({
      error: { code: 'source_bound_workflow_required' },
    });

    // A legacy content row has no verified retained object version.
    const pdfRes = await app().request(`/v1/reports/statutory/${reportId}/pdf`, {
      method: 'GET',
    });
    expect(pdfRes.status).toBe(404);
    expect(pdfRes.headers.get('content-type')).not.toContain('application/pdf');
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

  it('refuses legacy regeneration of a source-bound DPB PDF or HTML', async () => {
    const reportId = randomUUID();
    fixture.base.rows('reports').push({
      id: reportId,
      tenant_id: tenant,
      kind: 'dpb',
      title: 'Recorded breach review',
      content_text: JSON.stringify({ kind: 'dpb_notification_review_pack' }),
      status: 'published',
      created_by: fixture.owner,
    });
    for (const format of ['html', 'pdf']) {
      const response = await app().request(`/v1/reports/statutory/${reportId}/${format}`);
      expect(response.status).toBe(format === 'html' ? 409 : 404);
      expect(await response.json()).toEqual({
        error: { code: format === 'html' ? 'source_bound_workflow_required' : 'report_not_found' },
      });
    }
  });
});

it.each(['malformed', 'changed'] as const)(
  'auditor request refuses %s expected actor before any writer',
  async (mode) => {
    const writer = vi.fn();
    fixture.db.rpc = writer as never;
    const response = await app().request('/v1/reports/statutory/auditor/requests', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-expected-actor-id': mode === 'malformed' ? 'broken' : randomUUID(),
      },
      body: JSON.stringify({
        engagementId: randomUUID(),
        assessmentRunId: randomUUID(),
        title: 'Exact report request',
        operationKey: randomUUID(),
      }),
    });
    expect(response.status).toBe(mode === 'malformed' ? 400 : 409);
    expect(writer).not.toHaveBeenCalled();
  },
);
it.each([false, true])(
  'auditor request retains legacy absence and matching current actor header (present=%s)',
  async (present) => {
    const requestId = randomUUID();
    const writer = vi.fn(() =>
      abortableResult(
        Promise.resolve({
          data: { requestId, status: 'requested', reportId: null, replayed: false },
          error: null,
        }),
      ),
    );
    fixture.db.rpc = writer as never;
    const response = await app().request('/v1/reports/statutory/auditor/requests', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(present ? { 'x-expected-actor-id': fixture.owner.toUpperCase() } : {}),
      },
      body: JSON.stringify({
        engagementId: randomUUID(),
        assessmentRunId: randomUUID(),
        title: 'Exact report request',
        operationKey: randomUUID(),
      }),
    });
    expect(response.status).toBe(201);
    expect(writer).toHaveBeenCalledOnce();
    expect(await response.json()).toMatchObject({ requestId });
  },
);
