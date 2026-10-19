'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PageHeader } from '@axiom/ui';
import { moduleBarProps } from '@/lib/module-bar';
import { BoardWorkflow } from '../board-workflow';
import { AuditorWorkflow } from '../auditor-workflow';
import { ReportInspector } from '../reports-client';
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
    <main className="min-w-0 space-y-5">
      <PageHeader
        title="Founder report review"
        module={moduleBarProps('reports')}
        description={
          <>
            Saved report requests for <strong>{tenantName}</strong>. This workspace requires a
            current live platform founder and internal account; report reading for other roles
            remains separate.
          </>
        }
      />
      <section
        className="space-y-2 rounded-xl border border-slate-200 bg-white p-5"
        aria-label="Founder report review guidance"
      >
        <h2 className="font-semibold">Review the existing requests</h2>
        <p>
          Select a saved board or auditor request below. Generate its draft, open the exact draft
          for approval or rejection, then build and retain the reviewed source and PDF. Reconcile
          the original build if its outcome is uncertain; preview its exact retained PDF before
          confirming release.
        </p>
        <p>
          Each organization has its own queue. Switch organization in the application header to
          inspect its requests. Missing or unavailable records do not mean the work is complete.
          This page creates no replacement requests or automatic founder decisions.
        </p>
        <Link className="underline" href="/reports">
          Open report reader
        </Link>
      </section>
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
      {selectedId && (
        <section
          ref={review}
          tabIndex={-1}
          aria-label="Exact report review"
          className="min-w-0 space-y-3"
        >
          <h2 className="text-lg font-semibold">Review this exact draft</h2>
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
    </main>
  );
}
