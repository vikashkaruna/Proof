import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import preset from './tailwind';

// A preset that sets theme.colors replaces Tailwind's palette: a utility such as
// bg-red-50 then generates no CSS and the element renders unstyled, silently. This walks
// the code that consumes the preset and fails when it uses a colour family the preset lacks.
const ROOT = resolve(__dirname, '../../..');
const SOURCES = ['apps/web/src', 'apps/marketing/src', 'packages/ui/src'];
const UTILITY =
  /\b(?:bg|text|border|ring|fill|stroke|from|to|via|divide|outline|decoration|accent|caret|placeholder|shadow)-([a-z]+)-(?:50|100|200|300|400|500|600|700|800|900|950)\b/g;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === '.next' || name === 'dist') return [];
    if (statSync(path).isDirectory()) return files(path);
    return /\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const families = new Set(Object.keys((preset.theme?.colors ?? {}) as Record<string, unknown>));

describe('colour families used in code exist in the Tailwind preset', () => {
  it('knows the brand and status families', () => {
    for (const family of [
      'indigo',
      'teal',
      'gold',
      'ember',
      'slate',
      'mist',
      'red',
      'green',
      'amber',
    ])
      expect(families.has(family), family).toBe(true);
  });

  it('finds no utility whose family the preset lacks', () => {
    const missing = new Map<string, string[]>();
    for (const source of SOURCES) {
      for (const file of files(join(ROOT, source))) {
        for (const match of readFileSync(file, 'utf8').matchAll(UTILITY)) {
          const family = match[1]!;
          if (!families.has(family)) {
            const where = missing.get(family) ?? [];
            where.push(file.replace(`${ROOT}/`, ''));
            missing.set(family, where);
          }
        }
      }
    }
    expect(
      Object.fromEntries(
        [...missing].map(([family, where]) => [family, [...new Set(where)].slice(0, 3)]),
      ),
    ).toEqual({});
  });

  it('keeps gold for sealed evidence: the warning badge no longer uses it', () => {
    const badge = readFileSync(join(ROOT, 'packages/ui/src/primitives/Badge.tsx'), 'utf8');
    expect(badge).toMatch(/warning:\s*'[^']*amber/);
    expect(badge).not.toMatch(/warning:\s*'[^']*gold/);
  });
});
