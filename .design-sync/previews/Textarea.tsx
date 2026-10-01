import { Label, Textarea } from '@axiom/ui';

const field = { display: 'flex', flexDirection: 'column' as const, gap: 6, width: 380 };

export const EvidenceDescription = () => (
  <div style={field}>
    <Label htmlFor="t1" required>
      Evidence description
    </Label>
    <Textarea
      id="t1"
      defaultValue="Consent log export for the March cohort, covering notice version 4 and withdrawal events."
    />
  </div>
);

export const Empty = () => (
  <div style={field}>
    <Label htmlFor="t2">DSAR request details</Label>
    <Textarea id="t2" placeholder="Describe the data principal's request" />
  </div>
);

export const Invalid = () => (
  <div style={field}>
    <Label htmlFor="t3" required>
      Approval reason
    </Label>
    <Textarea id="t3" invalid />
    <span style={{ fontSize: 12, color: '#D9534F' }}>A reason is required before approving.</span>
  </div>
);

export const Disabled = () => (
  <div style={field}>
    <Label htmlFor="t4">Sealed attestation note</Label>
    <Textarea id="t4" disabled defaultValue="Locked after sealing." />
  </div>
);
