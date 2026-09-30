import { createHash } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import {
  createMfaAccount,
  selectTenant,
  signIn,
  signInAs,
  satisfyLoginMfaWithSecret,
  state,
} from '../fixtures';

async function fixtureWrite(path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown) {
  return fetch(`${state.supabaseUrl}/rest/v1/${path}`, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      apikey: state.publishableKey,
      authorization: `Bearer ${state.serviceKey}`,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function draft(actorId: string) {
  const title = `Structured report ${crypto.randomUUID()}`;
  const content = JSON.stringify({
    schema_version: 1,
    kind: 'synthetic_acceptance',
    statement: 'Synthetic browser fixture, not a compliance certification.',
    untrusted_display_text: '<img src=x onerror=alert(1)>',
    sources: [],
  });
  const response = await fixtureWrite('rpc/record_report_draft', 'POST', {
    p_tenant_id: state.tenantA.id,
    p_actor_id: actorId,
    p_operation_key: crypto.randomUUID(),
    p_kind: 'custom',
    p_title: title,
    p_engagement_id: state.engagementA,
    p_library_version: null,
    p_content_text: content,
    p_generated_by_agent: 'synthetic-browser-fixture',
    p_correlation_id: crypto.randomUUID(),
  });
  expect(response.status).toBe(200);
  const result = (await response.json()) as {
    reportId: string;
    contentHash: string;
    status: string;
  };
  expect(result.status).toBe('draft');
  expect(result.contentHash).toBe(createHash('sha256').update(content).digest('hex'));
  return { ...result, title, content };
}
async function open(page: Page, title: string) {
  await page.goto('/reports');
  await page
    .getByRole('region', { name: 'Recorded reports' })
    .getByRole('button', { name: new RegExp(title) })
    .click();
  const detail = page.getByRole('region', { name: 'Report detail' });
  await expect(detail.getByRole('heading', { name: title, exact: true })).toBeVisible();
  return detail;
}
async function post(page: Page, path: string, body: unknown, key = crypto.randomUUID()) {
  return page.request.post(`/api/bff/v1${path}`, {
    headers: { 'x-tenant-id': state.tenantA.id, 'idempotency-key': key },
    data: body,
  });
}

test('real structured report review and release preserves exact content and honest artifact assurance', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const manager = await createMfaAccount('report-manager', { role: 'admin' });
  const founder = await createMfaAccount('report-founder', {
    role: 'founder',
    isInternal: true,
    withFactor: true,
  });
  const report = await draft(manager.id);
  await signInAs(page, manager.email, manager.password);
  await selectTenant(page, 'a');
  const ownDetail = await open(page, report.title);
  await ownDetail.getByText('Exact recorded content', { exact: true }).click();
  await expect(ownDetail.locator('pre')).toContainText('<img src=x onerror=alert(1)>');
  await expect(ownDetail.locator('img')).toHaveCount(0);
  await expect(ownDetail.getByRole('button', { name: 'Approve reviewed content' })).toHaveCount(0);
  await expect(ownDetail.getByRole('button', { name: /Email/ })).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'Recorded reports' }).getByRole('button', { name: /Email/ }),
  ).toHaveCount(0);
  const reviewerContext = await browser.newContext();
  const viewerContext = await browser.newContext();
  try {
    const viewer = await viewerContext.newPage();
    await signIn(viewer, 'viewer');
    await selectTenant(viewer, 'a');
    expect((await viewer.request.get(`/api/bff/v1/reports/${report.reportId}`)).status()).toBe(404);
    const reviewer = await reviewerContext.newPage();
    await signInAs(reviewer, founder.email, founder.password);
    await selectTenant(reviewer, 'a');
    await satisfyLoginMfaWithSecret(reviewer, founder.totpSecret!);
    const detail = await open(reviewer, report.title);
    await expect(detail).toContainText(`Content SHA-256: ${report.contentHash}`);
    await expect(detail.getByRole('button', { name: /Email/ })).toHaveCount(0);
    await detail
      .getByRole('checkbox', { name: 'I reviewed the exact content and SHA-256 shown above.' })
      .check();
    await detail.getByRole('button', { name: 'Approve reviewed content' }).click();
    await expect(detail.getByText(/approved by/)).toBeVisible();
    await detail
      .getByRole('checkbox', {
        name: 'I reviewed this content and its recorded artifact hash and authorize release to this tenant.',
      })
      .check();
    await detail.getByRole('button', { name: 'Release reviewed report' }).click();
    await expect(detail).toContainText('Structured report release only.');
    await expect(detail).toContainText('does not establish a retained PDF or ZIP');
    await expect(detail.getByRole('button', { name: 'Download released pack' })).toHaveCount(0);
    await expect(detail.getByRole('button', { name: /Email/ })).toHaveCount(0);
    const content = await page.request.get(`/api/bff/v1/reports/${report.reportId}/content`);
    expect(content.status()).toBe(200);
    expect(content.headers()['content-type']).toContain('application/json');
    expect(await content.text()).toBe(report.content);
    expect(content.headers()['x-evidence-sha256']).toBe(report.contentHash);
    const visible = await open(viewer, report.title);
    await expect(visible).toContainText('Structured report release only.');
    await expect(visible.getByRole('button', { name: 'Release reviewed report' })).toHaveCount(0);
    expect(
      (await viewer.request.get(`/api/bff/v1/reports/${report.reportId}/content`)).status(),
    ).toBe(403);
  } finally {
    await reviewerContext.close();
    await viewerContext.close();
  }
});

test('report authority revocation removes private reads and refuses cached review success', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const manager = await createMfaAccount('report-revoked-manager', { role: 'admin' });
  const founder = await createMfaAccount('report-revoked-founder', {
    role: 'founder',
    isInternal: true,
    withFactor: true,
  });
  const outsider = await createMfaAccount('report-internal-outsider', {
    role: 'founder',
    isInternal: true,
    withFactor: true,
  });
  // Only isolated journey memberships/profile flags are changed, as in the
  // existing tenant-bridge fixture. Report lifecycle writes remain RPC-only.
  expect(
    (
      await fixtureWrite(
        `tenant_users?tenant_id=eq.${state.tenantA.id}&user_id=eq.${outsider.id}`,
        'DELETE',
      )
    ).status,
  ).toBe(204);
  expect(
    (
      await fixtureWrite('tenant_users', 'POST', {
        tenant_id: state.tenantB.id,
        user_id: outsider.id,
        role: 'founder',
        approval_scopes: [],
      })
    ).status,
  ).toBe(201);
  const report = await draft(manager.id);
  const otherDraft = await draft(manager.id);
  await signInAs(page, manager.email, manager.password);
  await selectTenant(page, 'a');
  const managerDetail = await open(page, otherDraft.title);
  const reviewerContext = await browser.newContext();
  const outsiderContext = await browser.newContext();
  try {
    const foreign = await outsiderContext.newPage();
    await signInAs(foreign, outsider.email, outsider.password);
    await selectTenant(foreign, 'b');
    await satisfyLoginMfaWithSecret(foreign, outsider.totpSecret!);
    expect(
      (
        await foreign.request.get(`/api/bff/v1/reports/${report.reportId}`, {
          headers: { 'x-tenant-id': state.tenantA.id },
        })
      ).status(),
    ).toBe(403);
    const reviewer = await reviewerContext.newPage();
    await signInAs(reviewer, founder.email, founder.password);
    await selectTenant(reviewer, 'a');
    await satisfyLoginMfaWithSecret(reviewer, founder.totpSecret!);
    const path = `/reports/${report.reportId}/review`;
    const body = { decision: 'approved', expectedContentHash: report.contentHash };
    const key = crypto.randomUUID();
    expect((await post(foreign, path, body)).status()).toBe(403);
    expect((await post(reviewer, path, body, key)).status()).toBe(200);
    const detail = await open(reviewer, report.title);
    expect(
      (await fixtureWrite(`users?id=eq.${founder.id}`, 'PATCH', { is_axiom_internal: false }))
        .status,
    ).toBe(204);
    expect((await post(reviewer, path, body, key)).status()).toBe(403);
    await detail.getByRole('button', { name: 'Refresh report detail' }).click();
    await expect(detail.getByRole('alert')).toBeVisible();
    await expect(detail.getByRole('heading', { name: report.title, exact: true })).toHaveCount(0);
    expect(
      (
        await fixtureWrite(
          `tenant_users?tenant_id=eq.${state.tenantA.id}&user_id=eq.${manager.id}`,
          'PATCH',
          { role: 'viewer' },
        )
      ).status,
    ).toBe(204);
    await managerDetail.getByRole('button', { name: 'Refresh report detail' }).click();
    await expect(managerDetail.getByRole('alert')).toBeVisible();
    await expect(
      managerDetail.getByRole('heading', { name: otherDraft.title, exact: true }),
    ).toHaveCount(0);
    expect((await page.request.get(`/api/bff/v1/reports/${otherDraft.reportId}`)).status()).toBe(
      404,
    );
  } finally {
    await reviewerContext.close();
    await outsiderContext.close();
  }
});
