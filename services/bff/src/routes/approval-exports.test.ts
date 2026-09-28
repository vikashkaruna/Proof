import { beforeEach, describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { randomUUID } from 'node:crypto';
import { approvalExportRoutes } from './approval-exports.js';
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
  instance.route('/v1', approvalExportRoutes({ db: fixture.db }));
  return instance;
}

describe('Approval Exports HTTP Routes', () => {
  it('lists approval history with enriched plan and approver metadata', async () => {
    const planId = randomUUID();
    const approverId = fixture.owner;
    const tokenId = randomUUID();

    // Seed plan
    fixture.base.rows('remediation_plans').push({
      id: planId,
      tenant_id: tenant,
      title: 'Consent Architecture Remediation',
      version: 2,
    });

    // Seed approval token
    fixture.base.rows('approval_tokens').push({
      id: tokenId,
      tenant_id: tenant,
      plan_id: planId,
      approver_id: approverId,
      action_ids: [randomUUID()],
      mode: 'batch',
      status: 'issued',
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      signature: 'abcdef1234567890abcdef1234567890',
      reason: 'Verified pre-flight checks',
    });

    const res = await app().request('/v1/approvals/history', { method: 'GET' });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      items: Array<{ token_id: string; plan_title: string; mode: string; status: string }>;
      total: number;
    };
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    const item = body.items.find((i) => i.token_id === tokenId);
    expect(item).toBeDefined();
    expect(item?.plan_title).toBe('Consent Architecture Remediation');
    expect(item?.mode).toBe('batch');
    expect(item?.status).toBe('issued');
  });

  it('rejects invalid export format parameters', async () => {
    const res = await app().request('/v1/approvals/export?format=xml', { method: 'GET' });
    expect(res.status).toBe(400);
  });

  it('exports approval history in JSON format and calls record_approval_export RPC', async () => {
    const planId = randomUUID();
    const tokenId = randomUUID();
    const exportId = randomUUID();

    fixture.base.rows('remediation_plans').push({
      id: planId,
      tenant_id: tenant,
      title: 'Data Retention Remediation',
      version: 1,
    });

    fixture.base.rows('approval_tokens').push({
      id: tokenId,
      tenant_id: tenant,
      plan_id: planId,
      approver_id: fixture.owner,
      action_ids: [randomUUID()],
      mode: 'batch',
      status: 'consumed',
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      consumed_at: new Date().toISOString(),
      signature: 'fedcba0987654321fedcba0987654321',
      reason: 'Batch dry run completed',
    });

    let recordedRpcArgs: Record<string, unknown> | null = null;
    fixture.db.rpc = ((name: string, args: Record<string, unknown>) => {
      if (name === 'record_approval_export') {
        recordedRpcArgs = args;
        return abortableResult(
          Promise.resolve({
            data: {
              exportId,
              status: 'exported',
              artifactSha256: args.p_artifact_sha256,
              createdAt: new Date().toISOString(),
            },
            error: null,
          }),
        );
      }
      return abortableResult(Promise.resolve({ data: null, error: null }));
    }) as never;

    const res = await app().request('/v1/approvals/export?format=json', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('x-export-id')).toBe(exportId);
    expect(res.headers.get('x-export-sha256')).toMatch(/^[0-9a-f]{64}$/);

    expect(recordedRpcArgs).not.toBeNull();
    expect(recordedRpcArgs!['p_format']).toBe('json');
    expect(recordedRpcArgs!['p_tenant_id']).toBe(tenant);

    const json = (await res.json()) as {
      kind: string;
      summary: { total_records: number };
      approvals: Array<{ token_id: string }>;
    };
    expect(json.kind).toBe('approval_history_export');
    expect(json.summary.total_records).toBeGreaterThanOrEqual(1);
  });

  it('exports approval history in HTML format', async () => {
    fixture.db.rpc = ((name: string, args: Record<string, unknown>) => {
      if (name === 'record_approval_export') {
        return abortableResult(
          Promise.resolve({
            data: {
              exportId: randomUUID(),
              status: 'exported',
              artifactSha256: args.p_artifact_sha256,
              createdAt: new Date().toISOString(),
            },
            error: null,
          }),
        );
      }
      return abortableResult(Promise.resolve({ data: null, error: null }));
    }) as never;

    const res = await app().request('/v1/approvals/export?format=html', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html');
    const text = await res.text();
    expect(text).toContain('<!DOCTYPE html>');
    expect(text).toContain('Approval History Export');
  });

  it('exports approval history in CSV format', async () => {
    fixture.db.rpc = ((name: string, args: Record<string, unknown>) => {
      if (name === 'record_approval_export') {
        return abortableResult(
          Promise.resolve({
            data: {
              exportId: randomUUID(),
              status: 'exported',
              artifactSha256: args.p_artifact_sha256,
              createdAt: new Date().toISOString(),
            },
            error: null,
          }),
        );
      }
      return abortableResult(Promise.resolve({ data: null, error: null }));
    }) as never;

    const res = await app().request('/v1/approvals/export?format=csv', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv');
    const text = await res.text();
    expect(text).toContain('token_id,plan_id,plan_title');
  });

  it('exports approval history in PDF format', async () => {
    fixture.db.rpc = ((name: string, args: Record<string, unknown>) => {
      if (name === 'record_approval_export') {
        return abortableResult(
          Promise.resolve({
            data: {
              exportId: randomUUID(),
              status: 'exported',
              artifactSha256: args.p_artifact_sha256,
              createdAt: new Date().toISOString(),
            },
            error: null,
          }),
        );
      }
      return abortableResult(Promise.resolve({ data: null, error: null }));
    }) as never;

    const res = await app().request('/v1/approvals/export?format=pdf', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const bytes = await res.arrayBuffer();
    const header = Buffer.from(bytes).subarray(0, 5).toString('ascii');
    expect(header).toBe('%PDF-');
  });

  it('exports plan-specific approval history via /v1/plans/:id/approval-export', async () => {
    const planId = randomUUID();
    let recordedPlanId: unknown = null;

    fixture.db.rpc = ((name: string, args: Record<string, unknown>) => {
      if (name === 'record_approval_export') {
        recordedPlanId = args.p_plan_id;
        return abortableResult(
          Promise.resolve({
            data: {
              exportId: randomUUID(),
              status: 'exported',
              artifactSha256: args.p_artifact_sha256,
              createdAt: new Date().toISOString(),
            },
            error: null,
          }),
        );
      }
      return abortableResult(Promise.resolve({ data: null, error: null }));
    }) as never;

    const res = await app().request(`/v1/plans/${planId}/approval-export?format=json`, {
      method: 'GET',
    });
    expect(res.status).toBe(200);
    expect(recordedPlanId).toBe(planId);
  });
});
