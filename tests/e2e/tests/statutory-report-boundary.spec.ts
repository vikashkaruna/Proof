import { test, expect } from '@playwright/test';
import { selectTenant, signIn, state } from '../fixtures';

test('caller-authored statutory claims cannot become agent reports', async ({ page }) => {
  await signIn(page, 'owner');
  await selectTenant(page, 'a');

  const response = await page.request.post('/api/bff/v1/reports/statutory/generate', {
    headers: { 'x-tenant-id': state.tenantA.id },
    data: {
      kind: 'auditor',
      engagementId: crypto.randomUUID(),
      title: 'Unverified auditor claim',
      content: { attestation: 'Evidence independently verified' },
    },
  });

  expect(response.status()).toBe(409);
  expect(await response.json()).toEqual({ error: { code: 'source_bound_workflow_required' } });
});
