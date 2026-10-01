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
  fixture.base.rows('tenants').push({ id: tenant, name: 'Test Fiduciary' });
});

function app(user = fixture.owner, role: UserRole = UserRole.OWNER, tenantId = tenant) {
  const instance = new Hono<{ Variables: Variables }>();
  instance.use('*', async (c, next) => {
    c.set('user', { id: user } as never);
    c.set('role', role);
    c.set('tenantId', tenantId);
    await next();
  });
  instance.route('/v1', approvalExportRoutes({ db: fixture.db, writerDb: fixture.db }));
  return instance;
}

function seedApproval(overrides: Record<string, unknown> = {}) {
  const planId = randomUUID();
  const actionId = randomUUID();
  const tokenId = randomUUID();
  fixture.base.rows('remediation_plans').push({
    id: planId,
    tenant_id: tenant,
    title: 'Recorded plan',
    version: 2,
  });
  fixture.base.rows('remediation_actions').push({
    id: actionId,
    tenant_id: tenant,
    action_type: 'consent.update',
    dry_run_status: 'dry_run_complete',
    rollback_validated: true,
  });
  fixture.base.rows('approval_tokens').push({
    id: tokenId,
    tenant_id: tenant,
    plan_id: planId,
    approver_id: fixture.owner,
    action_ids: [actionId],
    mode: 'individual',
    status: 'issued',
    issued_at: '2026-09-27T10:00:00.000Z',
    expires_at: '2026-09-27T11:00:00.000Z',
    signature: 'a'.repeat(64),
    reason: null,
    ...overrides,
  });
  return { planId, actionId, tokenId };
}

function installRecorder() {
  const calls: Record<string, unknown>[] = [];
  fixture.db.rpc = ((name: string, args: Record<string, unknown>) => {
    if (name === 'record_approval_export') {
      calls.push(args);
      return abortableResult(
        Promise.resolve({
          data: {
            exportId: randomUUID(),
            status: 'exported',
            artifactSha256: args.p_artifact_sha256,
          },
          error: null,
        }),
      );
    }
    return abortableResult(Promise.resolve({ data: null, error: null }));
  }) as never;
  return calls;
}

describe('Approval Exports HTTP Routes', () => {
  it('allows read-only history while denying a viewer export and a demoted owner', async () => {
    seedApproval();
    const history = await app(fixture.viewer, UserRole.VIEWER).request('/v1/approvals/history');
    expect(history.status).toBe(200);
    expect(history.headers.get('cache-control')).toBe('private, no-store');
    const denied = await app(fixture.viewer, UserRole.VIEWER).request('/v1/approvals/export');
    expect(denied.status).toBe(403);
    fixture.base.rows('tenant_users').find((row) => row.user_id === fixture.owner)!.role =
      UserRole.VIEWER;
    const calls = installRecorder();
    const demoted = await app().request('/v1/approvals/export');
    expect(demoted.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('exports only recorded values and labels unretained issuance context', async () => {
    const { tokenId } = seedApproval({ signature: '', reason: '=SUM(1,1)' });
    installRecorder();
    const response = await app().request('/v1/approvals/export?format=json');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const body = (await response.json()) as {
      approvals: Array<Record<string, unknown>>;
      summary: Record<string, unknown>;
      source_context: Record<string, unknown>;
    };
    expect(body.approvals[0]).toMatchObject({
      token_id: tokenId,
      action_count: 1,
      approver_role: null,
      approval_scopes: null,
      reconciliation_statement: null,
      approval_reason: '=SUM(1,1)',
      signature_preview: null,
      dry_run_status: 'dry_run_complete',
      dry_run_verified: true,
    });
    expect(body.summary.standing_policy_approvals).toBeNull();
    expect(body.source_context).toMatchObject({
      related_fields: 'current_database_values_at_export',
      signature_verification: 'not_performed',
      vault_seal: 'not_performed',
    });
    expect(JSON.stringify(body)).not.toContain('Designated DPO');
  });

  it('escapes spreadsheet formula values in CSV cells', async () => {
    seedApproval();
    fixture.base.rows('remediation_plans')[0]!.title = '\t=HYPERLINK("https://invalid.example")';
    installRecorder();
    const response = await app().request('/v1/approvals/export?format=csv');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"\'\t=HYPERLINK(""https://invalid.example"")"');
  });

  it('links a released exact-version proof without reclassifying this historical export as verified', async () => {
    const { tokenId } = seedApproval();
    const archiveId = randomUUID();
    const reconciliationId = randomUUID();
    fixture.base.rows('approval_proof_archives').push({
      id: archiveId,
      tenant_id: tenant,
      token_id: tokenId,
      reconciliation_id: reconciliationId,
      source_sha256: 'b'.repeat(64),
      status: 'released',
    });
    fixture.base.rows('approval_proof_versions').push({
      archive_id: archiveId,
      tenant_id: tenant,
      version_id: 'immutable-v1',
      retain_until: '2035-01-01T00:00:00.000Z',
    });
    installRecorder();
    const response = await app().request('/v1/approvals/export?format=json');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      approvals: Array<Record<string, unknown>>;
      source_context: Record<string, unknown>;
    };
    expect(body.approvals[0]).toMatchObject({
      reconciliation_statement: null,
      archived_proof: {
        archive_id: archiveId,
        reconciliation_id: reconciliationId,
        source_sha256: 'b'.repeat(64),
        version_id: 'immutable-v1',
      },
    });
    expect(body.source_context.signature_verification).toBe('not_performed');
  });

  it('refuses a truncated export before recording an export event', async () => {
    seedApproval();
    seedApproval();
    const calls = installRecorder();
    const response = await app().request('/v1/approvals/export?format=json&limit=1');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'approval_export_limit_exceeded' },
    });
    expect(calls).toHaveLength(0);
  });

  it('refuses missing actions and related read failures', async () => {
    const { actionId } = seedApproval();
    const calls = installRecorder();
    fixture.base.rows('remediation_actions').splice(
      fixture.base.rows('remediation_actions').findIndex((row) => row.id === actionId),
      1,
    );
    const missing = await app().request('/v1/approvals/export');
    expect(missing.status).toBe(409);
    expect(calls).toHaveLength(0);
    fixture.base.faults.read = true;
    const failed = await app().request('/v1/approvals/export');
    expect(failed.status).toBe(503);
  });

  it('refuses an RPC result that did not confirm the artifact hash', async () => {
    seedApproval();
    fixture.db.rpc = (() =>
      abortableResult(
        Promise.resolve({
          data: { exportId: randomUUID(), status: 'exported', artifactSha256: 'b'.repeat(64) },
          error: null,
        }),
      )) as never;
    const response = await app().request('/v1/approvals/export');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'approval_export_record_failed' },
    });
  });

  it('withholds artifact bytes when export authority is removed during recording', async () => {
    seedApproval();
    fixture.db.rpc = ((_name: string, args: Record<string, unknown>) => {
      fixture.base.rows('tenant_users').find((row) => row.user_id === fixture.owner)!.role =
        UserRole.VIEWER;
      return abortableResult(
        Promise.resolve({
          data: {
            exportId: randomUUID(),
            status: 'exported',
            artifactSha256: args.p_artifact_sha256,
          },
          error: null,
        }),
      );
    }) as never;
    const response = await app().request('/v1/approvals/export?format=json');
    expect(response.status).toBe(403);
    expect(response.headers.get('x-export-sha256')).toBeNull();
  });

  it('lists approval history with enriched plan and approver metadata', async () => {
    const planId = randomUUID();
    const approverId = fixture.owner;
    const tokenId = randomUUID();
    const actionId = randomUUID();

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
      action_ids: [actionId],
      mode: 'batch',
      status: 'issued',
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      signature: 'abcdef1234567890abcdef1234567890',
      reason: 'Verified pre-flight checks',
    });
    fixture.base.rows('remediation_actions').push({
      id: actionId,
      tenant_id: tenant,
      action_type: 'consent.update',
      dry_run_status: 'dry_run_complete',
      rollback_validated: true,
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
    const actionId = randomUUID();

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
      action_ids: [actionId],
      mode: 'batch',
      status: 'consumed',
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      consumed_at: new Date().toISOString(),
      signature: 'fedcba0987654321fedcba0987654321',
      reason: 'Batch dry run completed',
    });
    fixture.base.rows('remediation_actions').push({
      id: actionId,
      tenant_id: tenant,
      action_type: 'consent.update',
      dry_run_status: 'dry_run_complete',
      rollback_validated: true,
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
    expect(text).toContain('token_id,plan_id,current_plan_title');
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
