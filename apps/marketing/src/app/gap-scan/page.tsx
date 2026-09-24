import type { Metadata } from 'next';
import Link from 'next/link';
import { GapScanForm } from './form';
import { Card, CardContent, Badge } from '@axiom/ui';
import { CONTROL_LIBRARY_COUNT } from '@axiom/control-library';

export const metadata: Metadata = {
  title: 'Free 5-Minute DPDPA Gap-Scan | Axiom Proof',
  description:
    'Evaluate your organization against statutory DPDPA controls in 5 minutes. Get an instant posture score, exposure calculation, and Quarterly Readiness Index.',
};

export default function GapScanPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
      <div className="mb-6">
        <Link href="/" className="text-sm font-medium text-slate-500 hover:text-indigo-600">
          ← Back to home
        </Link>
      </div>

      <div className="text-center">
        <Badge variant="indigo" className="mb-3">
          Statutory Compliance Funnel
        </Badge>
        <h1 className="font-heading text-3xl font-bold tracking-tight text-indigo-500 sm:text-4xl">
          Free 5-minute DPDPA gap-scan
        </h1>
        <p className="mx-auto mt-3 max-w-2xl text-base text-slate-600 sm:text-lg">
          Answer 12 questions. Get a prioritised statutory compliance report scored against the same{' '}
          <strong className="text-slate-800">{CONTROL_LIBRARY_COUNT}-control library</strong> a paid
          enterprise audit engagement uses.
        </p>
      </div>

      <div className="mt-8 flex flex-wrap justify-center gap-4 text-xs text-slate-500">
        <span className="flex items-center gap-1.5">
          <svg
            className="h-4 w-4 text-teal-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          No live connectors required
        </span>
        <span className="flex items-center gap-1.5">
          <svg
            className="h-4 w-4 text-teal-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          Instant statutory scorecard
        </span>
        <span className="flex items-center gap-1.5">
          <svg
            className="h-4 w-4 text-teal-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          Indicative Readiness Benchmark
        </span>
      </div>

      <Card className="mt-8 shadow-sm">
        <CardContent className="p-6 sm:p-8">
          <GapScanForm />
        </CardContent>
      </Card>
    </div>
  );
}
