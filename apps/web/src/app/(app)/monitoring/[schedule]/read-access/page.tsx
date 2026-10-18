import Link from 'next/link';
import { requireCapabilityContext } from '@/lib/tenant-context';
import { routeCapability } from '@/app/(app)/nav';
import { z } from 'zod';
import { ReadAccessPanel } from './read-access-panel';
export const dynamic = 'force-dynamic';
export default async function ReadAccessPage({
  params,
}: {
  params: Promise<{ schedule: string }>;
}) {
  const ctx = await requireCapabilityContext(routeCapability('/monitoring'));
  const { schedule } = await params;
  const enabled =
    process.env.AXIOM_SCHEDULED_POSTGRESQL_READ_ENABLED === 'true' &&
    ['local', 'test'].includes(process.env.ENVIRONMENT ?? '') &&
    (process.env.AXIOM_AUTH_MODE ?? 'strict') === 'strict';
  return (
    <main className="space-y-5">
      <Link href="/monitoring">← Monitoring</Link>
      <h1 className="text-2xl font-semibold">Scheduled metadata rediscovery</h1>
      <p>
        Approve an expiring schedule to list PostgreSQL schemas and tables in an enrolled synthetic
        sandbox. This does not read personal data values or run a new compliance assessment.
      </p>
      {ctx.role !== 'owner' ? (
        <p>Only the organization owner can review and approve this read scope.</p>
      ) : !enabled ? (
        <p>Scheduled PostgreSQL rediscovery is unavailable in this deployment.</p>
      ) : (
        <ReadAccessPanel
          tenantId={ctx.tenantId}
          actorId={ctx.userId}
          scheduleId={z.uuid().parse(schedule)}
        />
      )}
    </main>
  );
}
