import { Input, Label } from '@axiom/ui';

const field = { display: 'flex', flexDirection: 'column' as const, gap: 6, width: 340 };

export const ConnectorEndpoint = () => (
  <div style={field}>
    <Label htmlFor="ep" required>
      Connector endpoint identifier
    </Label>
    <Input id="ep" defaultValue="crm-prod-mumbai-01" />
  </div>
);

export const Empty = () => (
  <div style={field}>
    <Label htmlFor="ep2">Data fiduciary contact email</Label>
    <Input id="ep2" placeholder="dpo@example.in" />
  </div>
);

export const Invalid = () => (
  <div style={field}>
    <Label htmlFor="ep3" required>
      Connector endpoint identifier
    </Label>
    <Input id="ep3" invalid defaultValue="crm prod!" />
    <span style={{ fontSize: 12, color: '#D9534F' }}>
      Use lowercase letters, digits and hyphens only.
    </span>
  </div>
);

export const Disabled = () => (
  <div style={field}>
    <Label htmlFor="ep4">Processing region</Label>
    <Input id="ep4" disabled defaultValue="ap-south-1" />
  </div>
);
