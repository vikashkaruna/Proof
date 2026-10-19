import { notFound } from 'next/navigation';
import { z } from 'zod';
import { requireCapabilityContext } from '@/lib/tenant-context';
import { Capability } from '@axiom/types';
import { DataFlowClient } from '../flow-client';
export const dynamic = 'force-dynamic';
export default async function DeclarationHistoryPage({
  params,
}: {
  params: Promise<{ revisionId: string }>;
}) {
  const p = await params;
  if (!z.uuid().safeParse(p.revisionId).success) notFound();
  const c = await requireCapabilityContext(Capability.POSTURE_READ);
  return (
    <DataFlowClient
      key={`${c.tenantId}:${c.userId}:${p.revisionId}`}
      tenantId={c.tenantId}
      actorId={c.userId}
      initialRevisionId={p.revisionId}
    />
  );
}
