import { describe, expect, it } from 'vitest';
import { POSTURE_BANDS, postureBand } from './posture';

describe('postureBand', () => {
  it.each([
    [0, 'critical'],
    [39, 'critical'],
    [40, 'weak'],
    [59, 'weak'],
    [60, 'moderate'],
    [79, 'moderate'],
    [80, 'good'],
    [100, 'good'],
  ])('puts %s in the %s band', (score, key) => {
    expect(postureBand(score)?.key).toBe(key);
  });

  it('classifies nothing it cannot read as a score', () => {
    for (const score of [null, undefined, Number.NaN, -1, 101])
      expect(postureBand(score)).toBeNull();
  });

  it('never uses gold, which is reserved for sealed proof', () => {
    for (const band of POSTURE_BANDS)
      expect(`${band.text} ${band.onDark} ${band.chip} ${band.chipOnDark}`).not.toContain('gold');
  });
});
