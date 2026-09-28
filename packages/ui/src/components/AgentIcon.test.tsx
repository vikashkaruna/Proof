import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AgentIcon } from './AgentIcon';
import { AgentPill } from './AgentPill';
import type { AgentName } from '@axiom/design-tokens';

const AGENTS: AgentName[] = [
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
];

describe('AgentIcon Component', () => {
  it('renders all 12 agents in idle state', () => {
    for (const agent of AGENTS) {
      const html = renderToString(<AgentIcon agent={agent} state="idle" size="sm" />);
      expect(html).toContain(agent);
      expect(html).toContain('<svg');
    }
  });

  it('renders animated states: thinking and working', () => {
    const thinkingHtml = renderToString(<AgentIcon agent="drishti" state="thinking" size="md" />);
    expect(thinkingHtml).toContain('drishti (thinking)');

    const workingHtml = renderToString(
      <AgentIcon agent="saakshi" state="working" size="lg" showBadge />,
    );
    expect(workingHtml).toContain('saakshi (working)');
  });

  it('renders on-dark variant with high-contrast borders and accents', () => {
    const onDarkParikshan = renderToString(
      <AgentIcon agent="parikshan" state="working" size="xs" variant="on-dark" />,
    );
    expect(onDarkParikshan).toContain('rgba(255,255,255,0.2)');
    expect(onDarkParikshan).toContain('#818CF8'); // high-contrast light indigo

    const onDarkLekha = renderToString(
      <AgentIcon agent="lekha" state="working" size="xs" variant="on-dark" />,
    );
    expect(onDarkLekha).toContain('#94A3B8'); // high-contrast slate
  });

  it('renders bespoke SVGs for domain agent keys: policy, incident, dsar, consent', () => {
    const domainAgents = ['policy', 'policy_engine', 'incident', 'dsar', 'consent'] as const;
    for (const key of domainAgents) {
      const html = renderToString(<AgentIcon agent={key} size="xs" variant="on-dark" />);
      expect(html).toContain(key);
      expect(html).toContain('<svg');
    }
  });
});
