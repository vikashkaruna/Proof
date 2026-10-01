import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
import HomePage from './page';
import AboutPage from './about/page';
import AgentsPage from './agents/page';
import PricingPage from './pricing/page';
import ContactPage from './contact/page';
import GapScanPage from './gap-scan/page';
import PrivacyPage from './privacy/page';
import TermsPage from './terms/page';
import { SiteHeader } from '@/components/SiteHeader';
import { SiteFooter } from '@/components/SiteFooter';

it.each([
  ['home', HomePage, ['gap-scan', 'DPDPA']],
  ['about', AboutPage, ['Axiom']],
  ['agents', AgentsPage, ['Agents']],
  ['pricing', PricingPage, ['Pricing']],
  ['contact', ContactPage, ['Contact']],
  ['gap scan', GapScanPage, ['Gap-Scan']],
  ['privacy', PrivacyPage, ['Privacy']],
  ['terms', TermsPage, ['Terms']],
] as const)('renders the %s public page with its key content', (_name, Page, content) => {
  const html = renderToStaticMarkup(<Page />);
  for (const expected of content) expect(html.toLowerCase()).toContain(expected.toLowerCase());
  expect(html).not.toContain('undefined');
});

it('renders navigation with a usable Workbench link and public footer links', () => {
  const header = renderToStaticMarkup(<SiteHeader />);
  const footer = renderToStaticMarkup(<SiteFooter />);
  expect(header).toContain('href="http://localhost:3001/login"');
  expect(header).toContain('href="/gap-scan"');
  expect(footer).toContain('href="/privacy"');
  expect(footer).toContain('href="/terms"');
});
