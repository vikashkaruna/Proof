import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import Page from './page';
const state = vi.hoisted(() => ({ role: 'owner', isAxiomInternal: false }));
vi.mock('@/lib/tenant-context', () => ({
  requireTenantContext: async () => ({
    ...state,
    tenantId: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
  }),
}));
vi.mock('./local-custody-client', () => ({
  LocalCustodyClient: (props: unknown) => <pre>{JSON.stringify(props)}</pre>,
}));
beforeEach(() => {
  state.role = 'owner';
  state.isAxiomInternal = false;
});
it('passes verified tenant and actor to the client without infrastructure credentials', async () => {
  const html = renderToStaticMarkup(await Page());
  expect(html).toContain('Local dispatch-key custody');
  expect(html).toContain('11111111-1111-4111-8111-111111111111');
  expect(html).toContain('22222222-2222-4222-8222-222222222222');
  expect(html).not.toContain('keyMaterial');
});
it.each(['viewer', 'admin', 'approver', 'founder', 'axiom_analyst'])(
  'refuses unsupported or non-internal %s role',
  async (role) => {
    state.role = role;
    const html = renderToStaticMarkup(await Page());
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('<pre>');
  },
);
it.each(['founder', 'axiom_analyst'])(
  'admits internal %s to current backend-scoped context',
  async (role) => {
    state.role = role;
    state.isAxiomInternal = true;
    expect(renderToStaticMarkup(await Page())).toContain('<pre>');
  },
);
