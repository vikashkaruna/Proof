import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DISPLAY_TIME_ZONE,
  displayLocalToInstant,
  formatClock,
  formatDate,
  formatDateTime,
  formatTime,
  instantToDisplayLocal,
  serverDisplayTimeZone,
  startOfDisplayDay,
} from './index';

// The e439 example: one instant, UTC date 15 Oct, IST date 16 Oct.
const INSTANT = '2026-10-15T20:09:10.457Z';

describe('display time', () => {
  it('defaults to India Standard Time and refuses an invalid configured zone', () => {
    expect(serverDisplayTimeZone({})).toBe(DEFAULT_DISPLAY_TIME_ZONE);
    expect(serverDisplayTimeZone({ AXIOM_DISPLAY_TIMEZONE: 'Europe/London' })).toBe(
      'Europe/London',
    );
    expect(() => serverDisplayTimeZone({ AXIOM_DISPLAY_TIMEZONE: 'Mars/Olympus' })).toThrow();
  });

  it('renders the IST calendar date and clock, independent of the host zone', () => {
    expect(formatDate(INSTANT, 'Asia/Kolkata')).toBe('16 Oct 2026');
    expect(formatTime(INSTANT, 'Asia/Kolkata')).toMatch(/^1:39\s?am$/i);
    expect(formatClock(INSTANT, 'Asia/Kolkata')).toMatch(/^1:39:10\s?am$/i);
    expect(formatDateTime(INSTANT, 'Asia/Kolkata')).toMatch(/^16 Oct 2026, 01:39 IST$/);
    expect(formatDate(INSTANT, 'UTC')).toBe('15 Oct 2026');
  });

  it('shows a dash for missing or invalid instants rather than "Invalid Date"', () => {
    expect(formatDateTime(null, 'Asia/Kolkata')).toBe('—');
    expect(formatDateTime('not-a-date', 'Asia/Kolkata')).toBe('—');
  });

  it('computes the start of the IST day, not the server-local one', () => {
    expect(startOfDisplayDay(new Date(INSTANT), 'Asia/Kolkata').toISOString()).toBe(
      '2026-10-15T18:30:00.000Z',
    );
    expect(startOfDisplayDay(new Date(INSTANT), 'UTC').toISOString()).toBe(
      '2026-10-15T00:00:00.000Z',
    );
  });

  it('interprets datetime-local input in the display zone, across a DST zone too', () => {
    expect(displayLocalToInstant('2026-10-16T01:39', 'Asia/Kolkata')?.toISOString()).toBe(
      '2026-10-15T20:09:00.000Z',
    );
    expect(displayLocalToInstant('2026-07-01T12:00', 'Europe/London')?.toISOString()).toBe(
      '2026-07-01T11:00:00.000Z',
    );
    expect(displayLocalToInstant('17/10/2026 14:00', 'Asia/Kolkata')).toBeNull();
    expect(instantToDisplayLocal(INSTANT, 'Asia/Kolkata')).toBe('2026-10-16T01:39');
  });
});
