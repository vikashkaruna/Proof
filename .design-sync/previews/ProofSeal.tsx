import { ProofSeal } from '@axiom/ui';

const HASH = '9f2b7c41d8e03a65b1c4f7e2a9d0386c5e1b4a7f20d93c68e5a1b7f4c2d80e36';

export const Canonical = () => (
  <div style={{ width: 420 }}>
    <ProofSeal hash={HASH} sealedAt="2026-09-28T10:42:00+05:30" />
  </div>
);

export const Compact = () => <ProofSeal hash={HASH} compact />;

export const Unsealed = () => (
  <div style={{ width: 420 }}>
    <ProofSeal />
  </div>
);
