import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { UserRole } from '@axiom/types';

const state = vi.hoisted(() => ({ role: 'admin' as string }));
vi.mock('@/lib/tenant-context', () => ({
  requireTenantContext: async () => ({
    tenantId: '11111111-1111-4111-8111-111111111111',
    role: state.role,
  }),
}));
import ConsentPage from './page';
beforeEach(() => {
  state.role = UserRole.ADMIN;
});
it('refuses to render the consent reader for a role without posture access', async () => {
  state.role = UserRole.AGENT;
  const html = renderToStaticMarkup(await ConsentPage());
  expect(html).toContain('Your role cannot view consent records');
  expect(html).not.toContain('Loading consent records');
});
it('renders a read-only viewer without fabricated data or write affordances', async () => {
  state.role = UserRole.VIEWER;
  const html = renderToStaticMarkup(await ConsentPage());
  expect(html).toContain('Read-only access');
  expect(html).toContain('Loading consent records');
  expect(html).not.toContain('Record consent');
});
it('waits for real API state for an administrator rather than displaying empty success', async () => {
  const html = renderToStaticMarkup(await ConsentPage());
  expect(html).toContain('Consent register');
  expect(html).not.toContain('Read-only access');
  expect(html).not.toContain('No purposes recorded');
});
