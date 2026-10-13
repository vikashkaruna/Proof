import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import Home from './page';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

it('offers the founder Workbench and the client-organisation portal as separate doors', () => {
  const html = renderToStaticMarkup(<Home />);
  expect(html).toContain('href="/workbench"');
  expect(html).toContain('Open Workbench');
  expect(html).toContain('For the Axiom founder');
  expect(html).toContain('href="/portal"');
  expect(html).toContain('Client Portal');
  expect(html).toContain('For client organisations');
  // The header shortcut goes through the role-aware landing.
  expect(html).toContain('href="/start"');
  expect(html).not.toContain('href="/dashboard"');
});
