import { describe, it, expect } from 'vitest';
import { BRANDING } from './branding';
import { BRANDING as ROOT_BRANDING } from './index';

describe('Report-Kit Canonical Branding', () => {
  it('enforces exact institutional branding constants', () => {
    expect(BRANDING.company).toBe('Axiom Minds Private Limited');
    expect(BRANDING.website).toBe('https://axiomminds.ai');
    expect(BRANDING.product).toBe('Axiom Proof');
    expect(BRANDING.domain).toBe('https://axiomproof.ai');
    expect(BRANDING.workbench).toBe('https://app.axiomproof.ai');
    expect(BRANDING.tagline).toBe('Agents do the work. You approve. The proof is automatic.');
  });

  it('exports consistent branding from package entry point', () => {
    expect(ROOT_BRANDING.company).toBe('Axiom Minds Private Limited');
    expect(ROOT_BRANDING.website).toBe('https://axiomminds.ai');
    expect(ROOT_BRANDING.product).toBe('Axiom Proof');
    expect(ROOT_BRANDING.domain).toBe('https://axiomproof.ai');
  });
});
