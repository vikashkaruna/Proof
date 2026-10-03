import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import SettingsPage from './page';

const state = vi.hoisted(() => ({ role: 'viewer' }));
vi.mock('@/lib/tenant-context', () => ({
  requireTenantContext: async () => ({
    role: state.role,
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

beforeEach(() => {
  state.role = 'viewer';
});

it('shows only known identity and leaves deployment/storage assertions unverified', async () => {
  const view = renderToStaticMarkup(await SettingsPage());
  expect(view).toContain('reader@example.com');
  expect(view).toContain('href="/settings/security"');
  expect(view).toContain('Manage authenticator and recovery codes');
  expect(view).toContain('Not provided');
  expect(view).toContain('Unverified in this view');
  expect(view).toContain('Verify with the exact stored object version');
  expect(view).not.toContain('0 non-domestic hops');
  expect(view).not.toContain('Enforced before LLM egress');
  expect(view).not.toContain('AWS S3 Object Lock Compliance');
  expect(view).not.toContain('Compliance Lead');
  expect(view).not.toContain('Members &amp; invitations');
  expect(view).not.toContain('href="/settings/members"');
});

it('places member management in its own settings section after the page header for admins', async () => {
  state.role = 'admin';
  const view = renderToStaticMarkup(await SettingsPage());

  expect(view).toContain('aria-labelledby="members-settings-heading"');
  expect(view).toContain('Invite people, review who has access');
  expect(view).toContain('href="/settings/members"');
  expect(view.indexOf('Settings &amp; Preferences')).toBeLessThan(
    view.indexOf('members-settings-heading'),
  );
  expect(view.indexOf('members-settings-heading')).toBeLessThan(
    view.indexOf('Account &amp; Session Identity'),
  );
});
