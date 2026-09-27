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
    const res = await app(fixture.viewer, UserRole.VIEWER).request('/v1/reports/statutory/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'auditor',
        engagementId: randomUUID(),
        title: 'Statutory Auditor Pack',
        content: {},
      }),
    });
    expect(res.status).toBe(403);
  });

  it('generates an Auditor Pack statutory report and calls record_statutory_report_draft and attach_statutory_report_pdf', async () => {
    const engagementId = randomUUID();
    const runId = randomUUID();
    const reportId = randomUUID();

    const auditorContent = {
      schema_version: 1,
      kind: 'auditor_pack',
      title: 'Annual DPDPA Independent Audit Pack',
      tenant_id: tenant,
      engagement_id: engagementId,
      assessment_run_id: runId,
      assessment_result_digest: 'a'.repeat(64),
      library_version: 'v1.0.0',
      library_digest: 'b'.repeat(64),
      generated_at: new Date().toISOString(),
      branding: {
        product: 'Axiom Proof',
        company: 'Axiom Minds Private Limited',
        company_url: 'https://axiomminds.ai',
      },
      audit_metadata: {
        audit_firm_or_internal: 'Deloitte India Risk Advisory',
        lead_auditor_name: 'Rajesh Sharma, FCA',
        period_start: '2026-01-01T00:00:00.000Z',
        period_end: '2026-06-30T23:59:59.000Z',
        scope_description: 'Full statutory assessment of customer personal data pipelines and consent registries.',
      },
      compliance_metrics: {
        posture_score: 90,
        total_controls_audited: 10,
        compliant_controls: 8,
        partially_compliant_controls: 2,
        non_compliant_controls: 0,
        not_applicable_controls: 0,
        evidence_items_reviewed: 15,
      },
      control_evaluations: [
        {
          control_id: 'CNS-01',
          title: 'Consent Notice Multilingual Accessibility',
          domain: 'CNS',
          statutory_reference: 'DPDPA 2023 Section 5(1)',
          status: 'compliant',
          score: 100,
          auditor_notes: 'All 22 Schedule VIII languages operational.',
          evidence_references: [
            {
              evidence_id: randomUUID(),
              receipt_id: randomUUID(),
              content_hash: 'c'.repeat(64),
              collected_by: 'saakshi',
              collected_at: new Date().toISOString(),
              provenance: 'production',
            },
          ],
        },
      ],
      signatures: {
        prepared_by: {
          name: 'Prativedan',
          role: 'Autonomous Compliance Synthesizer',
          agent: 'prativedan',
        },
        auditor_attestation: {
          auditor_name: 'Rajesh Sharma',
          firm: 'Deloitte India Risk Advisory',
          designation: 'Lead Privacy Auditor',
          attestation_statement: 'I hereby attest that the controls and linked evidence were reviewed in accordance with DPDPA 2023 rules.',
          timestamp: new Date().toISOString(),
        },
        approved_by: null,
      },
    };

    let rpcCalled = false;
    let attachCalled = false;

    fixture.db.rpc = ((name: string, args: Record<string, unknown>) => {
      if (name === 'record_statutory_report_draft') {
        rpcCalled = true;
        return abortableResult(
          Promise.resolve({
            data: {
              reportId,
              status: 'draft',
              kind: args.p_kind,
              contentHash: 'd'.repeat(64),
              htmlHash: 'e'.repeat(64),
            },
            error: null,
          })
        );
      }
      if (name === 'attach_statutory_report_pdf') {
        attachCalled = true;
        return abortableResult(
          Promise.resolve({
            data: {
              reportId: args.p_report_id,
              pdfSha256: args.p_pdf_sha256,
              status: 'pdf_attached',
            },
            error: null,
          })
        );
      }
      return abortableResult(Promise.resolve({ data: null, error: null }));
    }) as never;

    const res = await app().request('/v1/reports/statutory/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'auditor',
        engagementId,
        title: 'Annual DPDPA Independent Audit Pack',
        libraryVersion: 'v1.0.0',
        content: auditorContent,
      }),
    });

    expect(res.status).toBe(201);
    expect(rpcCalled).toBe(true);
    expect(attachCalled).toBe(true);
    const body = (await res.json()) as { reportId: string; status: string; kind: string };
    expect(body.reportId).toBe(reportId);
    expect(body.status).toBe('draft');
    expect(body.kind).toBe('auditor');
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
      created_at: new Date().toISOString(),
    });

    fixture.db.rpc = ((name: string, args: Record<string, unknown>) => {
      if (name === 'attach_statutory_report_pdf') {
        return abortableResult(Promise.resolve({ data: { status: 'pdf_attached' }, error: null }));
      }
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
      created_at: new Date().toISOString(),
    });

    const res = await app().request('/v1/reports/statutory', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reports: Array<{ id: string; kind: string }>; total: number };
    expect(body.reports.some((r) => r.id === repId)).toBe(true);
  });
});
