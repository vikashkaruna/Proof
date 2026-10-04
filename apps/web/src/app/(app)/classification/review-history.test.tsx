// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ClassificationReviewHistoryView } from './review-history';
import type { ClassificationReview } from '@/lib/classification-reviews';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
const review: ClassificationReview = {
  id: '33333333-3333-4333-8333-333333333333',
  tenant_id: '11111111-1111-4111-8111-111111111111',
  system_id: 'website-content',
  resource_path: 'contact.email',
  sensitivity_level: 'public',
  detected_categories: ['contact'],
  confidence_score: 0,
  reviewed_by: '44444444-4444-4444-8444-444444444444',
  decision: 'adjusted',
  adjusted_sensitivity: 'internal',
  justification: '<img src=x onerror=alert(1)> Human adjustment of declared data.',
  created_at: '2026-10-04T10:00:00Z',
};
afterEach(cleanup);

it('shows recorded facts and uncertainty without implying an agent source or correction', () => {
  const view = render(
    <ClassificationReviewHistoryView
      history={{ state: 'ready', reviews: [review], page: 1, hasNext: false }}
    />,
  );
  expect(
    screen.getByRole('region', { name: 'Recorded human classification reviews' }),
  ).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'website-content · contact.email' })).toBeTruthy();
  for (const fact of [
    'public',
    'internal',
    'contact',
    '0%',
    review.reviewed_by,
    review.justification,
  ]) {
    expect(screen.getByText(fact)).toBeTruthy();
  }
  expect(document.body.textContent).toContain('source verification are not recorded');
  expect(document.body.textContent).toContain('They do not prove that a system was scanned');
  expect(view.container.querySelector('img')).toBeNull();
  expect(view.container.querySelector('time')?.getAttribute('dateTime')).toBe(review.created_at);
  expect(screen.queryAllByRole('button')).toHaveLength(0);
  expect(view.container.querySelectorAll('form')).toHaveLength(0);
  expect(view.container.querySelector('[class*="max-w-"]')).toBeNull();
});

it('never treats a dismissed review as a successful correction', () => {
  render(
    <ClassificationReviewHistoryView
      history={{
        state: 'ready',
        reviews: [{ ...review, decision: 'dismissed', adjusted_sensitivity: null }],
        page: 1,
        hasNext: false,
      }}
    />,
  );
  expect(screen.getByText('dismissed')).toBeTruthy();
  expect(screen.getByText('No adjustment recorded')).toBeTruthy();
  expect(document.body.textContent).not.toContain('Final sensitivity');
});

it('exposes bounded paging and identifies empty older pages accurately', () => {
  const view = render(
    <ClassificationReviewHistoryView
      history={{ state: 'ready', reviews: [review], page: 2, hasNext: true }}
    />,
  );
  expect(screen.getByRole('link', { name: 'Newer reviews' }).getAttribute('href')).toBe(
    '/classification?reviewPage=1',
  );
  expect(screen.getByRole('link', { name: 'Older reviews' }).getAttribute('href')).toBe(
    '/classification?reviewPage=3',
  );
  expect(document.body.textContent).toContain('up to 50 records per page');
  view.rerender(
    <ClassificationReviewHistoryView
      history={{ state: 'ready', reviews: [], page: 1000, hasNext: true }}
    />,
  );
  expect(screen.queryByRole('link', { name: 'Older reviews' })).toBeNull();
  expect(document.body.textContent).toContain('No human classification reviews on this page.');
});

it('distinguishes empty, unavailable and invalid pages', () => {
  const view = render(
    <ClassificationReviewHistoryView
      history={{ state: 'ready', reviews: [], page: 1, hasNext: false }}
    />,
  );
  expect(screen.getByText('No human classification reviews recorded.')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  view.rerender(<ClassificationReviewHistoryView history={{ state: 'unavailable' }} />);
  expect(screen.getByRole('alert').textContent).toContain('history is unavailable');
  expect(document.body.textContent).not.toContain('No human classification reviews recorded.');
  view.rerender(<ClassificationReviewHistoryView history={{ state: 'invalid_page' }} />);
  expect(screen.getByRole('alert').textContent).toContain('between 1 and 1000');
  expect(screen.getByRole('link', { name: 'Open the first page' }).getAttribute('href')).toBe(
    '/classification',
  );
});
