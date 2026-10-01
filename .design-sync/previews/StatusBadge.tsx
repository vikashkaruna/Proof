import { StatusBadge } from '@axiom/ui';

const row = { display: 'flex', gap: 8, flexWrap: 'wrap' as const, width: 420 };

export const ApprovalFlow = () => (
  <div style={row}>
    <StatusBadge status="draft" />
    <StatusBadge status="dry_run_complete" />
    <StatusBadge status="awaiting_approval" />
    <StatusBadge status="approved" />
    <StatusBadge status="succeeded" />
  </div>
);

export const Failures = () => (
  <div style={row}>
    <StatusBadge status="failed" />
    <StatusBadge status="dry_run_failed" />
    <StatusBadge status="rolled_back" />
    <StatusBadge status="timed_out" />
    <StatusBadge status="rejected" />
  </div>
);

export const ControlResults = () => (
  <div style={row}>
    <StatusBadge status="pass" />
    <StatusBadge status="gap" />
    <StatusBadge status="compliant" />
    <StatusBadge status="non_compliant" />
    <StatusBadge status="skipped" />
  </div>
);

export const SealedEvidence = () => (
  <div style={row}>
    <StatusBadge status="sealed" />
    <StatusBadge status="issued" />
    <StatusBadge status="revoked" />
  </div>
);
