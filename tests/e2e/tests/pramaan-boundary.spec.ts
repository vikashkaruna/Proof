import { test, expect } from '@playwright/test';
import {
  createMfaAccount,
  selectTenant,
  signIn,
  signInAs,
  satisfyLoginMfaWithSecret,
  state,
} from '../fixtures';

test('source-free dossier and outbound dispatch refuse after real sign-in', async ({ page }) => {
  await signIn(page, 'owner');
  await selectTenant(page, 'a');
  const headers = { 'x-tenant-id': state.tenantA.id };

  const synthesize = await page.request.post(
    `/api/bff/v1/engagements/${crypto.randomUUID()}/closure/pramaan`,
    {
      headers,
      data: {
        dossierType: 'full_closure',
        title: 'Unsupported proof claim',
        reportId: crypto.randomUUID(),
        operationKey: crypto.randomUUID(),
      },
    },
  );
  expect(synthesize.status()).toBe(409);
  expect(await synthesize.json()).toEqual({ error: { code: 'source_bound_dossier_required' } });

  for (const target of [{ reportId: crypto.randomUUID() }, { dossierId: crypto.randomUUID() }]) {
    const dispatch = await page.request.post('/api/bff/v1/reports/email/dispatch', {
      headers,
      data: { recipientEmail: 'audit@example.invalid', ...target },
    });
    expect(dispatch.status()).toBe(409);
    expect(await dispatch.json()).toEqual({ error: { code: 'source_bound_dispatch_required' } });
  }
});

test('founder cannot seal a dossier without exact retained sources', async ({ page }) => {
  const founder = await createMfaAccount('pramaan-founder', {
    role: 'founder',
    isInternal: true,
    withFactor: true,
  });
  await signInAs(page, founder.email, founder.password);
  await selectTenant(page, 'a');
  await satisfyLoginMfaWithSecret(page, founder.totpSecret!);
  const response = await page.request.post(`/api/bff/v1/dossiers/${crypto.randomUUID()}/seal`, {
    headers: { 'x-tenant-id': state.tenantA.id },
    data: { expectedProofSeal: 'a'.repeat(64) },
  });
  expect(response.status()).toBe(409);
  expect(await response.json()).toEqual({ error: { code: 'source_bound_dossier_required' } });
});
