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
import EvidencePage from './page';
beforeEach(() => {
  state.role = UserRole.ADMIN;
});
it('refuses evidence surface to an agent role', async () => {
  state.role = UserRole.AGENT;
  const html = renderToStaticMarkup(await EvidencePage());
  expect(html).toContain('Your role cannot view evidence records');
  expect(html).not.toContain('Upload evidence');
});
it('renders a read-only viewer with no upload form or invented records', async () => {
  state.role = UserRole.VIEWER;
  const html = renderToStaticMarkup(await EvidencePage());
  expect(html).toContain('Loading evidence');
  expect(html).not.toContain('Upload evidence');
  expect(html).not.toContain('sealed artifacts');
  expect(html).not.toContain('e-8841');
  expect(html).not.toContain('1,284');
});
it('requires actual API outcomes and explicit retention review for managers', async () => {
  const html = renderToStaticMarkup(await EvidencePage());
  expect(html).toContain('I reviewed this file and authorize its seven-year retention.');
  expect(html).toContain('Loading upload operations');
  expect(html).not.toContain('No upload operations recorded');
  expect(html).not.toContain('Cryptographic SHA-256 integrity check verified');
});
