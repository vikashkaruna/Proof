import { expect, test } from '@playwright/test';
import { createMfaAccount, selectTenant, signIn, signInAs, state } from '../fixtures';
import { tenantCookie } from '../target';
import { acceptanceTarget } from '../target';
import { LIBRARY_VERSION } from '../../../packages/control-library/src';

test('an assessment creator can start an intake and open its saved assessment', async ({
  page,
}) => {
  const account = await createMfaAccount('assessment-create', { role: 'admin', withFactor: true });
  const tenantId = crypto.randomUUID();
  const slug = `create-assessment-${tenantId.slice(0, 8)}`;
  const headers = {
    apikey: state.publishableKey,
    Authorization: `Bearer ${state.serviceKey}`,
    'Content-Type': 'application/json',
  };
  // The local parity seed publishes the library for report tests but does not
  // choose a current version. This creation journey needs that operator
  // prerequisite; never change a deployed acceptance target here.
  if (!acceptanceTarget) {
    const current = await fetch(
      `${state.supabaseUrl}/rest/v1/control_libraries?is_current=eq.true&select=version`,
      { headers },
    );
    expect(current.status).toBe(200);
    if (((await current.json()) as unknown[]).length === 0) {
      const published = await fetch(
        `${state.supabaseUrl}/rest/v1/control_libraries?version=eq.${encodeURIComponent(LIBRARY_VERSION)}`,
        { method: 'PATCH', headers, body: JSON.stringify({ is_current: true }) },
      );
      expect(published.status).toBe(204);
    }
  }
  const tenant = await fetch(`${state.supabaseUrl}/rest/v1/tenants`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      id: tenantId,
      slug,
      name: 'Assessment creation fixture',
      mfa_required_roles: [],
    }),
  });
  expect(tenant.status).toBe(201);
  const membership = await fetch(`${state.supabaseUrl}/rest/v1/tenant_users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ tenant_id: tenantId, user_id: account.id, role: 'admin' }),
  });
  expect(membership.status).toBe(201);

  await signInAs(page, account.email, account.password, account.totpSecret!);
  await page.context().addCookies([tenantCookie(slug)]);
  await page.addInitScript(() => {
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: undefined,
    });
  });
  await page.goto('/assessment');
  await expect(page.getByTestId('assessment-provenance')).toContainText('No saved assessment');
  await page.getByRole('link', { name: 'Create an assessment' }).click();
  await expect(page).toHaveURL(/\/engagements$/);
  expect(await page.evaluate(() => typeof globalThis.crypto.randomUUID)).toBe('undefined');
  await expect(page.getByRole('form', { name: 'Create assessment' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Assessment title' }).fill('October source review');
  const createRequest = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/api/bff/v1/engagements'),
  );
  await page.getByRole('button', { name: 'Create assessment' }).click();
  const posted = (await createRequest).postDataJSON() as Record<string, unknown>;
  expect(posted.requestKey).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect((await createRequest).headers()['idempotency-key']).toBe(posted.requestKey);
  // In dev, a late post-login refresh can replace the client success state.
  // The saved engagement must still offer an assessment link in its table row.
  const savedAssessment = page.locator(`a[href="/assessment?engagement=${posted.requestKey}"]`);
  await expect(savedAssessment.first()).toBeVisible();
  await savedAssessment.first().click();
  await expect(page).toHaveURL(/\/assessment\?engagement=[0-9a-f-]+$/);
  await expect(page.getByTestId('assessment-provenance')).toContainText('October source review');
  await expect(
    page.getByRole('button', { name: 'Request unknown-answer assessment' }),
  ).toBeDisabled();
  await page.getByRole('checkbox', { name: /every answer and applicability flag/ }).check();
  await expect(
    page.getByRole('button', { name: 'Request unknown-answer assessment' }),
  ).toBeEnabled();
  const createdId = new URL(page.url()).searchParams.get('engagement');
  expect(createdId).toBe(posted.requestKey);
  const replay = await page.request.post('/api/bff/v1/engagements', {
    data: posted,
    headers: {
      'X-Tenant-Id': tenantId,
      'Idempotency-Key': `assessment-replay-${crypto.randomUUID()}`,
    },
  });
  expect(replay.status()).toBe(200);
  expect(((await replay.json()) as { id: string }).id).toBe(createdId);
  const changed = await page.request.post('/api/bff/v1/engagements', {
    data: { ...posted, title: 'Changed request under the same key' },
    headers: {
      'X-Tenant-Id': tenantId,
      'Idempotency-Key': `assessment-conflict-${crypto.randomUUID()}`,
    },
  });
  expect(changed.status()).toBe(409);
});

test('a viewer is not offered agent modules and is refused at their URLs', async ({ page }) => {
  await signIn(page, 'viewer');
  await selectTenant(page, 'a');
  for (const route of ['/discovery', '/classification', '/assessment']) {
    await page.goto(route);
    await expect(page).toHaveURL(/\/portal\?error=forbidden/);
  }
});

test('a reviewer can read agent modules without being offered a run action', async ({ page }) => {
  await signIn(page, 'reviewer');
  await selectTenant(page, 'a');
  for (const route of ['/discovery', '/classification']) {
    await page.goto(route);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expect(
      page.getByRole('button', { name: /^Run (Discovery|Classification) Scan$/ }),
    ).toHaveCount(0);
  }
  await page.goto('/assessment');
  await expect(page.getByRole('heading', { name: 'Assessment', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Request unknown-answer assessment' })).toHaveCount(
    0,
  );
});
