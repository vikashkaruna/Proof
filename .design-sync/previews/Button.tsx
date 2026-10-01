import { Button } from '@axiom/ui';

const row = { display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' } as const;

export const Variants = () => (
  <div style={row}>
    <Button variant="primary">Approve plan</Button>
    <Button variant="accent">Run assessment</Button>
    <Button variant="outline">Download report</Button>
    <Button variant="ghost">Cancel</Button>
    <Button variant="danger">Reject plan</Button>
    <Button variant="link">View ledger entry</Button>
  </div>
);

export const SealedProof = () => (
  <div style={row}>
    <Button variant="proof">Seal evidence pack</Button>
  </div>
);

export const Sizes = () => (
  <div style={row}>
    <Button size="sm">Small</Button>
    <Button size="md">Medium</Button>
    <Button size="lg">Large</Button>
  </div>
);

export const Disabled = () => (
  <div style={row}>
    <Button variant="primary" disabled>
      Approve plan
    </Button>
    <Button variant="outline" disabled>
      Download report
    </Button>
  </div>
);
