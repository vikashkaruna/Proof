import { beforeEach, describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { createHash, randomUUID } from 'node:crypto';
import { boardReportRoutes } from './board-reports.js';
import type { BoardArtifactService } from '../services/board-artifacts.js';
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

function addFrozenSource(requestId: string, runId: string, engagementId: string) {
  const packet = fixture.base.rows('workload_assessment_packets').at(-1)!;
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const controlsText = JSON.stringify(packet.controls);
  const resultText = JSON.stringify(packet.result);
  const controlsSha = hash(controlsText);
  const resultSha = hash(resultText);
  const request = fixture.base.rows('board_report_requests').at(-1)!;
  request.library_digest = controlsSha;
  request.assessment_result_digest = resultSha;
  const sourceText = JSON.stringify({
    schema_version: 1,
    serialization: 'postgres-jsonb-text-v1',
    kind: 'board_source',
    request_id: requestId,
    tenant_id: tenant,
    engagement_id: engagementId,
    assessment_run_id: runId,
    library_version: '2023.1',
    controls_text: controlsText,
    controls_sha256: controlsSha,
    result_text: resultText,
    result_sha256: resultSha,
    finalized_at: new Date().toISOString(),
    receipts: { finalized: { id: '3' } },
  });
  fixture.base.rows('board_request_sources').push({
    tenant_id: tenant,
    request_id: requestId,
    source_text: sourceText,
    source_sha256: hash(sourceText),
    controls_sha256: controlsSha,
    result_sha256: resultSha,
  });
}

describe('Board Reports HTTP Routes', () => {
  it('routes founder artifact build, reconcile and explicit retry with bounded operation keys', async () => {
    const reportId = randomUUID();
    const operationKey = randomUUID();
    const build = vi.fn(async () => ({ reportId, operationKey, status: 'pending' }));
    const reconcile = vi.fn(async () => ({ reportId, operationKey, status: 'pending' }));
    const retryMissing = vi.fn(async () => ({ reportId, operationKey, status: 'settled' }));
    const instance = new Hono<{ Variables: Variables }>();
    instance.use('*', async (c, next) => {
      c.set('user', { id: fixture.founder } as never);
      c.set('role', UserRole.FOUNDER);
      c.set('tenantId', tenant);
      await next();
    });
    instance.route(
      '/v1',
      boardReportRoutes({
        db: fixture.db,
        artifacts: { build, reconcile, retryMissing } as unknown as BoardArtifactService,
      }),
    );
    for (const [path, status] of [
      [`/v1/reports/board/${reportId}/artifacts`, 202],
      [`/v1/reports/board/${reportId}/artifacts/reconcile`, 202],
      [`/v1/reports/board/${reportId}/artifacts/retry-missing`, 200],
    ] as const) {
      const response = await instance.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operationKey }),
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ reportId, operationKey });
    }
    expect(build).toHaveBeenCalledWith(
      tenant,
      fixture.founder,
      reportId,
      operationKey,
      expect.any(AbortSignal),
    );
    expect(reconcile).toHaveBeenCalledWith(
      tenant,
      fixture.founder,
      reportId,
      operationKey,
      expect.any(AbortSignal),
    );
    expect(retryMissing).toHaveBeenCalledWith(
      tenant,
      fixture.founder,
      reportId,
      operationKey,
      expect.any(AbortSignal),
    );
    const invalid = await instance.request(`/v1/reports/board/${reportId}/artifacts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationKey, unexpected: true }),
    });
    expect(invalid.status).toBe(400);
  });
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
          }),
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

  it('generates a draft without recording a fictional PDF object', async () => {
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
      library_digest: '2222222222222222222222222222222222222222222222222222222222222222',
      library_version: '2023.1',
      controls: [
        {
          id: 'DPDPA-SEC-01',
          title: 'Unencrypted Personal Data',
          domain: 'Security',
          severity: 'critical',
          remediation_patterns: ['Enable KMS encryption.'],
        },
      ],
      result: {
        library_version: '2023.1',
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
      finalized_at: new Date().toISOString(),
      finalized_receipt: '3',
    });
    addFrozenSource(reqId, runId, engId);

    const calls: string[] = [];
    let recordedContent: string | undefined;
    fixture.db.rpc = ((name: string, args: Record<string, unknown>) => {
      calls.push(name);
      if (name === 'record_board_report_draft') {
        recordedContent = args.p_content_text as string;
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
          }),
        );
      }
      return abortableResult(Promise.resolve({ data: null, error: null }));
    }) as never;

    const res = await app(fixture.founder, UserRole.FOUNDER).request(
      `/v1/reports/board/${reqId}/generate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { reportId: string; status: string };
    expect(body.reportId).toBe(repId);
    expect(body.status).toBe('draft');
    expect(calls).toContain('record_board_report_draft');
    expect(calls).not.toContain('attach_board_report_pdf');
    expect(JSON.parse(recordedContent ?? '{}').signatures.prepared_by).toEqual({
      name: 'Axiom Proof board report builder',
      role: 'Deterministic assessment renderer',
      agent: 'board-report-builder',
    });
  });

  it('denies a non-founder before reading the frozen source', async () => {
    const reqId = randomUUID();
    let sourceRead = false;
    const originalFrom = fixture.db.from.bind(fixture.db);
    fixture.db.from = ((table: string) => {
      if (table === 'board_request_sources') sourceRead = true;
      return originalFrom(table);
    }) as never;
    const res = await app(fixture.owner, UserRole.OWNER).request(
      `/v1/reports/board/${reqId}/generate`,
      { method: 'POST' },
    );
    expect(res.status).toBe(403);
    expect(sourceRead).toBe(false);
  });

  it('refuses missing assessment metrics before recording a draft', async () => {
    const reqId = randomUUID();
    const runId = randomUUID();
    fixture.base.rows('board_report_requests').push({
      id: reqId,
      tenant_id: tenant,
      engagement_id: randomUUID(),
      assessment_run_id: runId,
      title: 'Board report',
      assessment_result_digest: '1'.repeat(64),
      library_digest: '2'.repeat(64),
      library_version: '2023.1',
    });
    fixture.base.rows('workload_assessment_packets').push({
      run_id: runId,
      tenant_id: tenant,
      finalized_at: new Date().toISOString(),
      finalized_receipt: 3,
      result_digest: '1'.repeat(64),
      library_digest: '2'.repeat(64),
      library_version: '2023.1',
      controls: [{ id: 'DPDPA-SEC-01', title: 'Security', domain: 'Security', severity: 'high' }],
      result: {
        library_version: '2023.1',
        findings: [{ control_id: 'DPDPA-SEC-01', score: 20, rationale: 'Gap' }],
      },
    });
    addFrozenSource(
      reqId,
      runId,
      fixture.base.rows('board_report_requests').at(-1)!.engagement_id as string,
    );
    let recorded = false;
    fixture.db.rpc = ((name: string) => {
      if (name === 'record_board_report_draft') recorded = true;
      return abortableResult(Promise.resolve({ data: null, error: null }));
    }) as never;
    const res = await app(fixture.founder, UserRole.FOUNDER).request(
      `/v1/reports/board/${reqId}/generate`,
      {
        method: 'POST',
      },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'assessment_source_incomplete' } });
    expect(recorded).toBe(false);
  });

  it('refuses a changed frozen source before recording a draft', async () => {
    const reqId = randomUUID();
    const runId = randomUUID();
    const engId = randomUUID();
    fixture.base.rows('board_report_requests').push({
      id: reqId,
      tenant_id: tenant,
      engagement_id: engId,
      assessment_run_id: runId,
      title: 'Board report',
      library_version: '2023.1',
    });
    fixture.base.rows('board_request_sources').push({
      request_id: reqId,
      tenant_id: tenant,
      source_text: '{"kind":"board_source","changed":true}',
      source_sha256: '0'.repeat(64),
      controls_sha256: '1'.repeat(64),
      result_sha256: '2'.repeat(64),
    });
    let recorded = false;
    fixture.db.rpc = ((name: string) => {
      if (name === 'record_board_report_draft') recorded = true;
      return abortableResult(Promise.resolve({ data: null, error: null }));
    }) as never;
    const res = await app(fixture.founder, UserRole.FOUNDER).request(
      `/v1/reports/board/${reqId}/generate`,
      { method: 'POST' },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'assessment_source_conflict' } });
    expect(recorded).toBe(false);
  });

  it('refuses regenerated PDF when no verified exact object version exists', async () => {
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
      engagement_id: contentPayload.engagement_id,
      kind: 'board',
      title: 'Q3 Board Report',
      generated_by_agent: 'board-report-builder',
      content_text: JSON.stringify(contentPayload),
      content_sha256: createHash('sha256').update(JSON.stringify(contentPayload)).digest('hex'),
      reviewed_content_hash: createHash('sha256')
        .update(JSON.stringify(contentPayload))
        .digest('hex'),
      released_archive_hash: null,
      status: 'published',
      created_by: fixture.founder,
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

    const res = await app(fixture.viewer, UserRole.VIEWER).request(
      `/v1/reports/board/${repId}/pdf`,
      {
        method: 'GET',
      },
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'report_artifact_unverified' } });
  });

  it('does not stream an unpublished board draft to another tenant member', async () => {
    const repId = randomUUID();
    fixture.base.rows('board_report_artifacts').push({
      id: randomUUID(),
      tenant_id: tenant,
      report_id: repId,
    });
    fixture.base.rows('reports').push({
      id: repId,
      tenant_id: tenant,
      engagement_id: randomUUID(),
      kind: 'board',
      title: 'Private draft',
      generated_by_agent: 'board-report-builder',
      content_text: '{}',
      content_sha256: createHash('sha256').update('{}').digest('hex'),
      reviewed_content_hash: null,
      released_archive_hash: null,
      status: 'draft',
      created_by: fixture.founder,
    });
    const res = await app(fixture.viewer, UserRole.VIEWER).request(
      `/v1/reports/board/${repId}/pdf`,
    );
    expect(res.status).toBe(403);
  });

  it('scopes board requests to a live manager and gives the internal founder a tenant-wide view', async () => {
    const now = new Date().toISOString();
    fixture.base.rows('board_report_requests').push(
      {
        id: randomUUID(),
        engagement_id: randomUUID(),
        assessment_run_id: randomUUID(),
        report_id: null,
        title: 'Owner request',
        status: 'requested',
        updated_at: now,
        tenant_id: tenant,
        requested_by: fixture.owner,
        created_at: now,
      },
      {
        id: randomUUID(),
        engagement_id: randomUUID(),
        assessment_run_id: randomUUID(),
        report_id: null,
        title: 'Viewer request',
        status: 'requested',
        updated_at: now,
        tenant_id: tenant,
        requested_by: fixture.viewer,
        created_at: now,
      },
    );
    const res = await app(fixture.owner, UserRole.OWNER).request('/v1/reports/board/requests');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { requests: Array<{ title: string }> };
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]?.title).toBe('Owner request');
    expect(Object.keys(body.requests[0]!)).not.toContain('requested_by');
    const founder = await app(fixture.founder, UserRole.FOUNDER).request(
      '/v1/reports/board/requests',
    );
    expect(founder.status).toBe(200);
    expect(((await founder.json()) as { requests: unknown[] }).requests).toHaveLength(2);
    fixture.base.rows('tenant_users').splice(
      fixture.base
        .rows('tenant_users')
        .findIndex((row) => row.user_id === fixture.owner && row.tenant_id === tenant),
      1,
    );
    const revoked = await app(fixture.owner, UserRole.OWNER).request('/v1/reports/board/requests');
    expect(revoked.status).toBe(403);
  });

  it('lists bounded finalized assessment options and rejects unbounded pagination', async () => {
    const engagementId = randomUUID();
    const runId = randomUUID();
    const now = new Date().toISOString();
    fixture.base
      .rows('engagements')
      .push({ id: engagementId, tenant_id: tenant, title: 'Q3 scope' });
    fixture.base.rows('workload_assessment_packets').push({
      run_id: runId,
      tenant_id: tenant,
      engagement_id: engagementId,
      library_version: '2023.1',
      finalized_at: now,
      finalized_receipt: 3,
    });
    const res = await app(fixture.owner, UserRole.OWNER).request(
      '/v1/reports/board/assessment-options',
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { assessments: unknown[] }).assessments).toEqual([
      {
        assessmentRunId: runId,
        engagementId,
        engagementTitle: 'Q3 scope',
        finalizedAt: now,
        libraryVersion: '2023.1',
      },
    ]);
    expect((await app().request('/v1/reports/board/assessment-options?limit=1000')).status).toBe(
      400,
    );
    expect((await app().request('/v1/reports/board/requests?offset=-1')).status).toBe(400);
  });
});
