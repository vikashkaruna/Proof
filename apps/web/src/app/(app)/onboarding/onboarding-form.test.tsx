// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { OnboardingForm } from './onboarding-form';

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); router.push.mockReset(); router.refresh.mockReset(); router.back.mockReset(); });

it('creates only a user-specified organization and no invented systems or assessment', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ tenant: { id: 'tenant-new' } }, { status: 201 }));
  vi.stubGlobal('fetch', fetcher);
  render(<OnboardingForm userEmail="owner@example.invalid" userFullName="Ravi Sharma" />);
  expect(screen.queryByText('Initial Data Systems for Drishti Discovery Scan')).toBeNull();
  expect((screen.getByLabelText('Data Residency Boundary') as HTMLInputElement).value)
    .toContain('must be verified');
  expect(document.body.textContent).not.toContain('100% Domestic Sovereign');
  fireEvent.change(screen.getByLabelText('Organization Legal Name *'), { target: { value: ' Alpha Fintech ' } });
  fireEvent.change(screen.getByLabelText('Tenant Slug (Optional)'), { target: { value: 'alpha-fintech' } });
  fireEvent.click(screen.getByLabelText(/SDF Status/));
  fireEvent.submit(screen.getByRole('button', { name: /Complete organization setup/ }).closest('form')!);
  await waitFor(() => expect(router.push).toHaveBeenCalledWith('/dashboard'));
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe('/api/bff/v1/organizations/onboard');
  expect(JSON.parse(init.body)).toMatchObject({ name: 'Alpha Fintech', slug: 'alpha-fintech', is_sdf: true, dpo_name: 'Ravi Sharma', dpo_email: 'owner@example.invalid' });
  expect(JSON.parse(init.body)).not.toHaveProperty('systems');
  expect(document.cookie).toContain('axiom_active_tenant=tenant-new');
});

it('refuses a blank organization name before contacting the BFF', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  render(<OnboardingForm userEmail="owner@example.invalid" userFullName="Ravi Sharma" />);
  fireEvent.submit(screen.getByRole('button', { name: /Complete organization setup/ }).closest('form')!);
  expect(screen.getByText('Organization name is required.')).toBeTruthy();
  expect(fetcher).not.toHaveBeenCalled();
});

it('leaves the user on the form when the BFF refuses organization creation', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { message: 'Quota exceeded' } }, { status: 429 })));
  render(<OnboardingForm userEmail="owner@example.invalid" userFullName="Ravi Sharma" />);
  fireEvent.change(screen.getByLabelText('Organization Legal Name *'), { target: { value: 'Alpha Fintech' } });
  fireEvent.submit(screen.getByRole('button', { name: /Complete organization setup/ }).closest('form')!);
  await waitFor(() => expect(screen.getByText('Quota exceeded')).toBeTruthy());
  expect(router.push).not.toHaveBeenCalled();
  expect(router.refresh).not.toHaveBeenCalled();
});
