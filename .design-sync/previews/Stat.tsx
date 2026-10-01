import { Stat } from '@axiom/ui';

export const Basic = () => (
  <div style={{ width: 240 }}>
    <Stat label="Open findings" value="14" hint="Example tenant" />
  </div>
);

export const NoHint = () => (
  <div style={{ width: 240 }}>
    <Stat label="Controls assessed" value="62 / 80" />
  </div>
);

export const RetentionWindow = () => (
  <div style={{ width: 240 }}>
    <Stat label="Evidence retention" value="7 years" hint="Illustrative value, Example tenant" />
  </div>
);
