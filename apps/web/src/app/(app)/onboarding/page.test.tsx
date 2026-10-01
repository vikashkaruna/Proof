import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import OnboardingPage from './page';

vi.mock('@axiom/supabase', () => ({ createSupabaseServerClient: async () => ({ auth: {
  getUser: async () => ({ data: { user: { email: 'founder@example.com', user_metadata: {} } } }),
} }) }));
vi.mock('./onboarding-form', () => ({ OnboardingForm: () => <div>Onboarding fields</div> }));

it('does not claim ledger sealing, assessment completion, or region proof at onboarding', async () => {
  const view = renderToStaticMarkup(await OnboardingPage());
  expect(view).toContain('Onboarding fields');
  expect(view).toContain('Deployment region requires verification');
  expect(view).not.toContain('cryptographically seals onboarding');
  expect(view).not.toContain('initializes statutory assessment baseline');
});
