import { describe, it, expect } from 'vitest';
import {
  colors,
  agentAccents,
  fontFamily,
  fontSize,
  fontWeight,
  spacing,
  axiomPreset,
} from './index';

describe('Design tokens', () => {
  it('defines core brand color tokens correctly', () => {
    expect(colors.indigo[500]).toBe('#1E2A4A');
    expect(colors.teal[500]).toBe('#0FB5A5');
    expect(colors.gold[500]).toBe('#C9A227');
    expect(colors.ember[500]).toBe('#D9534F');
  });

  it('defines all 12 agent accent colors', () => {
    expect(agentAccents.drishti).toBe('#0FB5A5');
    expect(agentAccents.vibhaag).toBe('#7C3AED');
    expect(agentAccents.parikshan).toBe('#1E2A4A');
    expect(agentAccents.saakshi).toBe('#C9A227');
    expect(agentAccents.sudhaar).toBe('#0EA5E9');
    expect(agentAccents.karya).toBe('#D9534F');
    expect(agentAccents.samadhan).toBe('#0D9488');
    expect(agentAccents.lekha).toBe('#525B71');
    expect(agentAccents.nazar).toBe('#16A34A');
    expect(agentAccents.prativedan).toBe('#9333EA');
    expect(agentAccents.pramaan).toBe('#C9A227');
    expect(agentAccents.sanket).toBe('#EA580C');
  });

  it('defines typography tokens', () => {
    expect(fontFamily).toHaveProperty('heading');
    expect(fontFamily).toHaveProperty('body');
    expect(fontFamily).toHaveProperty('mono');
    expect(fontSize).toHaveProperty('base');
    expect(fontWeight).toHaveProperty('medium');
  });

  it('defines spacing scale', () => {
    expect(spacing[4]).toBe('1rem');
    expect(spacing[8]).toBe('2rem');
  });

  it('exports a valid Tailwind preset', () => {
    expect(axiomPreset.theme?.colors).toBeDefined();
    expect(axiomPreset.theme?.fontFamily).toBeDefined();
    expect(axiomPreset.theme?.extend?.spacing).toBeDefined();
  });
});
