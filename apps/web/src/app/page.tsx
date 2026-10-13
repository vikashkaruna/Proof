import Link from 'next/link';
import { BRAND } from '@axiom/config';
import { AxiomLogo, Button } from '@axiom/ui';

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2">
            <AxiomLogo size="sm" theme="light" showSubtitle={true} />
          </Link>
          <nav className="flex items-center gap-2">
            <Button variant="ghost" size="sm" asChild>
              <Link href="/login">Sign in</Link>
            </Button>
            <Button variant="accent" size="sm" asChild>
              <Link href="/start">Open App</Link>
            </Button>
          </nav>
        </div>
      </header>

      <main className="mx-auto flex max-w-7xl flex-1 flex-col items-center justify-center px-4 py-16 text-center sm:px-6">
        <h1 className="font-heading text-4xl font-semibold tracking-tight text-indigo-500 sm:text-5xl">
          {BRAND.name}
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-slate-600">{BRAND.tagline}</p>
        <p className="mt-2 max-w-2xl text-sm text-slate-500">
          The agentic DPDPA compliance platform for Indian mid-market enterprises. Discover. Assess.
          Remediate. <span className="text-gold-700">Prove.</span>
        </p>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          {/* Two doors, two audiences (ARCH-01 §3.1). The Workbench is the Axiom
              founder's cross-client cockpit and refuses everyone else to the
              Client Portal; the portal is every client-organisation user's view. */}
          <div className="flex flex-col items-center gap-1.5">
            <Button variant="accent" size="lg" asChild>
              <Link href="/workbench">Open Workbench</Link>
            </Button>
            <span className="text-xs text-slate-500">For the Axiom founder</span>
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <Button variant="outline" size="lg" asChild>
              <Link href="/portal">Client Portal</Link>
            </Button>
            <span className="text-xs text-slate-500">For client organisations</span>
          </div>
        </div>
      </main>

      <footer className="border-t border-slate-200 bg-white py-6">
        <div className="mx-auto max-w-7xl px-4 text-center text-xs text-slate-500 sm:px-6">
          {BRAND.copyright} · {BRAND.website}
        </div>
      </footer>
    </div>
  );
}
