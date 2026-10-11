'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@axiom/ui';

interface VerifyButtonProps {
  tenantId?: string;
}

export function VerifyButton({ tenantId }: VerifyButtonProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const headers: Record<string, string> = {};
      if (tenantId) {
        headers['X-Tenant-Id'] = tenantId;
      }
      const res = await fetch('/api/bff/v1/ledger/verify', {
        method: 'POST',
        headers,
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(
          body?.error?.message || `Verification request failed with status ${res.status}`,
        );
      }

      if (body.intact === true) {
        alert('Chain verified: every entry hash and prev_hash matches. Audit trail is intact.');
      } else if (body.firstBreak) {
        alert(`Chain break at sequence ${body.firstBreak.sequenceNo}: ${body.firstBreak.reason}`);
      } else {
        alert('Verification status: ' + JSON.stringify(body));
      }
      router.refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Verification failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={run} loading={busy} data-primary>
      Verify chain integrity
    </Button>
  );
}
