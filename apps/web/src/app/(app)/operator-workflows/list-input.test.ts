import { describe, expect, it } from 'vitest';
import { parseListDeclaration } from './list-input';

describe('processing declaration truth', () => {
  it.each(['', ' ', '\n\t'])('preserves blank List as unknown: %j', (value) => {
    expect(parseListDeclaration('list', value)).toBeNull();
  });
  it('distinguishes explicit None and Unknown from named items', () => {
    expect(parseListDeclaration('none', '')).toEqual([]);
    expect(parseListDeclaration('unknown', '')).toBeNull();
    expect(parseListDeclaration('list', ' Vendor A , Vendor B ')).toEqual(['Vendor A', 'Vendor B']);
  });
  it.each([',', ' , , ', 'Vendor A,', ',Vendor B', 'Vendor A, ,Vendor B'])(
    'refuses unknown empty items in a nonempty list: %j',
    (value) => {
      expect(() => parseListDeclaration('list', value)).toThrow(/Remove empty items/);
    },
  );
  it.each(['', 'false', '[]', 'None'])('refuses unsupported declaration choices: %j', (mode) => {
    expect(() => parseListDeclaration(mode, '')).toThrow(/Choose List, Unknown or None/);
  });
});
