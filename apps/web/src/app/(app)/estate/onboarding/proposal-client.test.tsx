// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProposalClient, type ProposalData } from './proposal-client';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const estate = { id: 'estate-1', name: 'Client estate', slug: 'client', description: 'Client declared', status: 'active' as const, version: 1 };
const intake = [{ name: 'Payroll', type: 'database', description: 'Submitted by client', region: 'ap-south-1', hosts_personal_data: true, data_categories: ['identity'] }];
const proposal: ProposalData['proposals'][number] = {
  id: 'proposal-1', estate_id: estate.id, prepared_by: 'analyst-1', estate_snapshot: estate,
  source_snapshot: intake, systems: [{ name: 'Payroll', systemKind: 'database', description: 'Submitted by client', externalRef: null, dataCategories: ['identity'] }],
  content_sha256: 'a'.repeat(64), status: 'pending', review_reason: null, reviewed_by: null,
  onboarding_proposal_systems: [],
};
const base = { tenantId: 'tenant-1', userId: 'owner-1', canPrepare: false, canReview: false, estates: [estate] };
afterEach(cleanup);

it('does not invent systems when the source intake is empty', () => {
  render(<ProposalClient {...base} canPrepare data={{ intake: [], proposals: [] }} />);
  expect(screen.getByText(/No systems were submitted in the onboarding intake/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Submit proposal for review' })).toBeNull();
  expect(document.body.textContent).not.toContain('production-core-postgres');
});

it('requires a different authorized reviewer for a pending source-bound proposal', () => {
  const data = { intake, proposals: [proposal] };
  const self = render(<ProposalClient {...base} userId="analyst-1" canReview data={data} />);
  expect(screen.getByText('Awaiting review by a different client owner or admin.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Record review' })).toBeNull();
  self.unmount();
  render(<ProposalClient {...base} canReview data={data} />);
  expect(screen.getByRole('button', { name: 'Record review' })).toBeTruthy();
  expect(screen.getByText(/Original intake/)).toBeTruthy();
  expect(screen.getByText(/Proposed inventory/)).toBeTruthy();
});

it('shows proposed fields from the actual intake for analyst review', () => {
  render(<ProposalClient {...base} canPrepare data={{ intake, proposals: [] }} />);
  expect(screen.getByRole('button', { name: 'Submit proposal for review' })).toBeTruthy();
  expect((screen.getByLabelText('Proposed system name') as HTMLInputElement).value).toBe('Payroll');
  expect((screen.getByLabelText('Proposed categories (comma-separated lowercase keys)') as HTMLInputElement).value).toBe('identity');
  expect(document.body.textContent).toContain('Source region and personal-data declarations remain in the original snapshot');
});
