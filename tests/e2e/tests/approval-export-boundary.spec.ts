import { createHash } from 'node:crypto';
import { test, expect } from '@playwright/test';
import {
  createApprovablePlan,
  createMfaAccount,
  freshTotpCode,
  selectTenant,
  signIn,
  signInAs,
  state,
  signInFreshOwner,
} from '../fixtures';

test('a signed approval exports a bounded truthful plan snapshot to an authorized owner', async ({
  page,
  browser,
}) => {
  const plan = await createApprovablePlan('Export verified token');
  const approver = await createMfaAccount('approval-export', {
    role: 'approver',
    withFactor: true,
  });
  await signInAs(page, approver.email, approver.password, approver.totpSecret!);
  await selectTenant(page, 'a');
  await page.goto(`/plans/${plan.id}`);
  await page.getByRole('button', { name: /^Approve \d+ action/ }).click();
  await expect(page.getByText('Confirm with your authenticator')).toBeVisible();
  await page.fill('#stepUpCode', await freshTotpCode(page, approver.totpSecret!));
  await page.getByRole('button', { name: /Verify and approve/ }).click();
  await expect(page.getByText(/Signed approval token issued/)).toBeVisible();

  const ownerContext = await browser.newContext();
  const viewerContext = await browser.newContext();
  try {
    const owner = await ownerContext.newPage();
    await signInFreshOwner(owner, 'approval-export-boundary.spec-1');
    await selectTenant(owner, 'a');
    const response = await owner.request.get(
      `/api/bff/v1/plans/${plan.id}/approval-export?format=json`,
      { headers: { 'x-tenant-id': state.tenantA.id } },
    );
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toBe('private, no-store');
    const bytes = await response.body();
    expect(response.headers()['x-export-sha256']).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
    const document = JSON.parse(bytes.toString('utf8')) as {
      summary: { total_records: number; standing_policy_approvals: number | null };
      approvals: Array<Record<string, unknown>>;
    };
    expect(document.summary.total_records).toBe(1);
    expect(document.summary.standing_policy_approvals).toBeNull();
    expect(document.approvals[0]).toMatchObject({
      plan_id: plan.id,
      action_count: 1,
      approver_role: null,
      approval_scopes: null,
      reconciliation_statement: null,
    });
    expect(JSON.stringify(document)).not.toContain('Designated DPO');

    const viewer = await viewerContext.newPage();
    await signIn(viewer, 'viewer');
    await selectTenant(viewer, 'a');
    const refused = await viewer.request.get(
      `/api/bff/v1/plans/${plan.id}/approval-export?format=json`,
      { headers: { 'x-tenant-id': state.tenantA.id } },
    );
    expect(refused.status()).toBe(403);
  } finally {
    await ownerContext.close();
    await viewerContext.close();
  }
});
