// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AssessmentSnapshot } from '@axiom/types';
import { AssessmentClient } from './assessment-client';

const state = vi.hoisted(() => ({ invoke: vi.fn(), refresh: vi.fn() }));
vi.mock('@/lib/invoke-agent', () => ({
  invokeAgent: state.invoke,
  AgentInvocationError: class AgentInvocationError extends Error {},
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: state.refresh }) }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@axiom/ui', () => ({ AgentIcon: () => <span aria-hidden="true" /> }));

const snapshot: AssessmentSnapshot = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  engagement: {
    id: '22222222-2222-4222-8222-222222222222',
    title: 'Recorded review',
    libraryVersion: 'v2',
    status: 'in_progress',
  },
  isSdf: false,
  exposureInr: null,
  controls: [
    {
      id: 'CTRL-1',
      name: 'Recorded consent control',
      domain: 'Consent',
      cite: 'Source citation',
      score: 75,
      status: 'partial',
      evidenceIds: [],
    },
    {
      id: 'CTRL-2',
      name: 'Unassessed control',
      domain: 'Consent',
      cite: '',
      score: null,
      status: 'unassessed',
      evidenceIds: [],
    },
  ],
  summary: { pass: 0, partial: 1, fail: 0, unassessed: 1 },
};

beforeEach(() => {
  state.invoke.mockReset();
  state.refresh.mockReset();
});
afterEach(cleanup);

it('refuses invocation when saved assessment results are unavailable', () => {
  render(<AssessmentClient snapshot={null} />);
  expect(screen.getByTestId('assessment-provenance').textContent).toContain('unavailable');
  expect(screen.getByRole('button', { name: 'Run Parikshan' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByTestId('assessment-summary').textContent).toContain(
    'Control posture unavailable',
  );
  expect(document.body.textContent).toContain('Control results unavailable.');
  expect(document.body.textContent).not.toContain('Recorded consent control');
  expect(state.invoke).not.toHaveBeenCalled();
});

it('shows saved controls without inventing an assessment or exposure when no engagement exists', () => {
  render(<AssessmentClient snapshot={{ ...snapshot, engagement: null }} />);
  expect(screen.getByTestId('assessment-provenance').textContent).toContain(
    'No saved assessment exists',
  );
  expect(screen.getByRole('button', { name: 'Run Parikshan' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByTestId('assessment-summary').textContent).toContain('Not assessed');
  expect(screen.getByTestId('assessment-control-CTRL-1').textContent).toContain('Saved score: 75');
  expect(screen.getByTestId('assessment-control-CTRL-2').textContent).toContain('No saved score');
  expect(state.invoke).not.toHaveBeenCalled();
});

it('invokes Parikshan only for the saved engagement and shows only a returned ledger reference', async () => {
  state.invoke.mockResolvedValue({ ledger_entry_ids: ['ledger-1'] });
  render(<AssessmentClient snapshot={snapshot} />);
  fireEvent.click(screen.getByRole('button', { name: 'Run Parikshan' }));
  await waitFor(() => expect(state.refresh).toHaveBeenCalledOnce());
  expect(state.invoke).toHaveBeenCalledOnce();
  expect(state.invoke).toHaveBeenCalledWith('parikshan', {
    scope: 'assessment_pipeline',
    engagement_id: snapshot.engagement?.id,
    library_version: 'v2',
  });
  expect(screen.getByTestId('pipeline-parikshan').getAttribute('data-state')).toBe('completed');
  expect(screen.getByTestId('pipeline-saakshi').getAttribute('data-state')).toBe('not-run');
  expect(screen.getByRole('link', { name: /Ledger entry #ledger-1/ }).getAttribute('href')).toBe(
    '/ledger?q=ledger-1',
  );
});

it('keeps failed or ambiguous invocations unconfirmed and does not show a proof reference', async () => {
  state.invoke.mockRejectedValue(new Error('network failed'));
  render(<AssessmentClient snapshot={snapshot} />);
  fireEvent.click(screen.getByRole('button', { name: 'Run Parikshan' }));
  await waitFor(() =>
    expect(screen.getByTestId('assessment-invocation-error').textContent).toContain(
      'Could not confirm the assessment outcome',
    ),
  );
  expect(screen.getByTestId('pipeline-parikshan').getAttribute('data-state')).toBe('not-run');
  expect(screen.queryByRole('link', { name: /Ledger entry #/ })).toBeNull();
  expect(state.refresh).not.toHaveBeenCalled();
});
