import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { controls, LIBRARY_VERSION } from '@axiom/control-library';
import ControlLibraryPage from './page';

vi.mock('../generic-module-view', () => ({
  GenericModuleView: ({ meta, children }: { meta: unknown; children: React.ReactNode }) => (
    <div><pre data-testid="meta">{JSON.stringify(meta)}</pre>{children}</div>
  ),
}));

async function html(searchParams: { domain?: string; severity?: string; q?: string } = {}) {
  return renderToStaticMarkup(await ControlLibraryPage({ searchParams: Promise.resolve(searchParams) }));
}

it('identifies the packaged immutable library and routes assessment through saved engagement', async () => {
  const view = await html();
  expect(view).toContain(`Packaged control library version ${LIBRARY_VERSION}`);
  expect(view).toContain(`Showing <strong>${controls.length}</strong> of ${controls.length} controls`);
  expect(view).toContain('&quot;actionHref&quot;:&quot;/assessment&quot;');
  expect(view).not.toContain('Execute Parikshan Audit Run');
  expect(view).not.toContain('v25.11.2');
  expect(view).not.toContain('Multi-framework overlays');
});

it('filters source controls without manufactured fallback counts or citations', async () => {
  const selected = controls[0];
  if (!selected) throw new Error('Control library fixture is empty');
  const view = await html({ domain: selected.domain, severity: selected.severity, q: selected.id });
  expect(view).toContain(`Showing <strong>1</strong> of ${controls.length} controls`);
  expect(view).toContain(selected.title);
  expect(view).toContain(selected.citations[0]?.reference);
  expect(view).toContain('Clear');
});

it('shows zero matched controls instead of substituting another version', async () => {
  const view = await html({ q: 'not-a-real-control' });
  expect(view).toContain(`Showing <strong>0</strong> of ${controls.length} controls`);
  expect(view).not.toContain('DPDPA-GOV-001</code>');
});
