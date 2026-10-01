import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentLabel } from './AgentLabel';

const html = (element: React.ReactElement) => renderToStaticMarkup(element);
// Agent icons inline every agent's animation keyframes, so judge visible markup only.
const visible = (markup: string) => markup.replace(/<style>[\s\S]*?<\/style>/g, '');

describe('agent label', () => {
  it('shows the icon before the name, static by default', () => {
    const markup = html(<AgentLabel agent="drishti" />);
    expect(markup).toContain('data-state="idle"');
    expect(markup.indexOf('<svg')).toBeGreaterThan(-1);
    expect(markup.indexOf('<svg')).toBeLessThan(markup.indexOf('>drishti<'));
    expect(visible(markup)).toContain('>drishti<');
  });

  it('does not claim a status for a static icon, and names the persona instead', () => {
    const markup = visible(html(<AgentLabel agent="drishti" />));
    expect(markup).toContain('title="Discovery"');
    expect(markup).not.toMatch(/\(idle\)|working|thinking/);
  });

  it('only says what the agent is doing when a live state is passed', () => {
    expect(visible(html(<AgentLabel agent="karya" state="working" />))).toContain(
      'title="karya (working)"',
    );
    expect(visible(html(<AgentLabel agent="karya" state="thinking" />))).toContain(
      'title="karya (thinking)"',
    );
  });

  it('switches to light-on-dark text for banners and can append the persona', () => {
    const dark = visible(html(<AgentLabel agent="lekha" tone="dark" showPersona />));
    expect(dark).toContain('text-white');
    expect(dark).toContain('· Audit');
    const light = visible(html(<AgentLabel agent="lekha" />));
    expect(light).not.toContain('text-white');
    expect(light).not.toContain('· Audit');
  });
});
