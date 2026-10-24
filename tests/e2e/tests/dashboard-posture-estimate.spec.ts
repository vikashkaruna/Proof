import { test, expect } from '@playwright/test';
import { createMfaAccount, signInAs, state } from '../fixtures';
import { insertOwnedEngagementFixtures } from '../local-db';

test('dashboard shows a saved unverified estimate through a newer intake and reload', async ({
  page,
}) => {
  const actor = await createMfaAccount('dashboard-estimate', { role: 'viewer', withFactor: true });
  const tenant = crypto.randomUUID();
  const slug = `dashboard-${tenant.slice(0, 8)}`;
  const headers = {
    apikey: state.publishableKey,
    Authorization: `Bearer ${state.serviceKey}`,
    'Content-Type': 'application/json',
  };
  for (const [table, row] of [
    ['tenants', { id: tenant, slug, name: 'Dashboard estimate fixture', is_sdf: false }],
    ['tenant_users', { tenant_id: tenant, user_id: actor.id, role: 'viewer' }],
  ] as const) {
    const response = await fetch(`${state.supabaseUrl}/rest/v1/${table}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(row),
    });
    expect(response.status, table).toBe(201);
  }
  await signInAs(page, actor.email, actor.password, actor.totpSecret!);
  await page.context().addCookies([
    {
      name: 'axiom_active_tenant',
      value: slug,
      url: `${new URL(page.url()).origin}/`,
      sameSite: 'Lax',
    },
  ]);
  await page.goto('/dashboard');
  await expect(page.getByTestId('posture-score')).toHaveText('Unavailable');
  await expect(page.getByTestId('posture-provenance')).toHaveCount(0);

  const intake = crypto.randomUUID();
  for (const row of [
    {
      id: crypto.randomUUID(),
      tenant_id: tenant,
      library_version: state.libraryVersion,
      title: 'Recorded estimate fixture',
      status: 'completed',
      posture_score: 30.87,
    },
    {
      id: intake,
      tenant_id: tenant,
      library_version: state.libraryVersion,
      title: 'New intake fixture',
      status: 'intake',
    },
  ]) {
    insertOwnedEngagementFixtures([row], state.supabaseUrl, state.serviceKey);
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.reload();
    await expect(page.getByTestId('posture-value')).toHaveText('30.87');
    await expect(page.getByTestId('posture-provenance')).toHaveText('Unverified');
    await expect(page.getByText('Not a compliance certification.', { exact: false })).toBeVisible();
    await expect(page.getByTestId('posture-band')).toHaveCount(0);
    // Viewers can read posture but do not receive engagement navigation.
    await expect(page.getByRole('link', { name: 'Open assessment', exact: true })).toHaveCount(0);
  }
});

test('WEB-06-B: owner-to-viewer organization switch scopes posture/navigation and rejects unrelated source', async ({
  page,
}) => {
  const actor = await createMfaAccount('dashboard-role-boundary', {
    role: 'owner',
    withFactor: true,
  });
  const headers = {
    apikey: state.publishableKey,
    Authorization: `Bearer ${state.serviceKey}`,
    'Content-Type': 'application/json',
  };
  const groups = [
    {
      id: crypto.randomUUID(),
      slug: 'dash-a-' + crypto.randomUUID().slice(0, 8),
      name: 'Dashboard boundary owner',
      role: 'owner',
      score: 71,
    },
    {
      id: crypto.randomUUID(),
      slug: 'dash-b-' + crypto.randomUUID().slice(0, 8),
      name: 'Dashboard boundary viewer',
      role: 'viewer',
      score: 22,
    },
    {
      id: crypto.randomUUID(),
      slug: 'dash-c-' + crypto.randomUUID().slice(0, 8),
      name: 'Dashboard unrelated',
      role: null,
      score: 94,
    },
  ];
  for (const group of groups) {
    const tenant = await fetch(`${state.supabaseUrl}/rest/v1/tenants`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: group.id, slug: group.slug, name: group.name, is_sdf: false }),
    });
    expect(tenant.status).toBe(201);
    if (group.role) {
      const member = await fetch(`${state.supabaseUrl}/rest/v1/tenant_users`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ tenant_id: group.id, user_id: actor.id, role: group.role }),
      });
      expect(member.status).toBe(201);
    }
    insertOwnedEngagementFixtures(
      [
        {
          id: crypto.randomUUID(),
          tenant_id: group.id,
          library_version: state.libraryVersion,
          title: group.name + ' assessment',
          status: 'completed',
          posture_score: group.score,
        },
      ],
      state.supabaseUrl,
      state.serviceKey,
    );
  }
  await signInAs(page, actor.email, actor.password, actor.totpSecret!);
  const origin = new URL(page.url()).origin;
  await page
    .context()
    .addCookies([
      { name: 'axiom_active_tenant', value: groups[0]!.slug, url: origin + '/', sameSite: 'Lax' },
    ]);
  await page.goto('/dashboard');
  await expect(page.getByTestId('posture-value')).toHaveText('71');
  await expect(page.getByRole('link', { name: /^1\. Set up the estate/ })).toBeVisible();
  await page.getByRole('button', { name: 'Switch organization', exact: true }).click();
  await page.getByRole('button', { name: /Dashboard boundary viewer/ }).click();
  await expect(page.getByTestId('posture-value')).toHaveText('22');
  await expect(page.getByRole('link', { name: /^1\. Set up the estate/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open assessment', exact: true })).toHaveCount(0);
  await expect(page.getByText('Dashboard boundary owner assessment', { exact: true })).toHaveCount(
    0,
  );
  await page.reload();
  await expect(page.getByTestId('posture-value')).toHaveText('22');
  await page
    .context()
    .addCookies([
      { name: 'axiom_active_tenant', value: groups[2]!.slug, url: origin + '/', sameSite: 'Lax' },
    ]);
  await page.goto('/dashboard');
  await expect(page.getByTestId('posture-value')).not.toHaveText('94');
  await expect(page.getByText('Dashboard unrelated', { exact: true })).toHaveCount(0);
  await Promise.all([
    page.waitForURL((url: URL) => url.pathname === '/'),
    page.getByRole('button', { name: 'Sign out', exact: true }).click(),
  ]);
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
  await expect(page.getByTestId('posture-value')).toHaveCount(0);
});
