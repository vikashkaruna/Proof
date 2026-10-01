import { PostureScore } from '@axiom/ui';

export const Large = () => (
  <div style={{ width: 360 }}>
    <PostureScore score={72} exposureInr={125000000} />
  </div>
);

export const AtRisk = () => (
  <div style={{ width: 360 }}>
    <PostureScore score={48} exposureInr={450000000} />
  </div>
);

export const Strong = () => (
  <div style={{ width: 360 }}>
    <PostureScore score={91} />
  </div>
);

export const Compact = () => (
  <div style={{ width: 240, display: 'flex', flexDirection: 'column', gap: 10 }}>
    <PostureScore variant="compact" score={91} />
    <PostureScore variant="compact" score={72} />
    <PostureScore variant="compact" score={48} />
    <PostureScore variant="compact" score={22} />
  </div>
);
