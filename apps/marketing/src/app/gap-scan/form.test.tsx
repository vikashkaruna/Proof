// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GAP_SCAN_QUESTIONS } from '@axiom/control-library';
import { GapScanForm } from './form';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

beforeEach(() => push.mockReset());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function startScan() {
  render(<GapScanForm />);
  const next = screen.getByRole('button', { name: 'Next' });
  expect(next.hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByLabelText('Sector'), { target: { value: 'Healthcare' } });
  fireEvent.change(screen.getByLabelText('Employee count'), { target: { value: '51-200' } });
  fireEvent.click(screen.getByLabelText(/We process data of children/));
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getByText(/0 of 12 answered/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(true);
  for (const [index, question] of GAP_SCAN_QUESTIONS.entries()) {
    const row = screen.getByText(question.prompt).closest('div.rounded-md')!;
    fireEvent.click(row.querySelectorAll('button')[index % 2]!);
  }
  expect(screen.getByText(/12 of 12 answered/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
}

it('keeps optional contact/marketing consent out of an anonymous report submission', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(Response.json({ id: 'scoped-report' }, { status: 201 }));
  vi.stubGlobal('fetch', fetcher);
  startScan();
  fireEvent.click(screen.getByLabelText(/free 30-min walkthrough/));
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  fireEvent.click(screen.getByRole('button', { name: 'Generate my report' }));
  await waitFor(() => expect(push).toHaveBeenCalledWith('/gap-scan/report/scoped-report'));
  const body = JSON.parse(fetcher.mock.calls[0]![1].body);
  expect(body).toMatchObject({
    sector: 'Healthcare',
    employeeBand: '51-200',
    processesChildrenData: true,
    followUpRequested: false,
    marketingConsent: false,
  });
  expect(Object.keys(body.answers)).toHaveLength(GAP_SCAN_QUESTIONS.length);
  expect(body).not.toHaveProperty('contactEmail');
});

it('requires requested contact details and displays a server refusal without navigation', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: { message: 'Assessment unavailable' } }, { status: 503 }),
      ),
  );
  startScan();
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  expect(screen.getByRole('button', { name: 'Generate my report' }).hasAttribute('disabled')).toBe(
    true,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ravi Sharma' } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ravi@example.invalid' } });
  fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'Acme' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  fireEvent.click(screen.getByRole('button', { name: 'Generate my report' }));
  await waitFor(() => expect(screen.getByText('Assessment unavailable')).toBeTruthy());
  expect(push).not.toHaveBeenCalled();
});
