import { test, expect } from '@playwright/test';
import { createMfaAccount, signInAs, state } from '../fixtures';
import { tenantCookie } from '../target';

test('assessment displays owned saved results, missing findings and zero exposure honestly', async ({
  page,
}) => {
  const account = await createMfaAccount('assessment-provenance', { role: 'admin' });
  const tenant = crypto.randomUUID();
  const engagement = crypto.randomUUID();
  const old = crypto.randomUUID();
  const proof = crypto.randomUUID();
  const staleProof = crypto.randomUUID();
  const slug = `assessment-${tenant.slice(0, 8)}`;
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
    const detail = response.ok ? null : ((await response.json()) as { code?: string });
    expect(response.status, `${table}: ${detail?.code ?? 'unexpected status'}`).toBe(201);
  }
  await seed('tenants', {
    id: tenant,
    slug,
    name: 'Assessment provenance',
    mfa_required_roles: [],
    is_sdf: false,
  });
  await seed('tenant_users', { tenant_id: tenant, user_id: account.id, role: 'admin' });
  await signInAs(page, account.email, account.password);
  await page.context().addCookies([tenantCookie(slug)]);
  await page.goto('/assessment');
  await expect(page.getByTestId('assessment-provenance')).toContainText('No saved assessment');
  await expect(page.getByTestId('assessment-summary')).toContainText('Not assessed');
  await expect(page.getByRole('button', { name: 'Run Parikshan', exact: true })).toBeDisabled();
  await expect(page.locator('[data-testid^="assessment-control-"]')).toHaveCount(0);

  const libraryVersion = `fixture-${tenant}`;
  const controls = Array.from({ length: 20 }, (_, i) => ({
    id: `FIXTURE-${String(i).padStart(2, '0')}`,
  }));
  await seed('control_libraries', {
    version: libraryVersion,
    published_at: new Date().toISOString(),
    published_by: 'browser-fixture',
    change_log: 'Synthetic provenance test only',
    control_count: controls.length,
    is_current: false,
  });
  await seed(
    'controls',
    controls.map(({ id }) => ({
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
  const zeroControl = controls[0]!.id;
  const missingControl = controls[1]!.id;
  await seed('engagements', [
    {
      id: old,
      tenant_id: tenant,
      library_version: libraryVersion,
      title: 'Older assessment fixture',
      status: 'completed',
      created_at: '2020-01-01T00:00:00Z',
      estimated_exposure_inr: 123,
    },
    {
      id: engagement,
      tenant_id: tenant,
      library_version: libraryVersion,
      title: 'Current assessment fixture',
      status: 'assessment',
      created_at: new Date().toISOString(),
      estimated_exposure_inr: 0,
    },
  ]);
  await seed('evidence', [
    {
      id: proof,
      tenant_id: tenant,
      engagement_id: engagement,
      content_hash: proof.replaceAll('-', '').repeat(2),
      storage_uri: 's3://fixture-only/current',
      evidence_type: 'document',
      collected_by_agent: 'saakshi',
    },
    {
      id: staleProof,
      tenant_id: tenant,
      engagement_id: old,
      content_hash: staleProof.replaceAll('-', '').repeat(2),
      storage_uri: 's3://fixture-only/stale',
      evidence_type: 'document',
      collected_by_agent: 'saakshi',
    },
  ]);
  await seed('findings', [
    {
      tenant_id: tenant,
      engagement_id: engagement,
      library_version: libraryVersion,
      control_id: zeroControl,
      score: 0,
      risk_points: 1,
      rationale: 'Saved zero fixture',
      evidence_ids: [proof, staleProof],
    },
    {
      tenant_id: tenant,
      engagement_id: old,
      library_version: libraryVersion,
      control_id: missingControl,
      score: 100,
      risk_points: 0,
      rationale: 'Old result must not fill a current gap',
      evidence_ids: [],
    },
  ]);
  await page.reload();
  await expect(page.getByTestId('assessment-provenance')).toContainText(
    'Current assessment fixture',
  );
  await expect(page.getByTestId('assessment-summary')).toContainText('₹0');
  await expect(page.locator('[data-testid^="assessment-control-"]')).toHaveCount(controls.length);
  const zero = page.getByTestId(`assessment-control-${zeroControl}`);
  await expect(zero).toContainText('Saved score: 0');
  await expect(zero).toContainText('FAIL');
  await expect(zero.getByRole('link', { name: '1 cited' })).toHaveAttribute(
    'href',
    `/evidence?q=${proof}`,
  );
  const missing = page.getByTestId(`assessment-control-${missingControl}`);
  await expect(missing).toContainText('UNASSESSED');
  await expect(missing).toContainText('No saved score');
  await expect(missing.locator('a[href^="/evidence"]')).toHaveCount(0);

  await page.goto(`/assessment?engagement=${old}`);
  await expect(page.getByTestId('assessment-provenance')).toContainText('Older assessment fixture');
  await expect(page.getByTestId(`assessment-control-${missingControl}`)).toContainText(
    'Saved score: 100',
  );
  await expect(page.getByTestId(`assessment-control-${zeroControl}`)).toContainText('UNASSESSED');
  await page.goto(`/assessment?engagement=${state.engagementB}`);
  await expect(page.getByTestId('assessment-provenance')).toContainText(
    'Saved assessment results are unavailable',
  );
  await expect(page.getByTestId('assessment-summary')).toContainText('Control posture unavailable');
  await expect(page.locator('[data-testid^="assessment-control-"]')).toHaveCount(0);
});
