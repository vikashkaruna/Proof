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
