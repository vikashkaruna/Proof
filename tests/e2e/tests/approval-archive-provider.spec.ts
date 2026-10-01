import { createHash, createHmac } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test, expect } from '@playwright/test';
import { generateTotp } from '@axiom/mfa';
import {
  createApprovablePlan,
  createMfaAccount,
  selectTenant,
  signIn,
  signInAs,
  satisfyLoginMfaWithSecret,
  state,
} from '../fixtures';
import { acceptanceTarget, repoRoot } from '../target';

const signingKey = 'axiom-e2e-persona-harness-approval-signing-key';
const execFileAsync = promisify(execFile);
const tenantId = () => state.tenantA.id;

function localProvider() {
  const endpoint = process.env.AXIOM_STORAGE_ENDPOINT;
  if (
    acceptanceTarget ||
    process.env.AXIOM_EVIDENCE_STORAGE_ACCEPTANCE !== 'true' ||
    !endpoint ||
    !process.env.AXIOM_EVIDENCE_FIXTURE_DIRECTORY ||
    new URL(endpoint).hostname !== '127.0.0.1' ||
    new URL(state.supabaseUrl).hostname !== '127.0.0.1'
  ) {
    throw new Error('Owned local Object Lock provider fixture required');
  }
}

async function providerAction(action: '--pause-provider' | '--resume-provider') {
  const directory = process.env.AXIOM_EVIDENCE_FIXTURE_DIRECTORY;
  if (!directory) throw new Error('Owned provider directory required');
  await execFileAsync(
    'python3',
    [`${repoRoot}/scripts/test-evidence-storage.py`, '--directory', directory, action],
    { cwd: repoRoot, timeout: 100_000 },
  );
}

async function database(path: string, body?: unknown) {
  const response = await fetch(`${state.supabaseUrl}/rest/v1/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      apikey: state.publishableKey,
      authorization: `Bearer ${state.serviceKey}`,
      'content-type': 'application/json',
      Prefer: 'return=representation',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok)
    throw new Error(
      `Approval fixture ${path}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`,
    );
  return response.json() as Promise<unknown>;
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = (await database(`rpc/${name}`, args)) as T & { error?: string; decision?: string };
  if (result.error) throw new Error(`${name}: ${result.error}`);
  return result;
}

test.describe('real-provider approval proof archive', () => {
  test.skip(
    process.env.AXIOM_EVIDENCE_STORAGE_ACCEPTANCE !== 'true',
    'Run with the retained local Object Lock provider.',
  );

  test('human-approved exact scope is reconciled, retained, released and owner-downloadable', async ({
    page,
    browser,
  }) => {
    test.setTimeout(300_000);
    localProvider();
    const plan = await createApprovablePlan('Approval archive provider');
    const dry = await rpc<{ dryRun: { id: string; status: string } }>('record_dry_run', {
      p_tenant_id: tenantId(),
      p_action_id: plan.actionId,
      p_status: 'succeeded',
      p_diff: { changes: [] },
      p_refusal_reason: null,
      p_simulated_by: 'samadhan',
      p_parameters: { columns: ['email'] },
      p_rollback_definition: { restore: 'persona-snapshot' },
      p_correlation_id: crypto.randomUUID(),
    });
    expect(dry.dryRun.status).toBe('succeeded');

    const approver = await createMfaAccount('archive-approver', {
      role: 'approver',
      withFactor: true,
    });
    await signInAs(page, approver.email, approver.password);
    await selectTenant(page, 'a');
    await page.goto(`/plans/${plan.id}`);
    await page.getByRole('button', { name: /^Approve \d+ action/ }).click();
    await expect(page.getByText('Confirm with your authenticator')).toBeVisible();
    await page.fill('#stepUpCode', generateTotp(approver.totpSecret!));
    await page.getByRole('button', { name: /Verify and approve/ }).click();
    await expect(page.getByText(/Signed approval token issued/)).toBeVisible();

    const tokens = (await database(
      `approval_tokens?tenant_id=eq.${tenantId()}&plan_id=eq.${plan.id}&select=id,nonce,signed_payload,signature`,
    )) as Array<{
      id: string;
      nonce: string;
      signed_payload: {
        contentDigest: string;
        mode: string;
        concurrency: number;
        stopOnFailure: boolean;
      };
      signature: string;
    }>;
    expect(tokens).toHaveLength(1);
    const token = tokens[0]!;
    expect(token.signature).toMatch(/^[0-9a-f]{64}$/);
    const requestKey = crypto.randomUUID();
    const claim = await rpc<{ decision: string; content_digest: string }>('claim_plan_execution', {
      p_tenant_id: tenantId(),
      p_plan_id: plan.id,
      p_token_id: token.id,
      p_action_ids: [plan.actionId],
      p_request_key: requestKey,
      p_correlation_id: crypto.randomUUID(),
      p_payload: {},
    });
    expect(claim.decision).toBe('claimed');
    expect(claim.content_digest).toBe(token.signed_payload.contentDigest);
    const started = await rpc<{ batch: { id: string } }>('start_claimed_execution_batch', {
      p_tenant_id: tenantId(),
      p_plan_id: plan.id,
      p_request_key: requestKey,
      p_correlation_id: crypto.randomUUID(),
      p_nonce: token.nonce,
      p_content_digest: claim.content_digest,
      p_mode: token.signed_payload.mode,
      p_concurrency: token.signed_payload.concurrency,
      p_stop_on_failure: token.signed_payload.stopOnFailure,
      p_dispatch_reference: 'archive-provider-e2e',
      p_action_ids: [plan.actionId],
    });
    const batchId = started.batch.id;
    expect(batchId).toMatch(/^[0-9a-f-]{36}$/);
    await rpc('mark_execution_action_started', {
      p_tenant_id: tenantId(),
      p_action_id: plan.actionId,
      p_batch_id: batchId,
      p_correlation_id: crypto.randomUUID(),
    });
    await rpc('settle_execution_action', {
      p_tenant_id: tenantId(),
      p_action_id: plan.actionId,
      p_batch_id: batchId,
      p_outcome: 'succeeded',
      p_error_code: null,
      p_pre_state_ref: 'fixture:before',
      p_post_state_ref: 'fixture:after',
      p_detail: { changed: true },
      p_correlation_id: crypto.randomUUID(),
    });
    await rpc('finish_execution_batch', {
      p_tenant_id: tenantId(),
      p_batch_id: batchId,
      p_status: 'completed',
      p_correlation_id: crypto.randomUUID(),
    });
    await rpc('record_verification_result', {
      p_tenant_id: tenantId(),
      p_action_id: plan.actionId,
      p_batch_id: batchId,
      p_checks: [{ check_id: 'archive-fixture', outcome: 'passed' }],
      p_outcome: 'passed',
      p_evidence_uri: null,
      p_correlation_id: crypto.randomUUID(),
    });
    const prepared = await rpc<{ statement: string }>('prepare_plan_reconciliation', {
      p_tenant_id: tenantId(),
      p_plan_id: plan.id,
      p_batch_id: batchId,
    });
    expect(JSON.parse(prepared.statement)).toMatchObject({
      token_id: token.id,
      approved_content_digest: claim.content_digest,
    });
    const signature = createHmac('sha256', signingKey).update(prepared.statement).digest('hex');
    const reconciled = await rpc<{ reconciliation: { id: string } }>('record_plan_reconciliation', {
      p_tenant_id: tenantId(),
      p_plan_id: plan.id,
      p_batch_id: batchId,
      p_correlation_id: crypto.randomUUID(),
      p_statement: prepared.statement,
      p_statement_signature: signature,
    });
    expect(reconciled.reconciliation.id).toMatch(/^[0-9a-f-]{36}$/);

    const founderContext = await browser.newContext();
    const ownerContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    try {
      const founder = await founderContext.newPage();
      const founderAccount = await createMfaAccount('archive-founder', {
        role: 'founder',
        isInternal: true,
        withFactor: true,
      });
      await signInAs(founder, founderAccount.email, founderAccount.password);
      await selectTenant(founder, 'a');
      await satisfyLoginMfaWithSecret(founder, founderAccount.totpSecret!);
      await founder.goto(`/plans/${plan.id}`);
      await founder.getByRole('button', { name: 'Archive proof' }).click();
      await expect(founder.getByText('Exact retained version verified.')).toBeVisible();
      const rows = (await database(
        `approval_proof_archives?tenant_id=eq.${tenantId()}&token_id=eq.${token.id}&select=id,status,source_sha256`,
      )) as Array<{
        id: string;
        status: string;
        source_sha256: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('settled');
      const status = await founder.request.get(`/api/bff/v1/approvals/${token.id}/archive`, {
        headers: { 'x-tenant-id': tenantId() },
      });
      expect(status.status()).toBe(200);
      const archive = (await status.json()) as {
        archiveId: string;
        status: string;
        sourceSha256: string;
        versionId: string;
      };
      expect(archive.archiveId).toBe(rows[0]!.id);
      expect(archive.versionId).toBeTruthy();
      await founder.getByRole('button', { name: 'Preview exact proof' }).click();
      await expect(founder.getByText('Exact retained source for founder review')).toBeVisible();
      await founder.getByRole('button', { name: 'Record founder review' }).click();
      await founder.getByRole('button', { name: 'Release reviewed proof' }).click();
      await expect(founder.getByText('Founder released the verified proof')).toBeVisible();

      const owner = await ownerContext.newPage();
      await signIn(owner, 'owner');
      await selectTenant(owner, 'a');
      await owner.goto(`/plans/${plan.id}`);
      await expect(owner.getByRole('link', { name: 'Download exact version' })).toBeVisible();
      const download = await owner.request.get(
        `/api/bff/v1/approval-archives/${archive.archiveId}/download`,
        { headers: { 'x-tenant-id': tenantId() } },
      );
      expect(download.status()).toBe(200);
      const bytes = await download.body();
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(archive.sourceSha256);
      expect(download.headers()['x-archive-version-id']).toBe(archive.versionId);
      const source = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
      expect(source).toMatchObject({ schema_version: 1, kind: 'approval_proof_source' });
      await providerAction('--pause-provider');
      try {
        const unavailable = await owner.request.get(
          `/api/bff/v1/approval-archives/${archive.archiveId}/download`,
          { headers: { 'x-tenant-id': tenantId() }, timeout: 45_000 },
        );
        expect(unavailable.status()).toBe(503);
      } finally {
        await providerAction('--resume-provider');
      }
      const exportResult = await owner.request.get(
        `/api/bff/v1/plans/${plan.id}/approval-export?format=json`,
        { headers: { 'x-tenant-id': tenantId() } },
      );
      expect(exportResult.status()).toBe(200);
      const history = (await exportResult.json()) as { approvals: Array<Record<string, unknown>> };
      expect(history.approvals[0]).toMatchObject({
        archived_proof: { archive_id: archive.archiveId, version_id: archive.versionId },
        reconciliation_statement: null,
      });

      const viewer = await viewerContext.newPage();
      await signIn(viewer, 'viewer');
      await selectTenant(viewer, 'a');
      const denied = await viewer.request.get(
        `/api/bff/v1/approval-archives/${archive.archiveId}/download`,
        { headers: { 'x-tenant-id': tenantId() } },
      );
      expect(denied.status()).toBe(403);
    } finally {
      await founderContext.close();
      await ownerContext.close();
      await viewerContext.close();
    }
  });
});
