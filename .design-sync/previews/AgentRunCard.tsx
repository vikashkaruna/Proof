import { AgentRunCard, Button } from '@axiom/ui';

const ago = (m: number) => new Date(Date.now() - m * 60000).toISOString();

export const Canonical = () => (
  <div style={{ width: 580 }}>
    <AgentRunCard
      agent="sudhaar"
      step="Drafting remediation plan"
      message="Plan for control DPDPA-8.2 (breach notification) drafted for tenant Meridian Health. Awaiting dry-run before approval."
      status="awaiting_dry_run"
      startedAt={ago(12)}
      progress={0.6}
      actions={
        <Button variant="outline" size="sm">
          Open plan
        </Button>
      }
    />
  </div>
);

export const StatusSweep = () => (
  <div style={{ width: 580, display: 'flex', flexDirection: 'column', gap: 12 }}>
    <AgentRunCard
      agent="drishti"
      step="Data discovery"
      message="Scanned 14 data stores in ap-south-1."
      status="succeeded"
      startedAt={ago(180)}
      progress={1}
    />
    <AgentRunCard
      agent="parikshan"
      step="Control testing"
      message="2 of 31 controls failed their checks."
      status="failed"
      startedAt={ago(95)}
      progress={0.8}
    />
    <AgentRunCard
      agent="karya"
      step="Applying consent-banner fix"
      status="awaiting_approval"
      startedAt={ago(30)}
      actions={
        <Button variant="primary" size="sm">
          Review
        </Button>
      }
    />
  </div>
);

export const Minimal = () => (
  <div style={{ width: 580 }}>
    <AgentRunCard agent="lekha" status="draft" />
  </div>
);
