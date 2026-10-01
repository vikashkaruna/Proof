import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: (props: React.PropsWithChildren<{ href: string }>) => (
    <a href={props.href}>{props.children}</a>
  ),
}));
import { DpbReviewsClient } from './reviews-client';

const props = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  breaches: [],
  notifications: [],
  canRequest: false,
  founder: false,
};

describe('DPB review browser surface', () => {
  it('labels the actual source and withholds request actions without authority', () => {
    const html = renderToStaticMarkup(<DpbReviewsClient {...props} />);
    expect(html).toContain('operator records');
    expect(html).toContain('does not certify forensic facts, regulator receipt or acceptance');
    expect(html).not.toContain('Freeze source');
  });

  it('only offers a source freeze from reviewed DPB notifications', () => {
    const html = renderToStaticMarkup(
      <DpbReviewsClient
        {...props}
        canRequest
        notifications={[
          {
            id: '22222222-2222-4222-8222-222222222222',
            breach_id: '33333333-3333-4333-8333-333333333333',
            kind: 'dpb',
            status: 'reviewed',
            subject: 'Reviewed notice',
            reviewed_at: '2026-10-01T00:00:00Z',
            delivery_outcome: null,
          },
          {
            id: '44444444-4444-4444-8444-444444444444',
            breach_id: '33333333-3333-4333-8333-333333333333',
            kind: 'dpb',
            status: 'draft',
            subject: 'Unreviewed notice',
            reviewed_at: null,
            delivery_outcome: null,
          },
        ]}
      />,
    );
    expect(html).toContain('Reviewed notice');
    expect(html).not.toContain('Unreviewed notice');
    expect(html).toContain('Freeze source');
  });
});
