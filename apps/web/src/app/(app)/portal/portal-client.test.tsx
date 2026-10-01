// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PortalClient, type PortalClientProps } from './portal-client';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams(),
}));
const tenant = { id: 'tenant-alpha-1234', name: 'Alpha', slug: 'alpha', tier: 'standard' };
const props: PortalClientProps = {
  tenants: [tenant],
  activeTenant: tenant,
  engagement: null,
  plans: [],
  evidence: [],
  dsars: [],
  breaches: [],
  ledger: [],
  assessmentUnavailable: false,
  loadError: false,
};

afterEach(() => {
  cleanup();
  push.mockReset();
});

it('shows absence and partial-load states without invented compliance figures', () => {
  render(<PortalClient {...props} assessmentUnavailable loadError />);
  expect(screen.getByTestId('portal-posture').textContent).toBe('—');
  expect(screen.getByTestId('portal-no-engagement').textContent).toContain(
    'Saved assessment results are unavailable',
  );
  expect(screen.getByRole('alert').textContent).toContain('nothing has been substituted');
  expect(document.body.textContent).toContain('Not recorded');
});

it('switches the active tenant only through a selected tenant slug', () => {
  const beta = { id: 'tenant-beta-5678', name: 'Beta', slug: 'beta', tier: 'standard' };
  render(<PortalClient {...props} tenants={[tenant, beta]} />);
  const selector = screen.getByRole('combobox');
  fireEvent.change(selector, { target: { value: 'beta' } });
  expect(push).toHaveBeenCalledWith('/portal?tenant=beta');
  expect(document.cookie).toContain('axiom_active_tenant=beta');
});

it('keeps empty approvals, evidence, DSARs and ledger explicitly empty across tabs', () => {
  render(<PortalClient {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /Pending Approvals/ }));
  expect(document.body.textContent).toContain('No pending remediation plans awaiting review');
  fireEvent.click(screen.getByRole('button', { name: /Evidence Records/ }));
  expect(document.body.textContent).toContain('No evidence records loaded for this tenant');
  expect(document.body.textContent).toContain('No stored-byte or retention proof can be inferred');
  expect(document.body.textContent).not.toContain('vault is active');
  expect(document.body.textContent).not.toContain('Zero Data Egress');
  fireEvent.click(screen.getByRole('button', { name: /Rights Requests/ }));
  expect(document.body.textContent).toContain('No data principal requests on record');
  expect(document.body.textContent).not.toContain('15-day statutory SLA');
  expect(document.body.textContent).not.toContain('Statutory Window: 15 Days');
  fireEvent.click(screen.getByRole('button', { name: /Audit Ledger Stream/ }));
  expect(document.body.textContent).toContain('No ledger activity recorded for this tenant');
});

it('shows saved tenant data in each tab and keeps recorded values distinct from placeholders', () => {
  render(
    <PortalClient
      {...props}
      engagement={{
        id: 'engagement-1',
        title: 'Baseline',
        status: 'completed',
        postureScore: 72,
        estimatedExposureInr: 12500000,
        summary: { pass: 7, partial: 2, fail: 1, unassessed: 0 },
        totalControls: 10,
      }}
      plans={[
        {
          id: 'plan-1',
          title: 'Close breach finding',
          status: 'review',
          version: 2,
          generatedByAgent: 'sudhaar',
          createdAt: '2026-09-30T00:00:00Z',
          actions: [
            {
              id: 'action-1',
              description: 'Patch retention',
              actionType: 'connector.patch',
              riskClass: 'low',
              blastRadius: {},
              approvalStatus: 'pending',
            },
          ],
        },
      ]}
      evidence={[
        {
          id: 'proof-1',
          contentHash: 'a'.repeat(64),
          storageUri: 's3://proof/version-1',
          evidenceType: 'policy',
          description: 'Policy snapshot',
          collectedByAgent: 'saakshi',
          collectedAt: '2026-09-30T00:00:00Z',
          demonstratesControlIds: ['DPDPA-001'],
        },
      ]}
      dsars={[
        {
          id: 'dsar-1',
          kind: 'access',
          status: 'open',
          principalName: 'Asha',
          dueBy: '2026-10-02T00:00:00Z',
          receivedAt: '2026-09-30T00:00:00Z',
          slaDays: 2,
        },
      ]}
      ledger={[
        {
          sequenceNo: 1,
          actorId: 'agent-1',
          actionType: 'evidence.sealed',
          result: 'success',
          targetRef: 'proof-1',
          entryHash: 'b'.repeat(64),
          occurredAt: '2026-09-30T00:00:00Z',
        },
      ]}
    />,
  );
  expect(screen.getByTestId('portal-posture').textContent).toBe('72');
  expect(document.body.textContent).toContain('₹1.3 Cr');
  fireEvent.click(screen.getByRole('button', { name: /Pending Approvals/ }));
  expect(document.body.textContent).toContain('Close breach finding');
  fireEvent.click(screen.getByRole('button', { name: /Evidence Records/ }));
  expect(document.body.textContent).toContain('Policy snapshot');
  fireEvent.click(screen.getByRole('button', { name: /Rights Requests/ }));
  expect(document.body.textContent).toContain('Asha');
  fireEvent.click(screen.getByRole('button', { name: /Audit Ledger Stream/ }));
  expect(document.body.textContent).toContain('evidence.sealed');
});

it('does not infer residency, provider retention or full statutory scope from saved rows', () => {
  render(
    <PortalClient
      {...props}
      engagement={{
        id: 'engagement-1',
        title: 'Recorded review',
        status: 'active',
        postureScore: null,
        estimatedExposureInr: null,
        summary: { pass: 0, partial: 0, fail: 0, unassessed: 1 },
        totalControls: 1,
      }}
      evidence={[
        {
          id: 'e1',
          contentHash: '',
          storageUri: '',
          evidenceType: 'record',
          description: 'Metadata only',
          collectedByAgent: '',
          collectedAt: '',
          demonstratesControlIds: [],
        },
      ]}
    />,
  );
  expect(document.body.textContent).toContain('Deployment region:');
  expect(document.body.textContent).toContain('verify operationally');
  expect(document.body.textContent).not.toContain('Full statutory readiness scope');
  fireEvent.click(screen.getByRole('button', { name: /Evidence Records/ }));
  expect(document.body.textContent).toContain('storage unverified here');
  expect(document.body.textContent).toContain('Hash not recorded');
  expect(document.body.textContent).toContain('Storage URI not recorded');
  expect(document.body.textContent).not.toContain('Sealed by');
  expect(document.body.textContent).not.toContain('AWS S3 Object Lock');
  expect(screen.getByRole('button', { name: 'Copy' }).hasAttribute('disabled')).toBe(true);
});

it('shows Saakshi and Sudhaar in the hero as static AgentLabels, not as running', () => {
  render(<PortalClient {...props} />);
  const labels = screen.getAllByTestId('agent-label');
  expect(labels.map((l) => l.getAttribute('data-agent'))).toEqual(['saakshi', 'sudhaar']);
  expect(labels.map((l) => l.getAttribute('data-state'))).toEqual(['idle', 'idle']);
});
