import { describe, expect, it } from 'vitest';
import { parseCatalogueJson } from './catalogue-json';

describe('portable exact catalogue JSON parsing', () => {
  it.each([
    '{"key":1,"key":2}',
    '{"key":1,"k\\u0065y":2}',
    '{"items":[{"note":1,"note":2}]}',
    '{"__proto__":1,"__proto__":2}',
    '{"key" \t\r\n:1,"key":2}',
  ])('refuses duplicate decoded names: %s', (text) => {
    expect(() => parseCatalogueJson(text, 1024)).toThrow('Duplicate catalogue JSON key');
  });
  it('allows identical names in separate objects and escaped content', () => {
    const value = { key: [{ note: '" } ] : \\ हिंदी' }, { note: '{ "note": 1 }' }] };
    expect(parseCatalogueJson(JSON.stringify(value, null, 2), 1024)).toEqual(value);
  });
  it.each(['{', '{"a":1,}', '{"a" 1}', '[1}', 'NaN'])(
    'refuses malformed native grammar: %s',
    (text) => {
      expect(() => parseCatalogueJson(text, 1024)).toThrow();
    },
  );
  it('counts UTF-8 bytes rather than UTF-16 code units without rewriting content', () => {
    const text = '"हिंदी"';
    const bytes = new TextEncoder().encode(text).byteLength;
    expect(parseCatalogueJson(text, bytes)).toBe('हिंदी');
    expect(() => parseCatalogueJson(text, bytes - 1)).toThrow('Catalogue JSON exceeds byte limit');
  });
  it('bounds lexical nesting and accepts the boundary', () => {
    const nested = (depth: number) => '['.repeat(depth) + '0' + ']'.repeat(depth);
    expect(() => parseCatalogueJson(nested(32), 1024)).not.toThrow();
    expect(() => parseCatalogueJson(nested(33), 1024)).toThrow(
      'Catalogue JSON exceeds depth limit',
    );
  });
});
