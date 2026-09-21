import { test, expect } from '@playwright/test';
import { generateTotp } from '@axiom/mfa';
import { createMfaAccount, signInAs, state } from '../fixtures';
test('staff proposal requires client admin review before systems enter the estate', async ({
  browser,
}) => {
  const analyst = await createMfaAccount('proposal-staff', {
    role: 'axiom_analyst',
    withFactor: true,
  });
  const admin = await createMfaAccount('proposal-admin', { role: 'admin' });
  const tenant = crypto.randomUUID();
  const estate = crypto.randomUUID();
  const slug = `proposal-${tenant.slice(0, 8)}`;
  async function seed(path: string, body: unknown) {
    const res = await fetch(`${state.supabaseUrl}/rest/v1/${path}`, {
      method: 'POST',
      headers: {
        apikey: state.publishableKey,
        Authorization: `Bearer ${state.serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
  }
  await seed('tenants', { id: tenant, slug, name: 'Proposal journey', mfa_required_roles: [] });
  await seed('tenant_users', [
    { tenant_id: tenant, user_id: analyst.id, role: 'axiom_analyst' },
    { tenant_id: tenant, user_id: admin.id, role: 'admin' },
  ]);
  await seed('estates', { id: estate, tenant_id: tenant, slug: 'india', name: 'India production' });
  await seed('tenant_onboarding_intakes', {
    tenant_id: tenant,
    submitted_by: admin.id,
    proposed_systems: [
      {
        name: 'Original CRM',
        type: 'SaaS platform',
        description: 'Client submitted',
        data_categories: ['Contact Details'],
        region: 'ap-south-1',
        hosts_personal_data: true,
      },
    ],
  });
  const staffContext = await browser.newContext();
  const staff = await staffContext.newPage();
  const clientContext = await browser.newContext();
  const client = await clientContext.newPage();
  try {
    await signInAs(staff, analyst.email, analyst.password);
    await staffContext.addCookies([
      { name: 'axiom_active_tenant', value: slug, domain: 'localhost', path: '/' },
    ]);
    await staff.goto('/verify');
    await staff.fill('#code', generateTotp(analyst.totpSecret!));
    await staff.getByRole('button', { name: 'Verify', exact: true }).click();
    await staff.waitForURL((url) => !url.pathname.startsWith('/verify'));
    await staff.goto('/estate/onboarding');
    await staff.getByLabel('Destination estate').selectOption(estate);
    await staff.getByLabel('Proposed system kind').selectOption('saas');
    await staff.getByLabel('Proposed system name').fill('Reviewed CRM');
    await staff.getByLabel('Proposed categories').fill('contact-details');
    await staff.getByRole('checkbox').check();
    await staff.getByRole('button', { name: 'Submit proposal for review' }).click();
    await expect(staff.getByRole('heading', { name: 'India production — pending' })).toBeVisible();
    await expect(staff.getByRole('button', { name: 'Record review' })).toHaveCount(0);
    await staff.goto('/estate');
    await expect(staff.getByText('Reviewed CRM', { exact: true })).toHaveCount(0);
    await signInAs(client, admin.email, admin.password);
    await clientContext.addCookies([
      { name: 'axiom_active_tenant', value: slug, domain: 'localhost', path: '/' },
    ]);
    await client.goto('/estate/onboarding');
    await expect(client.getByText('Original CRM', { exact: false })).toBeVisible();
    await client.getByLabel('Review decision').selectOption('approved');
    await client
      .getByLabel('Review reason')
      .fill('Confirmed CRM and its categories with the client');
    await client.getByRole('checkbox').check();
    await client.getByRole('button', { name: 'Record review' }).click();
    await expect(
      client.getByRole('heading', { name: 'India production — approved' }),
    ).toBeVisible();
    await expect(client.getByText('1 systems added.', { exact: false })).toBeVisible();
    await client.goto('/estate');
    await expect(client.getByText('Reviewed CRM', { exact: true })).toBeVisible();
    await expect(client.getByText('Declared: contact-details')).toBeVisible();
  } finally {
    await staffContext.close();
    await clientContext.close();
  }
});
