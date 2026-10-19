import type * as ActualUi from '@axiom/ui';
// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AssessmentSnapshot } from '@axiom/types';
import { moduleMeta } from '@/lib/module-meta';
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
vi.mock('@axiom/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof ActualUi>()),
  AgentIcon: () => <span aria-hidden="true" />,
}));

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
  render(<AssessmentClient snapshot={null} canInvokeAgent />);
  expect(screen.getByTestId('assessment-provenance').textContent).toContain('unavailable');
  expect(screen.queryByRole('button', { name: 'Run Parikshan' })).toBeNull();
  expect(screen.getByTestId('assessment-summary').textContent).toContain(
    'Control posture unavailable',
  );
  expect(document.body.textContent).toContain('Control results unavailable.');
  expect(document.body.textContent).not.toContain('Recorded consent control');
  expect(state.invoke).not.toHaveBeenCalled();
});

it('shows saved controls without inventing an assessment or exposure when no engagement exists', () => {
  render(
    <AssessmentClient snapshot={{ ...snapshot, engagement: null }} canCreate canInvokeAgent />,
  );
  expect(screen.getByTestId('assessment-provenance').textContent).toContain(
    'No saved assessment exists',
  );
  expect(screen.getByRole('link', { name: 'Create an assessment' }).getAttribute('href')).toBe(
    '/engagements',
  );
  expect(screen.queryByRole('button', { name: 'Run Parikshan' })).toBeNull();
  expect(screen.getByTestId('assessment-summary').textContent).toContain('Not assessed');
  expect(screen.getByTestId('assessment-control-CTRL-1').textContent).toContain('Saved score: 75');
  expect(screen.getByTestId('assessment-control-CTRL-2').textContent).toContain('No saved score');
  expect(state.invoke).not.toHaveBeenCalled();
});

it('renders the shared module context outside the heading', () => {
  render(<AssessmentClient snapshot={null} />);
  const meta = moduleMeta('assessment');
  const heading = screen.getByRole('heading', { name: 'Assessment' });
  const provenance = screen.getByTestId('assessment-provenance');
  expect(meta.moduleId).toBe('M0.3');
  expect(screen.getByText(meta.hi)).toBeTruthy();
  expect(screen.getByText(meta.moduleId ?? '')).toBeTruthy();
  expect(heading.textContent).not.toContain(meta.hi);
  expect(heading.compareDocumentPosition(provenance) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(4);
  expect(screen.getByRole('region', { name: 'Saved control results' })).toBeTruthy();
});

it('keeps the saved assessment readable without an invocation control for viewers', () => {
  render(<AssessmentClient snapshot={snapshot} />);
  expect(screen.getByTestId('assessment-provenance').textContent).toContain('Recorded review');
  expect(screen.getByTestId('assessment-control-CTRL-1').textContent).toContain('Saved score: 75');
  expect(screen.queryByRole('button', { name: 'Run Parikshan' })).toBeNull();
});

function declaredSnapshot(): AssessmentSnapshot {
  return {
    ...snapshot,
    exposureInr: 1000,
    provenance: {
      status: 'caller_declared_unverified',
      runId: '33333333-3333-4333-8333-333333333333',
      libraryDigest: 'a'.repeat(64),
      estimates: 'provisional',
      applicability: {
        sdfSelfAttested: { value: null, provenance: 'unknown' },
        processesChildren: { value: false, provenance: 'caller_declared_unverified' },
        processesHealth: { value: true, provenance: 'caller_declared_unverified' },
      },
    },
    controls: [
      {
        ...snapshot.controls[0]!,
        score: 30,
        scoreBand: 'fail',
        status: 'unknown',
        answerState: 'unknown',
        applicabilityState: 'unknown',
        answerCounts: { knownBooleanQuestions: 2, callerAffirmed: 0, callerDenied: 0, unknown: 2 },
      },
      snapshot.controls[1]!,
    ],
    summary: { pass: 0, partial: 0, fail: 0, unassessed: 1, unknown: 1, not_applicable: 0 },
  };
}

it('shows unknown questionnaire results separately from a failed score band', () => {
  render(<AssessmentClient snapshot={declaredSnapshot()} />);
  const row = screen.getByTestId('assessment-control-CTRL-1');
  expect(row.textContent).toContain('UNKNOWN');
  expect(row.textContent).not.toContain('FAIL');
  expect(row.textContent).toContain('Provisional score: 30');
  expect(row.textContent).toContain('2 of 2 boolean answers unknown');
  expect(row.textContent).toContain('Applicability unknown');
  expect(screen.getByTestId('assessment-summary').textContent).toContain('1 unknown');
  expect(screen.getByTestId('assessment-questionnaire-provenance').textContent).toContain(
    'requiring review',
  );
  expect(screen.queryByRole('button', { name: 'Run Parikshan' })).toBeNull();
});

it('keeps questionnaire declarations distinct from the recorded SDF tenant profile', () => {
  render(<AssessmentClient snapshot={{ ...declaredSnapshot(), isSdf: true }} />);
  expect(screen.getByText('Designated')).toBeTruthy();
  // Explicitly inspect the labeled declaration group, not the tenant profile card.
  const group = screen.getByLabelText('Questionnaire applicability declarations');
  expect(group.textContent).toContain('SDF self-attestationUnknown');
  expect(group.textContent).toContain('Processes children’s dataDeclared no · unverified');
  expect(group.textContent).toContain('Processes health dataDeclared yes · unverified');
});

it('labels a declared non-applicable control as unverified without inventing a pass', () => {
  const saved = declaredSnapshot();
  saved.controls[0] = {
    ...saved.controls[0]!,
    status: 'not_applicable',
    applicabilityState: 'caller_declared_not_applicable_unverified',
  };
  saved.summary.unknown = 0;
  saved.summary.not_applicable = 1;
  render(<AssessmentClient snapshot={saved} />);
  const row = screen.getByTestId('assessment-control-CTRL-1');
  expect(row.textContent).toContain('NOT APPLICABLE');
  expect(row.textContent).toContain('caller declaration · requires review');
  expect(row.textContent).not.toContain('PASS');
  expect(screen.getByTestId('assessment-summary').textContent).toContain(
    '1 not applicable · unverified',
  );
});

it('does not infer questionnaire provenance from legacy numeric findings', () => {
  render(<AssessmentClient snapshot={snapshot} />);
  expect(screen.getByTestId('assessment-questionnaire-provenance').textContent).toContain(
    'provenance is unavailable',
  );
  expect(screen.getByTestId('assessment-control-CTRL-1').textContent).toContain('Saved score: 75');
  expect(document.body.textContent).not.toContain('Provisional score');
  expect(screen.queryByLabelText('Questionnaire applicability declarations')).toBeNull();
});

it('shows pipeline progress only from a saved finalized declaration snapshot', () => {
  render(<AssessmentClient snapshot={declaredSnapshot()} />);
  expect(screen.getByTestId('pipeline-parikshan').getAttribute('data-state')).toBe('completed');
  expect(screen.getByTestId('pipeline-saakshi').getAttribute('data-state')).toBe('not-run');
});

it('reads the penalty exposure estimate in crores', () => {
  render(<AssessmentClient snapshot={{ ...declaredSnapshot(), exposureInr: 1_85_00_00_000 }} />);
  expect(document.body.textContent).toContain('₹185 Cr');
  expect(document.body.textContent).not.toContain('1,85,00,00,000');
});

it('offers explicit choose or create recovery for an unreadable selected assessment', () => {
  render(<AssessmentClient snapshot={null} canCreate />);
  expect(
    screen.getByRole('link', { name: /choose or create an assessment/i }).getAttribute('href'),
  ).toBe('/engagements');
  expect(screen.queryByRole('button', { name: 'Submit reviewed questionnaire' })).toBeNull();
});

function scheduledSnapshot(): AssessmentSnapshot {
  return {
    ...snapshot,
    exposureInr: null,
    controls: snapshot.controls.map((control) => ({
      ...control,
      score: null,
      status: 'unknown',
      answerState: 'unknown',
      applicabilityState: 'unknown',
    })),
    summary: { pass: 0, partial: 0, fail: 0, unassessed: 0, unknown: 2 },
    scheduledCoverage: {
      tenantId: snapshot.tenantId,
      engagementId: snapshot.engagement!.id,
      runId: '33333333-3333-4333-8333-333333333333',
      fireId: '44444444-4444-4444-8444-444444444444',
      scopeId: '55555555-5555-4555-8555-555555555555',
      scopeReceiptId: '123',
      discoveryId: '66666666-6666-4666-8666-666666666666',
      discoveryResultSha256: 'a'.repeat(64),
      basis: 'technical_provenance_only',
      declarationPolicy: 'all_business_facts_unknown',
    },
  };
}
it('explains a matching trusted scheduled source without asserting business compliance', () => {
  render(<AssessmentClient snapshot={scheduledSnapshot()} />);
  const notice = screen.getByRole('region', { name: 'Scheduled technical coverage' });
  expect(notice.textContent).toContain('technical observations only');
  expect(notice.textContent).toContain('Unknown');
  expect(notice.textContent).toContain('Scores and exposure are withheld');
  expect(notice.textContent).toContain('not a compliance status');
  expect(notice.textContent).not.toContain(snapshot.tenantId);
  expect(screen.getByTestId('assessment-questionnaire-provenance').textContent).not.toContain(
    'provisional estimates',
  );
});
it('does not relabel an ordinary saved source as scheduled coverage', () => {
  render(<AssessmentClient snapshot={snapshot} />);
  expect(screen.queryByRole('region', { name: 'Scheduled technical coverage' })).toBeNull();
  expect(screen.queryByText(/source basis for this saved result could not be verified/)).toBeNull();
});
it.each(['malformed', 'foreign_tenant', 'other_engagement'] as const)(
  'refuses a technical-source claim for %s coverage metadata',
  (kind) => {
    const value = scheduledSnapshot();
    const coverage = value.scheduledCoverage!;
    if (kind === 'foreign_tenant') coverage.tenantId = '77777777-7777-4777-8777-777777777777';
    if (kind === 'other_engagement') coverage.engagementId = '77777777-7777-4777-8777-777777777777';
    const input =
      kind === 'malformed'
        ? ({
            ...value,
            scheduledCoverage: { ...coverage, basis: 'untrusted' },
          } as unknown as AssessmentSnapshot)
        : value;
    render(<AssessmentClient snapshot={input} />);
    expect(screen.queryByRole('region', { name: 'Scheduled technical coverage' })).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain(
      'source basis for this saved result could not be verified',
    );
  },
);
