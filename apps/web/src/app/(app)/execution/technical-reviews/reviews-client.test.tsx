import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: (props: React.PropsWithChildren<{ href: string }>) => (
    <a href={props.href}>{props.children}</a>
  ),
}));
import { TechnicalReviewsClient } from './reviews-client';

const props = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  plans: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      title: 'Recorded plan',
      status: 'review',
      created_at: '2026-10-01T00:00:00Z',
    },
  ],
  canRequest: false,
  founder: false,
};

describe('technical recorded register browser surface', () => {
  it('states source limits and withholds actions without authority', () => {
    const html = renderToStaticMarkup(<TechnicalReviewsClient {...props} />);
    expect(html).toContain('do not independently attest execution');
    expect(html).not.toContain('Freeze source');
  });
  it('offers request against a recorded plan and labels the selected source', () => {
    const html = renderToStaticMarkup(<TechnicalReviewsClient {...props} canRequest />);
    expect(html).toContain('Recorded plan');
    expect(html).toContain('Freeze source');
  });
});
