import { describe, expect, it } from 'vitest';
import { safeRedirectPath } from './safe-redirect';

describe('safeRedirectPath', () => {
  it('keeps same-origin paths, including the invitation page', () => {
    expect(safeRedirectPath('/invite')).toBe('/invite');
    expect(safeRedirectPath('/plans/1?tab=2')).toBe('/plans/1?tab=2');
  });
  it.each([
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    '/\t/evil.example',
    'javascript:alert(1)',
    '',
    undefined,
    42,
  ])('refuses %s', (value) => {
    expect(safeRedirectPath(value)).toBe('/dashboard');
  });
});
