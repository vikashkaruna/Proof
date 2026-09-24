import { test, expect } from '@playwright/test';
import { createMfaAccount, signInAs, state } from '../fixtures';
import { tenantCookie } from '../target';

// C-W0-7: the client portal shows only persisted figures for the verified tenant.
test('portal shows recorded posture only and never substitutes demo figures', async ({ page }) => {
  const account = await createMfaAccount('portal-provenance', { role: 'admin' });
  const tenant = crypto.randomUUID();
  const engagement = crypto.randomUUID();
  const slug = `portal-${tenant.slice(0, 8)}`;
  const headers = {
    apikey: state.publishableKey,
    Authorization: `Bearer ${state.serviceKey}`,
    'Content-Type': 'application/json',
  };
  async function seed(table: string, body: unknown) {
    const response = await fetch(`${state.supabaseUrl}/rest/v1/${table}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    expect(response.status, table).toBe(201);
  }
  await seed('tenants', {
    id: tenant,
    slug,
    name: 'Portal provenance',
    mfa_required_roles: [],
    is_sdf: false,
  });
  await seed('tenant_users', { tenant_id: tenant, user_id: account.id, role: 'admin' });
  await signInAs(page, account.email, account.password);
  await page.context().addCookies([tenantCookie(slug)]);

  await page.goto('/portal');
  await expect(page.getByText('Portal provenance').first()).toBeVisible();
  await expect(page.getByTestId('portal-posture')).toHaveText('—');
  await expect(page.getByTestId('portal-controls-passing')).toHaveText('—');
  await expect(page.getByTestId('portal-no-engagement')).toContainText('No assessment engagement');
  for (const invented of ['Demo Client', '+6 vs baseline', 'WORM lock active', '43 codified'])
    await expect(page.getByText(invented)).toHaveCount(0);

  const libraryVersion = `portal-fixture-${tenant}`;
  const controls = ['PORTAL-00', 'PORTAL-01', 'PORTAL-02'];
  await seed('control_libraries', {
    version: libraryVersion,
    published_at: new Date().toISOString(),
    published_by: 'browser-fixture',
    change_log: 'Synthetic portal provenance test only',
    control_count: controls.length,
    is_current: false,
  });
  await seed(
    'controls',
    controls.map((id) => ({
      id,
      library_version: libraryVersion,
      title: `${id} synthetic requirement`,
      obligation: 'Fixture only',
      domain: 'SEC',
      severity: 'low',
      citations: [{ instrument: 'Fixture', reference: 'Not a legal citation' }],
      evidence_required: [],
      assessment_questions: [],
      scoring: {},
      remediation_patterns: [],
      introduced_in_version: libraryVersion,
    })),
  );
  await seed('engagements', {
    id: engagement,
    tenant_id: tenant,
    library_version: libraryVersion,
    title: 'Portal assessment fixture',
    status: 'assessment',
    posture_score: 42,
  });
  await seed('findings', {
    tenant_id: tenant,
    engagement_id: engagement,
    library_version: libraryVersion,
    control_id: controls[0],
    score: 90,
    risk_points: 0,
    rationale: 'Saved pass-band fixture',
    evidence_ids: [],
  });
  await page.reload();
  await expect(page.getByText('Portal assessment fixture')).toBeVisible();
  await expect(page.getByTestId('portal-posture')).toHaveText('42');
  await expect(page.getByTestId('portal-controls-passing')).toHaveText('1');
  await expect(page.getByText('1 of 3 assessed')).toBeVisible();
  await expect(page.getByText('Not recorded')).toBeVisible();
});
