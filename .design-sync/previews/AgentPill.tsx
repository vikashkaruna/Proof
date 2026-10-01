import { AgentPill } from '@axiom/ui';

export const Canonical = () => <AgentPill agent="parikshan" showPersona />;

export const AgentRoster = () => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, width: 520 }}>
    {(
      [
        'drishti',
        'vibhaag',
        'parikshan',
        'saakshi',
        'sudhaar',
        'karya',
        'samadhan',
        'lekha',
        'nazar',
        'prativedan',
        'pramaan',
        'sanket',
      ] as const
    ).map((a) => (
      <AgentPill key={a} agent={a} />
    ))}
  </div>
);

export const WithPersona = () => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, width: 520 }}>
    {(['drishti', 'sudhaar', 'lekha', 'pramaan'] as const).map((a) => (
      <AgentPill key={a} agent={a} showPersona />
    ))}
  </div>
);

export const StatesCaptioned = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    <div style={{ fontSize: 11, color: '#475569' }}>States (animation only for a real run)</div>
    {(['idle', 'thinking', 'working'] as const).map((s) => (
      <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ width: 64, fontSize: 11, color: '#475569' }}>{s}</span>
        <AgentPill agent="karya" state={s} />
      </div>
    ))}
  </div>
);
