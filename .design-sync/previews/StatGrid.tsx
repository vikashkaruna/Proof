import { Stat, StatGrid } from '@axiom/ui';

export const Overview = () => (
  <div style={{ width: 640 }}>
    <StatGrid>
      <Stat label="Posture score" value="72" hint="Example tenant" />
      <Stat label="Open findings" value="14" hint="Illustrative" />
      <Stat label="Awaiting approval" value="3" hint="Illustrative" />
      <Stat label="Consent records" value="48,210" hint="Illustrative" />
    </StatGrid>
  </div>
);

export const TwoStats = () => (
  <div style={{ width: 640 }}>
    <StatGrid>
      <Stat label="Data principals requests" value="9" hint="Example tenant" />
      <Stat label="Breach notifications" value="0" hint="Example tenant" />
    </StatGrid>
  </div>
);
