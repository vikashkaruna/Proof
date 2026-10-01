import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { agentAccents } from '@axiom/design-tokens';
import { MODULES, moduleMeta, type ModuleKey } from './module-meta';
import { ModuleContextFor } from './module-context';

const keys = Object.keys(MODULES) as ModuleKey[];

describe('module metadata', () => {
  it('covers the 21 design routes', () => {
    expect(keys).toHaveLength(21);
    for (const route of ['dashboard', 'approval', 'evidence', 'ledger', 'assessment', 'workbench'])
      expect(keys).toContain(route);
  });

  it('gives every module a Hindi name, a valid phase and only known agents', () => {
    for (const key of keys) {
      const meta = moduleMeta(key);
      expect(meta.title, key).not.toBe('');
      expect(meta.hi, key).toMatch(/[ऀ-ॿ]/);
      expect(meta.phase, key).toMatch(/^P[0-5]$/);
      for (const agent of meta.agents)
        expect(agentAccents, `${key}:${agent}`).toHaveProperty(agent);
      if (meta.moduleId) expect(meta.moduleId, key).toMatch(/^M\d\.\d{1,2}$/);
    }
  });

  it('keeps the module ids sourced from the plan and design for the marquee screens', () => {
    expect(moduleMeta('approval').moduleId).toBe('M3.3');
    expect(moduleMeta('assessment').moduleId).toBe('M0.3');
    expect(moduleMeta('workbench').moduleId).toBe('M0.6');
    expect(moduleMeta('ledger').moduleId).toBe('M2.5');
    expect(moduleMeta('evidence').moduleId).toBe('M2.4');
    expect(moduleMeta('dashboard').moduleId).toBeUndefined();
  });

  it('does not repeat a module id across modules', () => {
    const ids = keys.map((k) => moduleMeta(k).moduleId).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('ModuleContextFor', () => {
  it('renders the module’s section, Hindi name, phase, id and agents', () => {
    const markup = renderToStaticMarkup(<ModuleContextFor module="ledger" />);
    expect(markup).toContain('Evidence &amp; Audit');
    expect(markup).toContain(moduleMeta('ledger').hi);
    expect(markup).toContain('M2.5');
    expect(markup).toContain('saakshi');
    expect(markup).toContain('lekha');
  });

  it('shows no agents strip for a module with no named agent', () => {
    const markup = renderToStaticMarkup(<ModuleContextFor module="dashboard" />);
    expect(markup).not.toContain('related-agents');
    expect(markup).toContain('P0');
  });
});
