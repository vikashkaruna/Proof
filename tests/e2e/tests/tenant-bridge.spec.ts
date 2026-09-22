import { test, expect } from '@playwright/test';
import { createMfaAccount, signInAs, state } from '../fixtures';
import { tenantCookie } from '../target';

test('custom tenant selection routes real reads and writes and refuses stale membership', async ({
  page,
}) => {
  const account = await createMfaAccount('tenant-bridge', { role: 'admin' });
  const tenant = crypto.randomUUID();
  const slug = `bridge-${tenant.slice(0, 8)}`;
  const estateName = `Custom estate ${tenant.slice(0, 8)}`;
  const seedHeaders = {
    apikey: state.publishableKey,
    Authorization: `Bearer ${state.serviceKey}`,
    'Content-Type': 'application/json',
  };
  for (const [table, body] of [
    ['tenants', { id: tenant, slug, name: 'Bridge tenant', mfa_required_roles: [] }],
    ['tenant_users', { tenant_id: tenant, user_id: account.id, role: 'admin' }],
  ] as const) {
    const response = await fetch(`${state.supabaseUrl}/rest/v1/${table}`, {
      method: 'POST',
      headers: seedHeaders,
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(201);
  }
  await signInAs(page, account.email, account.password);
  await page.context().addCookies([tenantCookie(slug)]);
  const created = await page.request.post('/api/bff/v1/estates', {
    data: { name: estateName, slug: 'custom-estate' },
  });
  expect(created.status()).toBe(201);
  const { data: estate } = await created.json();
  expect(estate.tenant_id).toBe(tenant);

  for (const selection of [slug, tenant]) {
    await page.context().addCookies([tenantCookie(selection)]);
    const response = await page.request.get('/api/bff/v1/estates');
    expect(response.status()).toBe(200);
    const { data } = await response.json();
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe(estate.id);
    expect(data[0].tenant_id).toBe(tenant);
    await page.goto('/estate');
    await expect(page.getByRole('heading', { name: estateName, exact: true })).toBeVisible();
  }

  await page.context().addCookies([tenantCookie('unknown-tenant')]);
  const refused = await page.request.post('/api/bff/v1/estates', {
    data: { name: 'Must not be created', slug: 'refused-estate' },
  });
  expect(refused.status()).toBe(403);
  expect((await refused.json()).error.code).toBe('tenant_selection_required');
  // Explicit selection is still checked by the real BFF, not trusted by the bridge.
  const foreign = await page.request.get('/api/bff/v1/estates', {
    headers: { 'X-Tenant-Id': state.tenantB.id },
  });
  expect(foreign.status()).toBe(403);
  const other = await page.request.get('/api/bff/v1/estates', {
    headers: { 'X-Tenant-Id': state.tenantA.id },
  });
  expect(other.status()).toBe(200);
  expect(
    (await other.json()).data.some(
      (row: { name: string }) => row.name === 'Must not be created' || row.name === estateName,
    ),
  ).toBe(false);

  const revoked = await fetch(
    `${state.supabaseUrl}/rest/v1/tenant_users?tenant_id=eq.${tenant}&user_id=eq.${account.id}`,
    {
      method: 'DELETE',
      headers: seedHeaders,
    },
  );
  expect(revoked.status).toBe(204);
  await page.context().addCookies([tenantCookie(slug)]);
  const afterRevocation = await page.request.get('/api/bff/v1/estates');
  expect(afterRevocation.status()).toBe(403);
  expect((await afterRevocation.json()).error.code).toBe('tenant_selection_required');
});
