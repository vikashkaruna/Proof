'use client';

import Link from 'next/link';
import { Button, AxiomLogo } from '@axiom/ui';
import { useResolvedAppUrl } from '@/lib/use-resolved-app-url';

export function SiteHeader() {
  const appUrl = useResolvedAppUrl();

  return (
    <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-3">
          <AxiomLogo size="sm" theme="light" showSubtitle={true} />
        </Link>
        <nav className="flex items-center gap-1 sm:gap-3">
          <Link
            href="/#how-it-works"
            className="hidden text-sm text-slate-700 hover:text-indigo-500 sm:inline"
          >
            How it works
          </Link>
          <Link
            href="/agents"
            className="hidden text-sm text-slate-700 hover:text-indigo-500 sm:inline"
          >
            Agents
          </Link>
          <Link
            href="/pricing"
            className="hidden text-sm text-slate-700 hover:text-indigo-500 sm:inline"
          >
            Pricing
          </Link>
          <Link
            href="/about"
            className="hidden text-sm text-slate-700 hover:text-indigo-500 sm:inline"
          >
            About
          </Link>
          <Button variant="ghost" size="sm" asChild={false}>
            <Link href={`${appUrl}/login`}>Sign in</Link>
          </Button>
          <Button variant="accent" size="sm" asChild={false}>
            <Link href="/gap-scan">Free gap-scan</Link>
          </Button>
        </nav>
      </div>
    </header>
  );
}
