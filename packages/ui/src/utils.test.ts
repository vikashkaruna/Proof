import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  cn,
  formatINR,
  formatINRFull,
  formatINRCrore,
  formatPercent,
  formatDate,
  formatDateTime,
  relativeTime,
  truncateHash,
  generateUUID,
} from './utils';

describe('UI utils', () => {
  describe('cn', () => {
    it('merges class names correctly', () => {
      expect(cn('p-4', 'bg-white', false && 'hidden', undefined, 'p-2')).toBe('bg-white p-2');
    });
  });

  describe('formatINRCrore', () => {
    it('reads rupees in crores with at most three decimals', () => {
      expect(formatINRCrore(1_85_00_00_000)).toBe('₹185 Cr');
      expect(formatINRCrore(1_87_50_000)).toBe('₹1.875 Cr');
      expect(formatINRCrore(1_23_45_678)).toBe('₹1.235 Cr');
      expect(formatINRCrore(25_00_00_00_000)).toBe('₹2,500 Cr');
      expect(formatINRCrore(0)).toBe('₹0 Cr');
      expect(formatINRCrore(1_000)).toBe('< ₹0.001 Cr');
      expect(formatINRCrore(null)).toBe('—');
    });
  });

  describe('formatINR', () => {
    it('handles null and undefined', () => {
      expect(formatINR(null)).toBe('—');
      expect(formatINR(undefined)).toBe('—');
    });

    it('formats small amounts', () => {
      expect(formatINR(500)).toBe('₹500');
    });

    it('formats thousands (k)', () => {
      expect(formatINR(1500)).toBe('₹1.5k');
      expect(formatINR(50000)).toBe('₹50.0k');
    });

    it('formats lakhs (L)', () => {
      expect(formatINR(250000)).toBe('₹2.50 L');
      expect(formatINR(1000000)).toBe('₹10.00 L');
    });

    it('formats crores (Cr)', () => {
      expect(formatINR(250000000)).toBe('₹2.50 Cr');
      expect(formatINR(1000000000)).toBe('₹10.00 Cr');
    });
  });

  describe('formatINRFull', () => {
    it('handles null and undefined', () => {
      expect(formatINRFull(null)).toBe('—');
      expect(formatINRFull(undefined)).toBe('—');
    });

    it('formats full currency strings', () => {
      const formatted = formatINRFull(125000);
      expect(formatted).toContain('1,25,000');
    });
  });

  describe('formatPercent', () => {
    it('handles null and undefined', () => {
      expect(formatPercent(null)).toBe('—');
      expect(formatPercent(undefined)).toBe('—');
    });

    it('formats percentages with default and custom digits', () => {
      expect(formatPercent(45.678)).toBe('46%');
      expect(formatPercent(45.678, 2)).toBe('45.68%');
    });
  });

  describe('formatDate and formatDateTime', () => {
    it('handles null, undefined, and invalid ISO dates', () => {
      expect(formatDate(null)).toBe('—');
      expect(formatDate(undefined)).toBe('—');
      expect(formatDate('invalid-date')).toBe('—');

      expect(formatDateTime(null)).toBe('—');
      expect(formatDateTime(undefined)).toBe('—');
      expect(formatDateTime('invalid-date')).toBe('—');
    });

    it('formats valid ISO dates', () => {
      const iso = '2026-09-28T10:30:00.000Z';
      expect(formatDate(iso)).toMatch(/2026/);
      expect(formatDateTime(iso)).toMatch(/2026/);
    });
  });

  describe('relativeTime', () => {
    let nowSpy: any;

    beforeEach(() => {
      nowSpy = vi
        .spyOn(Date, 'now')
        .mockReturnValue(new Date('2026-09-28T12:00:00.000Z').getTime());
    });

    afterEach(() => {
      nowSpy.mockRestore();
    });

    it('handles null, undefined, and invalid date', () => {
      expect(relativeTime(null)).toBe('—');
      expect(relativeTime(undefined)).toBe('—');
      expect(relativeTime('invalid-date')).toBe('—');
    });

    it('returns seconds ago', () => {
      const past = new Date('2026-09-28T11:59:45.000Z').toISOString();
      expect(relativeTime(past)).toBe('15s ago');
    });

    it('returns minutes ago', () => {
      const past = new Date('2026-09-28T11:45:00.000Z').toISOString();
      expect(relativeTime(past)).toBe('15m ago');
    });

    it('returns hours ago', () => {
      const past = new Date('2026-09-28T09:00:00.000Z').toISOString();
      expect(relativeTime(past)).toBe('3h ago');
    });

    it('returns days ago', () => {
      const past = new Date('2026-09-23T12:00:00.000Z').toISOString();
      expect(relativeTime(past)).toBe('5d ago');
    });

    it.each([
      ['2026-09-28T12:00:15.000Z', 'in 15s'],
      ['2026-09-28T12:00:59.999Z', 'in 59s'],
      ['2026-09-28T12:01:00.000Z', 'in 1m'],
      ['2026-09-28T12:15:00.000Z', 'in 15m'],
      ['2026-09-28T13:00:00.000Z', 'in 1h'],
      ['2026-09-28T15:00:00.000Z', 'in 3h'],
      ['2026-09-29T12:00:00.000Z', 'in 1d'],
      ['2026-10-03T12:00:00.000Z', 'in 5d'],
    ])('shows future deadlines %s as %s', (deadline, expected) => {
      expect(relativeTime(deadline)).toBe(expected);
    });

    it('keeps current timestamps nonnegative', () => {
      expect(relativeTime('2026-09-28T12:00:00.000Z')).toBe('0s ago');
      expect(relativeTime('2026-09-28T12:00:00.999Z')).toBe('in 0s');
    });

    it('shows the absolute date for distant future deadlines', () => {
      const future = '2026-11-28T12:00:00.000Z';
      expect(relativeTime(future)).toBe(formatDate(future));
      expect(relativeTime(future)).not.toContain('ago');
    });

    it('falls back to formatDate for >30 days', () => {
      const past = new Date('2026-01-01T12:00:00.000Z').toISOString();
      expect(relativeTime(past)).toMatch(/2026/);
    });
  });

  describe('truncateHash', () => {
    it('returns short hash unmodified', () => {
      expect(truncateHash('abcdef', 4)).toBe('abcdef');
    });

    it('truncates long hash with ellipsis', () => {
      const longHash = 'abcdef0123456789abcdef0123456789';
      expect(truncateHash(longHash, 4)).toBe('abcd…6789');
    });
  });

  describe('generateUUID', () => {
    it('generates a valid UUID v4', () => {
      const id = generateUUID();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });
  });
});
