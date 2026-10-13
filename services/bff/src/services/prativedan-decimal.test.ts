import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { prativedanFixedDecimal } from './prativedan-decimal.js';

const fixture = z
  .object({
    producer: z.string(),
    cases: z.array(
      z
        .object({
          value: z.number(),
          places: z.union([z.literal(0), z.literal(2)]),
          expected: z.string(),
        })
        .strict(),
    ),
  })
  .strict()
  .parse(
    JSON.parse(
      readFileSync(
        new URL('../../../../tests/contracts/prativedan-decimal.python.json', import.meta.url),
        'utf8',
      ),
    ),
  );

describe('pinned Python renderer decimal parity', () => {
  it('preserves the Python sign of negative zero', () => {
    expect(prativedanFixedDecimal(-0, 0)).toBe('-0');
    expect(prativedanFixedDecimal(-0, 2)).toBe('-0.00');
  });
  it.each(fixture.cases)(
    'matches actual Python for $value at $places places',
    ({ value, places, expected }) => {
      expect(prativedanFixedDecimal(value, places)).toBe(expected);
    },
  );
  it.each([NaN, Infinity, -Infinity, -1])('refuses invalid renderer value %s', (value) => {
    expect(() => prativedanFixedDecimal(value, 2)).toThrow(RangeError);
  });
});
