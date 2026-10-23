import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { PageHeader } from '@axiom/ui';
import { requireCapabilityContext } from '@/lib/tenant-context';
import { moduleBarProps } from '@/lib/module-bar';
import { routeCapability } from '@/app/(app)/nav';
import { ScanReportClient } from './scan-report-client';

export const dynamic = 'force-dynamic';

export default async function ConnectorScanReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const ctx = await requireCapabilityContext(routeCapability('/connectors'));
  return (
    <div className="flex w-full min-w-0 flex-col gap-6">
      <PageHeader
        module={moduleBarProps('connectors')}
        title="Data discovery scan report"
        description="Personal data found by the latest supervised scan of this connector, with review prompts. Built from table and column names and counts of value shapes only."
      />
      <Link href="/connectors" className="text-sm font-medium text-teal-700 underline">
        Back to connectors
      </Link>
      <ScanReportClient key={ctx.tenantId + ':' + id} tenantId={ctx.tenantId} connectorId={id} />
    </div>
  );
}
