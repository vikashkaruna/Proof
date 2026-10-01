import { DataPlaceholder } from '@axiom/ui';

export const Default = () => (
  <div style={{ width: 420 }}>
    <DataPlaceholder />
  </div>
);

export const WithDescription = () => (
  <div style={{ width: 420 }}>
    <DataPlaceholder description="Nothing has been recorded for this panel yet. It will fill in once the first assessment completes." />
  </div>
);
