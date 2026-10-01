import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DataPlaceholder } from './DataPlaceholder';
import { PageHeader } from './Layout';
import { ModuleBar } from './ModuleBar';
import { RelatedAgents } from './RelatedAgents';

const html = (element: React.ReactElement) => renderToStaticMarkup(element);
// Agent icons inline every agent's animation keyframes, so judge visible markup only.
const visible = (markup: string) => markup.replace(/<style>[\s\S]*?<\/style>/g, '');

describe('related agents strip', () => {
  it('names each agent and states the approval rule, but never a live status', () => {
    const markup = html(<RelatedAgents agents={['drishti', 'parikshan']} />);
    expect(markup).toContain('Agents on this module');
    expect(markup).toContain('drishti');
    expect(markup).toContain('parikshan');
    expect(markup).toContain('nothing changes without a recorded human approval');
    expect(visible(markup)).not.toMatch(/online|healthy|running|offline|idle|working|thinking/i);
  });

  it('titles each agent with its persona, never with a state', () => {
    const markup = html(<RelatedAgents agents={['drishti']} />);
    expect(markup).toContain('title="Discovery"');
    expect(markup).not.toContain('(idle)');
  });

  it('renders nothing when a module has no agents', () => {
    expect(html(<RelatedAgents agents={[]} />)).toBe('');
  });
});

describe('module context line', () => {
  it('shows the Hindi name, phase and module id without adding a heading', () => {
    const markup = html(
      <ModuleBar crumb="Execute" titleHi="अनुमोदन कंसोल" phase="P3" moduleId="M3.3" />,
    );
    expect(markup).toContain('lang="hi"');
    expect(markup).toContain('अनुमोदन कंसोल');
    expect(markup).toContain('Delivery phase');
    expect(markup).toContain('P3');
    expect(markup).toContain('Module </span>M3.3');
    expect(markup).toContain('M3.3');
    expect(markup).toContain('Execute');
    expect(markup).not.toMatch(/<h[1-6]/);
  });

  it('switches to light-on-dark text for dark banners', () => {
    const dark = html(
      <ModuleBar crumb="Operate" titleHi="अ" phase="P0" agents={['karya']} tone="dark" />,
    );
    expect(dark).toContain('text-slate-300');
    expect(dark).toContain('text-white');
    const light = html(<ModuleBar crumb="Operate" titleHi="अ" phase="P0" agents={['karya']} />);
    expect(light).not.toContain('text-white');
  });

  it('renders nothing when given nothing', () => {
    expect(html(<ModuleBar />)).toBe('');
  });

  it('includes the agents strip only when agents are given', () => {
    expect(html(<ModuleBar phase="P0" />)).not.toContain('related-agents');
    expect(html(<ModuleBar phase="P0" agents={['karya']} />)).toContain('related-agents');
  });
});

describe('page header with module context', () => {
  it('keeps the heading to the title and puts the context in the header', () => {
    const markup = html(
      <PageHeader
        title="Approval queue"
        module={{ titleHi: 'अनुमोदन कतार', phase: 'P3', agents: ['karya'] }}
      />,
    );
    expect(markup).toMatch(/<h1[^>]*>Approval queue<\/h1>/);
    expect(markup).toContain('data-testid="module-bar"');
    expect(markup.indexOf('</h1>')).toBeLessThan(markup.indexOf('module-bar'));
  });

  it('is unchanged for pages that give no module context', () => {
    expect(html(<PageHeader title="Plans" />)).not.toContain('module-bar');
  });
});

describe('data placeholder', () => {
  it('says plainly that data is yet to be populated, as a status', () => {
    const markup = html(<DataPlaceholder />);
    expect(markup).toContain('Data yet to be populated');
    expect(markup).toContain('role="status"');
    expect(markup.replace(/<[^>]*>/g, '')).not.toMatch(/\d/);
  });

  it('accepts a specific title and explanation', () => {
    const markup = html(
      <DataPlaceholder title="No evidence recorded" description="Nothing yet." />,
    );
    expect(markup).toContain('No evidence recorded');
    expect(markup).toContain('Nothing yet.');
  });
});
