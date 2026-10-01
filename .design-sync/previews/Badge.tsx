import { Badge } from '@axiom/ui';

const row = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap' as const,
  alignItems: 'center',
  width: 420,
};

export const Variants = () => (
  <div style={row}>
    <Badge variant="neutral">Draft</Badge>
    <Badge variant="info">Dry-run</Badge>
    <Badge variant="success">Approved</Badge>
    <Badge variant="warning">Awaiting approval</Badge>
    <Badge variant="danger">Gap</Badge>
    <Badge variant="indigo">In review</Badge>
    <Badge variant="proof">Sealed</Badge>
  </div>
);

export const Sizes = () => (
  <div style={row}>
    <Badge size="sm" variant="info">
      Small
    </Badge>
    <Badge size="md" variant="info">
      Medium
    </Badge>
    <Badge size="lg" variant="info">
      Large
    </Badge>
  </div>
);

export const AgentBadges = () => (
  <div style={row}>
    <Badge agent="drishti">Drishti</Badge>
    <Badge agent="sudhaar">Sudhaar</Badge>
    <Badge agent="saakshi">Saakshi</Badge>
    <Badge agent="pramaan">Pramaan</Badge>
  </div>
);
