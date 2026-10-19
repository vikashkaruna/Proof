'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AxiomLogo, Badge, Button, Card, PageHeader } from '@axiom/ui';
import { BRAND } from '@axiom/config/brand';
import { moduleBarProps } from '@/lib/module-bar';
import { BoardWorkflow } from '../board-workflow';
import { AuditorWorkflow } from '../auditor-workflow';
import { ReportInspector } from '../reports-client';

const reviewStages = [
  {
    title: 'Prepare the draft',
    detail: 'Choose a saved request below and generate its source-bound draft.',
  },
  {
    title: 'Review the content',
    detail: 'Open the exact draft and record your approval or rejection with a reason.',
  },
  {
    title: 'Retain and preview',
    detail: 'Build the approved source and PDF, then preview the exact retained version.',
  },
  {
    title: 'Release to readers',
    detail: 'Confirm release only after checking the retained PDF and its original receipt.',
  },
] as const;
export function FounderReportReviewClient(props: {
  tenantId: string;
  actorId: string;
  tenantName: string;
}) {
  return <FounderTenantReview key={`${props.tenantId}:${props.actorId}`} {...props} />;
}
function FounderTenantReview({
  tenantId,
  actorId,
  tenantName,
}: {
  tenantId: string;
  actorId: string;
  tenantName: string;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null),
    [refreshSignal, setRefreshSignal] = useState(0),
    review = useRef<HTMLElement>(null);
  const changed = useCallback(() => setRefreshSignal((n) => n + 1), []);
  useEffect(() => {
    if (selectedId) {
      review.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      review.current?.focus();
    }
  }, [selectedId]);
  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        title="Founder report review"
        module={{ ...moduleBarProps('reports'), phase: undefined, moduleId: undefined }}
        description={
          <>
            Review saved board and auditor requests for{' '}
            <strong className="[overflow-wrap:anywhere]">{tenantName}</strong>. Every decision
            applies to its exact saved version.
          </>
        }
      >
        <div className="mt-3 border-t border-white/15 pt-3">
          <AxiomLogo size="sm" theme="dark" variant="monochrome-light" role="presentation" />
        </div>
      </PageHeader>
      <Card role="region" aria-label="Founder report review guidance">
        <details className="group">
          <summary className="cursor-pointer rounded-xl p-4 text-sm font-semibold text-indigo-500 focus-visible:outline-2 focus-visible:outline-teal-600 sm:px-5">
            How review and release work
            <span className="mt-1 block text-xs font-normal leading-relaxed text-slate-600">
              Draft → Content approval → Retain and preview → Release
            </span>
          </summary>
          <div className="border-t border-slate-200 p-4 sm:p-5">
            <p className="text-sm leading-relaxed text-slate-600">
              Approval records your content decision. Retention stores the exact source and PDF.
              Release makes that retained version available to authorized readers.
            </p>
            <ol
              aria-label="Report review stages"
              className="mt-5 grid gap-5 sm:grid-cols-2 xl:grid-cols-4"
            >
              {reviewStages.map((stage, index) => (
                <li key={stage.title} className="flex min-w-0 items-start gap-3">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-teal-50 text-xs font-semibold text-teal-700">
                    {index + 1}
                  </span>
                  <div className="space-y-1">
                    <h3 className="text-sm font-semibold text-indigo-500">{stage.title}</h3>
                    <p className="text-sm leading-relaxed text-slate-600">{stage.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="mt-5 border-t border-slate-200 pt-4 text-sm leading-relaxed text-slate-600">
              If a build outcome is uncertain, reconcile its original receipt before continuing.
              Missing or unavailable records do not mean the work is complete.
            </p>
          </div>
        </details>
      </Card>
      <section aria-label="Selected organization report queues" className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Selected organization · report requests
            </p>
            <h2 className="break-words font-heading text-xl font-semibold text-indigo-500">
              Saved report requests
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-slate-600">
              Each organization has its own queue. Choose a saved request below. To review another
              organization, switch it in the application header.
            </p>
          </div>
          <nav aria-label="Report request queues" className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/reports">Working reports &amp; registers</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <a href="#founder-board-requests">Board queue</a>
            </Button>
            <Button asChild variant="outline" size="sm">
              <a href="#founder-auditor-requests">Auditor queue</a>
            </Button>
          </nav>
        </div>
        <div className="grid min-w-0 items-start gap-5 xl:grid-cols-2">
          <div
            id="founder-board-requests"
            tabIndex={-1}
            className="min-w-0 scroll-mt-6 [&_button]:max-w-full [&_button]:whitespace-normal [&_p]:[overflow-wrap:anywhere]"
          >
            <BoardWorkflow
              tenantId={tenantId}
              actorId={actorId}
              canRequest
              canManage
              existingRequestsOnly
              refreshSignal={refreshSignal}
              onOpenReport={setSelectedId}
              onChanged={changed}
            />
          </div>
          <div
            id="founder-auditor-requests"
            tabIndex={-1}
            className="min-w-0 scroll-mt-6 [&_button]:max-w-full [&_button]:whitespace-normal [&_p]:[overflow-wrap:anywhere]"
          >
            <AuditorWorkflow
              tenantId={tenantId}
              actorId={actorId}
              canRequest
              canManage
              existingRequestsOnly
              refreshSignal={refreshSignal}
              onOpenReport={setSelectedId}
              onChanged={changed}
            />
          </div>
        </div>
      </section>
      {selectedId && (
        <section
          ref={review}
          tabIndex={-1}
          aria-label="Exact report review"
          className="min-w-0 scroll-mt-6 space-y-4 rounded-xl border border-teal-200 bg-white p-4 shadow-sm focus-visible:outline-2 focus-visible:outline-teal-600 sm:p-6"
        >
          <div className="space-y-1 border-b border-slate-200 pb-4">
            <Badge variant="info">Selected report</Badge>
            <h2 className="font-heading text-lg font-semibold text-indigo-500">
              Review this exact draft
            </h2>
            <p className="text-sm text-slate-600">
              Inspect the saved content and source before recording a decision. Each action below
              keeps its own approval, retention and release checks.
            </p>
          </div>
          <ReportInspector
            key={`${tenantId}:${actorId}:${selectedId}`}
            tenantId={tenantId}
            actorId={actorId}
            reportId={selectedId}
            canPrepare={false}
            canReview
            canRelease
            canExport
            canRequestBoard={false}
            canManageBoard
            canReadSealed
            onChanged={changed}
            onRead={changed}
          />
        </section>
      )}
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4 text-xs leading-relaxed text-slate-500">
        <p>
          {BRAND.name} · {BRAND.company}
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <a
            className="rounded underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-teal-600"
            href={`https://${BRAND.primaryDomain}`}
          >
            {BRAND.primaryDomain}
          </a>
          <a
            className="rounded underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-teal-600"
            href={BRAND.website}
          >
            {BRAND.companyDomain}
          </a>
        </div>
      </footer>
    </main>
  );
}
