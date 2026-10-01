import { ProgressBar } from '@axiom/ui';

const col = { width: 360, display: 'flex', flexDirection: 'column' as const, gap: 14 };

export const Variants = () => (
  <div style={col}>
    <ProgressBar value={64} />
    <ProgressBar value={88} variant="proof" />
    <ProgressBar value={55} variant="warning" />
    <ProgressBar value={30} variant="danger" />
  </div>
);

export const Sizes = () => (
  <div style={col}>
    <ProgressBar value={60} size="sm" />
    <ProgressBar value={60} size="md" />
    <ProgressBar value={60} size="lg" />
  </div>
);

export const WithValue = () => (
  <div style={col}>
    <ProgressBar value={42} showValue />
    <ProgressBar value={78} variant="warning" showValue />
    <ProgressBar value={100} variant="proof" showValue />
  </div>
);
