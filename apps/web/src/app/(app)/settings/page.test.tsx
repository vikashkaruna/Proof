import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import SettingsPage from './page';

vi.mock('@/lib/tenant-context', () => ({
  requireTenantContext: async () => ({
    role: 'viewer',
    supabase: {
      auth: {
        getUser: async () => ({
          data: {
            user: {
              id: 'user-12345678901234567890',
              email: 'reader@example.com',
              user_metadata: {},
              last_sign_in_at: null,
            },
          },
        }),
      },
    },
  }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

it('shows only known identity and leaves deployment/storage assertions unverified', async () => {
  const view = renderToStaticMarkup(await SettingsPage());
  expect(view).toContain('reader@example.com');
  expect(view).toContain('Not provided');
  expect(view).toContain('Unverified in this view');
  expect(view).toContain('Verify with the exact stored object version');
  expect(view).not.toContain('0 non-domestic hops');
  expect(view).not.toContain('Enforced before LLM egress');
  expect(view).not.toContain('AWS S3 Object Lock Compliance');
  expect(view).not.toContain('Compliance Lead');
});
