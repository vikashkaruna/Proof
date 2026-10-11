import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { UserRole } from '@axiom/types';

const state = vi.hoisted(() => ({ role: 'admin' as string }));
vi.mock('@/lib/tenant-context', async () => {
  const { can } = await import('@axiom/types');
  return {
    requireCapabilityContext: async (capability: Parameters<typeof can>[0]) => {
      if (!can(capability, { role: state.role as UserRole })) throw new Error('forbidden');
      return { tenantId: '11111111-1111-4111-8111-111111111111', role: state.role };
    },
  };
});
import ConsentPage from './page';
beforeEach(() => {
  state.role = UserRole.ADMIN;
});
it.each([UserRole.AGENT, UserRole.VIEWER, UserRole.PARTNER, UserRole.APPROVER])(
  'refuses the consent workflow to %s, which the menu does not offer it',
  async (role) => {
    state.role = role;
    await expect(ConsentPage()).rejects.toThrow('forbidden');
  },
);
it('renders a read-only analyst without fabricated data or write affordances', async () => {
  state.role = UserRole.AXIOM_ANALYST;
  const html = renderToStaticMarkup(await ConsentPage());
  expect(html).toContain('Read-only access');
  expect(html).toContain('Loading consent records');
  expect(html).not.toContain('Record consent');
});
it('waits for real API state for an administrator rather than displaying empty success', async () => {
  const html = renderToStaticMarkup(await ConsentPage());
  expect(html).toContain('Consent Manager');
  expect(html).not.toContain('Read-only access');
  expect(html).not.toContain('No purposes recorded');
});
