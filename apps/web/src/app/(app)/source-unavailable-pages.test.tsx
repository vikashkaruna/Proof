import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import DataMapPage from './datamap/page';
import PartnerPage from './partner/page';

vi.mock('./generic-module-view', () => ({
  GenericModuleView: ({ meta, children }: { meta: unknown; children: React.ReactNode }) => (
    <div><pre>{JSON.stringify(meta)}</pre>{children}</div>
  ),
}));

it('refuses to present invented RoPA activities or residency verification', async () => {
  const view = renderToStaticMarkup(await DataMapPage());
  expect(view).toContain('No source-bound processing map is available');
  expect(view).toContain('&quot;cards&quot;:[]');
  expect(view).not.toContain('34 flows');
  expect(view).not.toContain('Verified domestic residency');
  expect(view).not.toContain('Re-generate RoPA Map');
});

it('refuses to present fictional partner counts, contracts, or auditor packs', async () => {
  const view = renderToStaticMarkup(await PartnerPage());
  expect(view).toContain('No partner portfolio or processor due-diligence records');
  expect(view).toContain('&quot;cards&quot;:[]');
  expect(view).not.toContain('4 Managed Organizations');
  expect(view).not.toContain('Under 6 Hours');
  expect(view).not.toContain('Generate Multi-Client Auditor Pack');
});
