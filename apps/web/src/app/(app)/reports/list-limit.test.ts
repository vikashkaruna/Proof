import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SOURCE_REPORT_PAGE_SIZE } from './report-contract';

// The BFF caps every report/evidence list at 50 and answers more with 400.
const BFF_LIST_MAXIMUM = 50;

it('never requests a list page larger than the BFF accepts', () => {
  expect(SOURCE_REPORT_PAGE_SIZE).toBeLessThanOrEqual(BFF_LIST_MAXIMUM);
  const files = readdirSync(__dirname).filter(
    (name) => /\.tsx?$/.test(name) && !name.endsWith('.test.ts') && !name.endsWith('.test.tsx'),
  );
  const literals: Array<{ file: string; limit: number }> = [];
  for (const file of files) {
    const text = readFileSync(join(__dirname, file), 'utf8');
    for (const match of text.matchAll(/limit=(\d+)/g))
      literals.push({ file, limit: Number(match[1]) });
  }
  expect(literals.length).toBeGreaterThan(0);
  expect(literals.filter((item) => item.limit > BFF_LIST_MAXIMUM)).toEqual([]);
});
