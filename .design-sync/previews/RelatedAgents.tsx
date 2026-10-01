import { RelatedAgents } from '@axiom/ui';

export const Canonical = () => (
  <div style={{ width: 420 }}>
    <RelatedAgents agents={['sudhaar', 'karya']} />
  </div>
);

export const CustomLabel = () => (
  <div style={{ width: 420 }}>
    <RelatedAgents agents={['drishti', 'vibhaag', 'parikshan']} label="Agents on this screen" />
  </div>
);

export const OnDarkBanner = () => (
  <div style={{ background: '#1E2A4A', padding: 20, borderRadius: 12, width: 420 }}>
    <RelatedAgents agents={['saakshi', 'pramaan']} tone="dark" />
  </div>
);
