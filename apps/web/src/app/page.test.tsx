import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import Home from './page';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

it('offers one entry into the role-aware platform', () => {
  const html = renderToStaticMarkup(<Home />);
  expect(html).toContain('href="/dashboard"');
  expect(html).toContain('Open Workbench');
  expect(html).not.toContain('href="/portal"');
  expect(html).not.toContain('href="/workbench"');
});
