'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { dataFlowConfiguration } from '@axiom/types';
import { requestDataFlow } from './flow-transport';
/** The actual authenticated BFF flag controls discoverability. It proves
 * configuration only; the destination independently reads current sources. */
export function DataFlowAvailability({ tenantId, actorId }: { tenantId: string; actorId: string }) {
  const [available, setAvailable] = useState<string | null>(null);
  const scope = tenantId + ':' + actorId;
  useEffect(() => {
    let live = true;
    void requestDataFlow(tenantId, actorId, '/data-flows/configuration')
      .then((raw) => {
        const v = dataFlowConfiguration.parse(z.object({ data: z.unknown() }).parse(raw).data);
        if (live && v.tenantId === tenantId && v.actorId === actorId)
          setAvailable(v.enabled ? tenantId + ':' + actorId : null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [tenantId, actorId]);
  return available === scope ? (
    <Link href="/datamap/flows" className="text-teal-700 underline">
      Inspect reviewed data flow declarations
    </Link>
  ) : null;
}
