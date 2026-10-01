import { SeverityChip } from '@axiom/ui';

const row = { display: 'flex', gap: 8, flexWrap: 'wrap' as const, width: 420 };

export const AllSeverities = () => (
  <div style={row}>
    <SeverityChip severity="critical" />
    <SeverityChip severity="high" />
    <SeverityChip severity="medium" />
    <SeverityChip severity="low" />
  </div>
);

export const WithoutSymbol = () => (
  <div style={row}>
    <SeverityChip severity="critical" showSymbol={false} />
    <SeverityChip severity="high" showSymbol={false} />
    <SeverityChip severity="medium" showSymbol={false} />
    <SeverityChip severity="low" showSymbol={false} />
  </div>
);

export const InFindingRow = () => (
  <div
    style={{
      width: 420,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '10px 12px',
      border: '1px solid #e2e8f0',
      borderRadius: 8,
      fontSize: 14,
    }}
  >
    <span>Consent records retained beyond stated purpose (Example tenant)</span>
    <SeverityChip severity="high" />
  </div>
);
